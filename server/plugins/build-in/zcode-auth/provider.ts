import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  LlmRequest,
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { zcodeRequestHeaders } from "./headers.ts";
import { zcodeChatUrl, zcodeModels } from "./models.ts";
import { credentialData, RESOURCE_TYPE, type ZCodeCredential } from "./resources.ts";

const SUPPORTED_REASONING_EFFORTS = new Set([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);

function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("insufficient_quota") ||
    lower.includes("quota_exceeded") ||
    lower.includes("usage_limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429");
}

function quotaPatch(message: string) {
  return {
    state: {
      status: "cooling" as const,
      retryAtMs: Date.now() + 60_000,
      message,
    },
  };
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

export function zcodeRequestBody(request: LlmRequest): Record<string, JsonValue> {
  // Plugin models do not receive a per-model reasoning switch from the host.
  // Keep the official ZCode coding behaviour: thinking and preserved reasoning
  // are enabled, and the coding plan's own default effort applies when unset.
  const body: Record<string, JsonValue> = {
    thinking: {
      type: "enabled",
      clear_thinking: false,
    },
  };
  if (request.reasoning.effort !== null &&
    SUPPORTED_REASONING_EFFORTS.has(request.reasoning.effort)) {
    body.reasoning_effort = request.reasoning.effort;
  }
  if (request.tools.length > 0) body.tool_stream = true;
  return body;
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a ZCode credential before calling ZCode" };
  }
  let data: ZCodeCredential;
  try {
    data = credentialData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }
  try {
    // `cacheKey` is the host conversation identity. ZCode rotates
    // `X-Session-Id` per conversation, so scope the session to it instead of
    // reusing the credential's captured id for every call.
    const session = input.request.cacheKey ?? undefined;
    await streamOpenAiChat(
      {
        url: zcodeChatUrl(data.baseUrl),
        model: input.model.id,
        request: {
          ...input.request,
          reasoning: { enabled: false, effort: null },
          latency: "standard",
          cacheKey: null,
        },
        headers: zcodeRequestHeaders(
          { authorization: `Bearer ${data.apiKey}` },
          data,
          session,
        ),
        maxTokensField: "max_tokens",
        includeStreamUsage: false,
        includeServiceTier: false,
        includePromptCacheKey: false,
        extraBody: zcodeRequestBody(input.request),
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 403) {
        const message = `ZCode API key was rejected (HTTP ${error.status})`;
        return invalidResult(message, message);
      }
      if (error.status === 429 || isQuotaError(error.body)) {
        return {
          status: "resource-error",
          message: error.message,
          patch: quotaPatch(error.message),
        };
      }
      return { status: "request-error", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) {
      return { status: "resource-error", message, patch: quotaPatch(message) };
    }
    return { status: "request-error", message };
  }
}

export const zcodeProvider: ProviderSupport = {
  id: "zcode",
  displayName: {
    "en-US": "ZCode (Z.AI Coding Plan)",
    "zh-CN": "ZCode\uff08\u667a\u8c31 Coding Plan\uff09",
  },
  description: {
    "en-US":
      "Uses the official ZCode identity, preserved thinking, and streamed tool calls on Z.AI coding-plan endpoints.",
    "zh-CN":
      "\u5728\u667a\u8c31 Coding Plan \u7aef\u70b9\u4e0a\u4f7f\u7528\u5b98\u65b9 ZCode \u8eab\u4efd\u3001\u4fdd\u7559\u601d\u8003\u548c\u6d41\u5f0f\u5de5\u5177\u8c03\u7528\u3002",
  },
  providerType: "zai",
  resourceType: RESOURCE_TYPE,
  models: zcodeModels,
  invoke,
};
