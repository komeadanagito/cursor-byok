//! WorkBuddy CN 模型调用：模型网关 /v2/chat/completions（OpenAI 兼容 SSE）。
import type { PluginContext } from "cursor-byok:plugin";
import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { workbuddyGatewayHeaders } from "./headers.ts";
import { chatUrl, workbuddyModels } from "./models.ts";
import { type AccountData, accountData, RESOURCE_TYPE } from "./resources.ts";

function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("insufficient_quota") || lower.includes("quota_exceeded") ||
    lower.includes("usage_limit") || lower.includes("rate limit") ||
    lower.includes("too many requests") || lower.includes("429");
}

function coolingPatch(message: string, retryMs = 60_000) {
  return {
    state: {
      status: "cooling" as const,
      retryAtMs: Date.now() + retryMs,
      message,
    },
  };
}

function invalidResult(message: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message } },
  };
}

/** 网关识别官方客户端还依赖一组身份头；鉴权头单独叠加。 */
function invocationHeaders(data: AccountData): Record<string, string> {
  const headers = workbuddyGatewayHeaders(data.gatewayBase);
  headers["content-type"] = "application/json";
  headers.authorization = `Bearer ${data.accessToken}`;
  return headers;
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "请先添加 WorkBuddy CN 凭证" };
  }
  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message);
  }
  try {
    await streamOpenAiChat(
      {
        url: chatUrl(data.gatewayBase),
        model: input.model.id,
        request: input.request,
        headers: invocationHeaders(data),
        maxTokensField: "max_tokens",
        includeStreamUsage: true,
        includeServiceTier: false,
        includePromptCacheKey: false,
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 403) {
        const message = `WorkBuddy 凭证被拒绝（HTTP ${error.status}）`;
        return invalidResult(message);
      }
      if (error.status === 429 || isQuotaError(error.body)) {
        return {
          status: "resource-error",
          message: error.message,
          patch: coolingPatch(error.message),
        };
      }
      return { status: "request-error", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) {
      return { status: "resource-error", message, patch: coolingPatch(message) };
    }
    return { status: "request-error", message };
  }
}

export const workbuddyProvider: ProviderSupport = {
  id: "workbuddy-cn",
  displayName: {
    "en-US": "WorkBuddy CN",
    "zh-CN": "WorkBuddy CN",
  },
  description: {
    "en-US": "Uses the WorkBuddy model gateway (OpenAI-compatible) with your WorkBuddy account.",
    "zh-CN": "使用 WorkBuddy 账号，通过 OpenAI 兼容的模型网关进行调用。",
  },
  providerType: "workbuddy",
  resourceType: RESOURCE_TYPE,
  models: workbuddyModels,
  invoke,
};
