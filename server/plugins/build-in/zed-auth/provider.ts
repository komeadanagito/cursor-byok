import type {
  JsonValue,
  NetworkEventStream,
  NetworkRequestInit,
  PluginContext,
} from "cursor-byok:plugin";
import type {
  LlmContentPart,
  LlmMessage,
  LlmRequest,
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError as ChatHttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import {
  HttpError as ResponsesHttpError,
  streamOpenAiResponses,
} from "cursor-byok:protocol/openai-responses";
import {
  extractModelMetadata,
  type ZedModelMetadata,
  zedModels,
  type ZedUpstreamProvider,
} from "./models.ts";
import {
  type AccountData,
  accountData,
  ensureLlmToken,
  quotaExhaustedPatch,
  RESOURCE_TYPE,
  ZED_CLOUD_BASE_URL,
  ZED_VERSION,
  ZED_VERSION_HEADER,
} from "./resources.ts";

export const COMPLETIONS_URL = `${ZED_CLOUD_BASE_URL}/completions`;
export const ANTHROPIC_REPLAY_KIND = "zed_anthropic";
export const GOOGLE_REPLAY_KIND = "zed_google";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readBody(lines: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];
  for await (const line of lines) collected.push(line);
  return collected.join("\n");
}

export class ZedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}: ${body}`);
  }
}

export function isTokenRejectedError(error: unknown): boolean {
  if (error instanceof ZedHttpError) {
    const lowerHeaders = Object.fromEntries(
      Object.entries(error.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return (
      error.status === 401 ||
      lowerHeaders["x-zed-expired-token"] !== undefined ||
      lowerHeaders["x-zed-outdated-token"] !== undefined
    );
  }
  if (error instanceof ResponsesHttpError || error instanceof ChatHttpError) {
    return error.status === 401;
  }
  return false;
}

export function isQuotaOrBillingError(error: unknown): boolean {
  if (
    error instanceof ZedHttpError ||
    error instanceof ResponsesHttpError ||
    error instanceof ChatHttpError
  ) {
    if (error.status === 402 || error.status === 429) return true;
    return isQuotaErrorText(error.body);
  }
  const message = error instanceof Error ? error.message : String(error);
  return isQuotaErrorText(message);
}

export function isQuotaErrorText(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("payment_required") ||
    lower.includes("payment required") ||
    lower.includes("spending_limit") ||
    lower.includes("spending limit") ||
    lower.includes("monthly_limit") ||
    lower.includes("insufficient_quota") ||
    lower.includes("quota_exceeded") ||
    lower.includes("usage_limit") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("upstream_http_429") ||
    lower.includes("too many requests") ||
    lower.includes("http 402") ||
    lower.includes("http 429")
  );
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

export function zedCompletionHeaders(llmToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${llmToken}`,
    "content-type": "application/json",
    [ZED_VERSION_HEADER]: ZED_VERSION,
    "x-zed-client-supports-status-messages": "true",
    "x-zed-client-supports-stream-ended-request-completion-status": "true",
  };
}

/**
 * Unwraps a single line from Zed's `/completions` NDJSON stream.
 * Returns `{ kind: "event", event }`, `{ kind: "ended" }`, or `{ kind: "ignore" }`.
 * Throws an `Error` if Zed emits a `{ status: { failed: ... } }` status line.
 */
export function unwrapZedStreamLine(
  rawLine: string,
): { kind: "event"; event: Record<string, unknown> } | { kind: "ended" } | { kind: "ignore" } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { kind: "ignore" };
  const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText) return { kind: "ignore" };
  if (jsonText === "[DONE]") return { kind: "ended" };

  let parsed: Record<string, unknown> | null;
  try {
    parsed = object(JSON.parse(jsonText));
  } catch {
    return { kind: "ignore" };
  }
  if (!parsed) return { kind: "ignore" };

  if ("status" in parsed) {
    const status = parsed.status;
    if (status === "stream_ended") {
      return { kind: "ended" };
    }
    const statusObj = object(status);
    const failed = object(statusObj?.failed);
    if (failed) {
      const code = text(failed.code) ?? "zed_stream_failed";
      const message = text(failed.message) ?? "Zed stream failed";
      const retryAfter = count(failed.retry_after);
      const suffix = retryAfter !== null ? ` (retry_after=${retryAfter})` : "";
      throw new Error(`${code}: ${message}${suffix}`);
    }
    return { kind: "ignore" };
  }

  const innerEvent = object(parsed.event);
  if (innerEvent) {
    return { kind: "event", event: innerEvent };
  }
  return { kind: "event", event: parsed };
}

/**
 * Adapts `PluginContext` so that existing SSE-based protocol helpers (`streamOpenAiResponses`,
 * `streamOpenAiChat`) wrap their outgoing request body into Zed's `CompletionBody` and receive
 * unwrapped `data: <event_json>` SSE lines from Zed's NDJSON stream.
 */
function createZedWrappedContext(
  context: PluginContext,
  provider: ZedUpstreamProvider,
  modelId: string,
  threadId: string | null,
): PluginContext {
  return {
    signal: context.signal,
    network: {
      fetch: context.network.fetch,
      stream: async (url: string, init?: NetworkRequestInit): Promise<NetworkEventStream> => {
        const providerRequest = init?.body ? JSON.parse(init.body) : {};
        const wrappedBody = JSON.stringify({
          ...(threadId ? { thread_id: threadId } : {}),
          prompt_id: crypto.randomUUID(),
          provider,
          model: modelId,
          provider_request: providerRequest,
        });
        const response = await context.network.stream(url, {
          ...init,
          body: wrappedBody,
        });
        if (response.status < 200 || response.status >= 300) {
          throw new ZedHttpError(response.status, await readBody(response.lines), response.headers);
        }
        async function* adaptLines(): AsyncGenerator<string> {
          for await (const line of response.lines) {
            const unwrapped = unwrapZedStreamLine(line);
            if (unwrapped.kind === "ignore") continue;
            if (unwrapped.kind === "ended") {
              yield "data: [DONE]";
              break;
            }
            yield `data: ${JSON.stringify(unwrapped.event)}`;
          }
        }
        return {
          status: response.status,
          headers: response.headers,
          lines: adaptLines(),
        };
      },
    },
  };
}

function anthropicContentBlocks(parts: LlmContentPart[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) {
        blocks.push({ type: "text", text: part.text });
      }
    } else if (part.type === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.dataBase64,
        },
      });
    }
  }
  return blocks;
}

export function buildAnthropicProviderRequest(
  modelId: string,
  metadata: ZedModelMetadata,
  request: LlmRequest,
): Record<string, unknown> {
  const rawMessages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> =
    [];
  let systemText = request.instructions || "";

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const extraSystem = msg.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (extraSystem) {
        systemText += (systemText ? "\n\n" : "") + extraSystem;
      }
      continue;
    }

    if (msg.role === "user") {
      const blocks = anthropicContentBlocks(msg.content);
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: " " });
      }
      rawMessages.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const replay = msg.replayState?.providerKind === ANTHROPIC_REPLAY_KIND
        ? object(msg.replayState.value)
        : null;
      const signature = text(replay?.signature);
      const redactedData = text(replay?.redactedData);

      if (msg.thinking && signature) {
        blocks.push({
          type: "thinking",
          thinking: msg.thinking,
          signature,
        });
      } else if (redactedData) {
        blocks.push({
          type: "redacted_thinking",
          data: redactedData,
        });
      }

      if (msg.text) {
        blocks.push({ type: "text", text: msg.text });
      }

      for (const call of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: object(call.arguments) ?? {},
        });
      }

      if (blocks.length > 0) {
        rawMessages.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "tool") {
      const resultBlock: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: msg.callId,
        is_error: msg.isError,
        content: msg.parts.length > 0 ? anthropicContentBlocks(msg.parts) : msg.content,
      };
      rawMessages.push({ role: "user", content: [resultBlock] });
    }
  }

  // Merge consecutive messages with the same role as required by the Anthropic Messages API.
  const messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> =
    [];
  for (const item of rawMessages) {
    if (item.content.length === 0) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === item.role) {
      prev.content.push(...item.content);
    } else {
      messages.push({ role: item.role, content: [...item.content] });
    }
  }

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: " " }] });
  }

  const maxTokens = request.maxOutputTokens !== null
    ? Math.min(request.maxOutputTokens, metadata.maxOutputTokens)
    : metadata.maxOutputTokens;

  const enableThinking = metadata.supportsThinking && request.reasoning.enabled;
  const effort = request.reasoning.effort !== null &&
      metadata.reasoningEfforts.includes(request.reasoning.effort)
    ? request.reasoning.effort
    : null;

  const providerRequest: Record<string, unknown> = {
    model: modelId,
    max_tokens: maxTokens,
    messages,
    temperature: 1.0,
    cache_control: { type: "ephemeral" },
  };

  if (systemText.trim()) {
    providerRequest.system = systemText.trim();
  }

  if (request.tools.length > 0) {
    providerRequest.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  if (enableThinking && effort !== null) {
    providerRequest.thinking = { type: "adaptive" };
    providerRequest.output_config = { effort };
  } else if (enableThinking) {
    const budget = Math.min(4_096, Math.max(1_024, Math.floor(maxTokens / 2)));
    if (maxTokens > budget) {
      providerRequest.thinking = { type: "enabled", budget_tokens: budget };
    }
  }

  if (request.latency === "fast" && metadata.supportsFastMode) {
    providerRequest.speed = "fast";
  }

  return providerRequest;
}

async function streamZedAnthropic(
  llmToken: string,
  modelId: string,
  metadata: ZedModelMetadata,
  request: LlmRequest,
  output: ProviderOutput,
  context: PluginContext,
): Promise<void> {
  const providerRequest = buildAnthropicProviderRequest(modelId, metadata, request);
  const body = JSON.stringify({
    ...(request.cacheKey ? { thread_id: request.cacheKey } : {}),
    prompt_id: crypto.randomUUID(),
    provider: "anthropic",
    model: modelId,
    provider_request: providerRequest,
  });

  const response = await context.network.stream(COMPLETIONS_URL, {
    method: "POST",
    headers: zedCompletionHeaders(llmToken),
    body,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ZedHttpError(response.status, await readBody(response.lines), response.headers);
  }

  let textOpen = false;
  let thinkingOpen = false;
  let signature = "";
  let redactedData = "";
  const openTools = new Map<number, { index: number; ended: boolean }>();
  let nextToolIndex = 0;
  let sawTool = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let stopReason: "stop" | "length" | "tool-use" = "stop";
  let doneEmitted = false;

  const closeText = () => {
    if (textOpen) {
      textOpen = false;
      output.emit({ type: "text-end" });
    }
  };
  const closeThinking = () => {
    if (thinkingOpen) {
      thinkingOpen = false;
      output.emit({ type: "thinking-end" });
    }
  };

  for await (const line of response.lines) {
    const unwrapped = unwrapZedStreamLine(line);
    if (unwrapped.kind === "ignore") continue;
    if (unwrapped.kind === "ended") break;

    const event = unwrapped.event;
    const eventType = text(event.type);

    switch (eventType) {
      case "message_start": {
        const message = object(event.message);
        const usage = object(message?.usage);
        if (usage) {
          inputTokens = count(usage.input_tokens) ?? inputTokens;
          outputTokens = count(usage.output_tokens) ?? outputTokens;
          cacheReadTokens = count(usage.cache_read_input_tokens) ?? cacheReadTokens;
          cacheWriteTokens = count(usage.cache_creation_input_tokens) ?? cacheWriteTokens;
        }
        break;
      }
      case "content_block_start": {
        const blockIndex = count(event.index) ?? 0;
        const block = object(event.content_block);
        const blockType = text(block?.type);
        if (blockType === "thinking") {
          closeText();
          if (!thinkingOpen) {
            thinkingOpen = true;
            output.emit({ type: "thinking-start" });
          }
          const initialThinking = text(block?.thinking);
          if (initialThinking) {
            output.emit({ type: "thinking-delta", text: initialThinking });
          }
          const initialSig = text(block?.signature);
          if (initialSig) signature += initialSig;
        } else if (blockType === "redacted_thinking") {
          const data = text(block?.data);
          if (data) redactedData = data;
        } else if (blockType === "text") {
          closeThinking();
          const initialText = text(block?.text);
          if (initialText) {
            if (!textOpen) {
              textOpen = true;
              output.emit({ type: "text-start" });
            }
            output.emit({ type: "text-delta", text: initialText });
          }
        } else if (blockType === "tool_use") {
          closeThinking();
          closeText();
          sawTool = true;
          const toolIdx = nextToolIndex++;
          const callId = text(block?.id) ?? `toolu_${Date.now()}_${toolIdx}`;
          const name = text(block?.name) ?? "tool";
          openTools.set(blockIndex, { index: toolIdx, ended: false });
          output.emit({
            type: "tool-call-start",
            index: toolIdx,
            callId,
            name,
          });
          const initialInput = object(block?.input);
          if (initialInput && Object.keys(initialInput).length > 0) {
            output.emit({
              type: "tool-call-arguments-delta",
              index: toolIdx,
              delta: JSON.stringify(initialInput),
            });
          }
        }
        break;
      }
      case "content_block_delta": {
        const blockIndex = count(event.index) ?? 0;
        const delta = object(event.delta);
        const deltaType = text(delta?.type);
        if (deltaType === "text_delta") {
          closeThinking();
          const chunk = text(delta?.text);
          if (chunk) {
            if (!textOpen) {
              textOpen = true;
              output.emit({ type: "text-start" });
            }
            output.emit({ type: "text-delta", text: chunk });
          }
        } else if (deltaType === "thinking_delta") {
          closeText();
          const chunk = text(delta?.thinking);
          if (chunk) {
            if (!thinkingOpen) {
              thinkingOpen = true;
              output.emit({ type: "thinking-start" });
            }
            output.emit({ type: "thinking-delta", text: chunk });
          }
        } else if (deltaType === "signature_delta") {
          const sig = text(delta?.signature);
          if (sig) signature += sig;
        } else if (deltaType === "input_json_delta") {
          const partial = text(delta?.partial_json);
          const tool = openTools.get(blockIndex);
          if (partial && tool) {
            output.emit({
              type: "tool-call-arguments-delta",
              index: tool.index,
              delta: partial,
            });
          }
        }
        break;
      }
      case "content_block_stop": {
        const blockIndex = count(event.index) ?? 0;
        const tool = openTools.get(blockIndex);
        if (tool && !tool.ended) {
          tool.ended = true;
          output.emit({ type: "tool-call-end", index: tool.index });
        } else {
          closeThinking();
          closeText();
        }
        break;
      }
      case "message_delta": {
        const delta = object(event.delta);
        const reason = text(delta?.stop_reason);
        if (reason === "tool_use") stopReason = "tool-use";
        else if (reason === "max_tokens") stopReason = "length";
        else if (reason) stopReason = sawTool ? "tool-use" : "stop";

        const usage = object(event.usage);
        if (usage) {
          inputTokens = count(usage.input_tokens) ?? inputTokens;
          outputTokens = count(usage.output_tokens) ?? outputTokens;
          cacheReadTokens = count(usage.cache_read_input_tokens) ?? cacheReadTokens;
          cacheWriteTokens = count(usage.cache_creation_input_tokens) ?? cacheWriteTokens;
        }
        break;
      }
      case "message_stop": {
        closeThinking();
        closeText();
        for (const tool of openTools.values()) {
          if (!tool.ended) {
            tool.ended = true;
            output.emit({ type: "tool-call-end", index: tool.index });
          }
        }
        if (signature || redactedData) {
          output.emit({
            type: "replay-state",
            providerKind: ANTHROPIC_REPLAY_KIND,
            value: {
              ...(signature ? { signature } : {}),
              ...(redactedData ? { redactedData } : {}),
            },
          });
        }
        if (inputTokens !== null || outputTokens !== null) {
          const contextInputTokens = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
          const totalTokens = contextInputTokens + (outputTokens ?? 0);
          output.emit({
            type: "usage",
            usage: {
              inputTokens,
              contextInputTokens: contextInputTokens > 0 ? contextInputTokens : inputTokens,
              outputTokens,
              totalTokens: totalTokens > 0 ? totalTokens : null,
              cacheReadTokens,
              cacheWriteTokens,
              reasoningTokens: null,
            },
          });
        }
        output.emit({ type: "done", reason: sawTool ? "tool-use" : stopReason });
        doneEmitted = true;
        break;
      }
      case "error": {
        const errObj = object(event.error);
        const errMsg = text(errObj?.message) ?? JSON.stringify(event);
        throw new Error(`Anthropic error: ${errMsg}`);
      }
    }
  }

  if (!doneEmitted) {
    closeThinking();
    closeText();
    for (const tool of openTools.values()) {
      if (!tool.ended) {
        tool.ended = true;
        output.emit({ type: "tool-call-end", index: tool.index });
      }
    }
    if (signature || redactedData) {
      output.emit({
        type: "replay-state",
        providerKind: ANTHROPIC_REPLAY_KIND,
        value: {
          ...(signature ? { signature } : {}),
          ...(redactedData ? { redactedData } : {}),
        },
      });
    }
    if (inputTokens !== null || outputTokens !== null) {
      const contextInputTokens = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
      const totalTokens = contextInputTokens + (outputTokens ?? 0);
      output.emit({
        type: "usage",
        usage: {
          inputTokens,
          contextInputTokens: contextInputTokens > 0 ? contextInputTokens : inputTokens,
          outputTokens,
          totalTokens: totalTokens > 0 ? totalTokens : null,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens: null,
        },
      });
    }
    output.emit({ type: "done", reason: sawTool ? "tool-use" : stopReason });
  }
}

function buildGoogleProviderRequest(
  modelId: string,
  metadata: ZedModelMetadata,
  request: LlmRequest,
): Record<string, unknown> {
  const rawContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  let systemText = request.instructions || "";

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const txt = msg.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (txt) systemText += (systemText ? "\n\n" : "") + txt;
      continue;
    }
    if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.text) parts.push({ text: msg.text });
      const replay = msg.replayState?.providerKind === GOOGLE_REPLAY_KIND
        ? object(msg.replayState.value)
        : null;
      const thoughtSignature = text(replay?.thoughtSignature);
      for (const call of msg.toolCalls) {
        parts.push({
          functionCall: {
            id: call.callId,
            name: call.name,
            args: object(call.arguments) ?? {},
          },
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      if (parts.length > 0) rawContents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      rawContents.push({
        role: "user",
        parts: [{
          functionResponse: {
            id: msg.callId,
            name: msg.name || "function",
            response: { result: msg.content },
          },
        }],
      });
    } else if (msg.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      for (const p of msg.content) {
        if (p.type === "text") {
          if (p.text) parts.push({ text: p.text });
        } else if (p.type === "image") {
          parts.push({
            inlineData: {
              mimeType: p.mediaType,
              data: p.dataBase64,
            },
          });
        }
      }
      if (parts.length === 0) parts.push({ text: " " });
      rawContents.push({ role: "user", parts });
    }
  }

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const item of rawContents) {
    if (item.parts.length === 0) continue;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === item.role) {
      prev.parts.push(...item.parts);
    } else {
      contents.push(item);
    }
  }
  if (contents.length === 0 || contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: " " }] });
  }

  const providerRequest: Record<string, unknown> = {
    model: { model_id: modelId },
    contents,
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens ?? metadata.maxOutputTokens,
    },
  };
  if (systemText.trim()) {
    providerRequest.systemInstruction = {
      role: "user",
      parts: [{ text: systemText.trim() }],
    };
  }
  if (request.tools.length > 0) {
    providerRequest.tools = [{
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: t.parameters,
      })),
    }];
  }
  return providerRequest;
}

async function streamZedGoogle(
  llmToken: string,
  modelId: string,
  metadata: ZedModelMetadata,
  request: LlmRequest,
  output: ProviderOutput,
  context: PluginContext,
): Promise<void> {
  const providerRequest = buildGoogleProviderRequest(modelId, metadata, request);
  const body = JSON.stringify({
    ...(request.cacheKey ? { thread_id: request.cacheKey } : {}),
    prompt_id: crypto.randomUUID(),
    provider: "google",
    model: modelId,
    provider_request: providerRequest,
  });

  const response = await context.network.stream(COMPLETIONS_URL, {
    method: "POST",
    headers: zedCompletionHeaders(llmToken),
    body,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ZedHttpError(response.status, await readBody(response.lines), response.headers);
  }

  let textOpen = false;
  let thinkingOpen = false;
  let sawTool = false;
  let toolIndex = 0;
  let lastThoughtSignature: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let doneEmitted = false;

  const closeText = () => {
    if (textOpen) {
      textOpen = false;
      output.emit({ type: "text-end" });
    }
  };
  const closeThinking = () => {
    if (thinkingOpen) {
      thinkingOpen = false;
      output.emit({ type: "thinking-end" });
    }
  };

  for await (const line of response.lines) {
    const unwrapped = unwrapZedStreamLine(line);
    if (unwrapped.kind === "ignore") continue;
    if (unwrapped.kind === "ended") break;

    const event = unwrapped.event;
    const usage = object(event.usageMetadata);
    if (usage) {
      inputTokens = count(usage.promptTokenCount) ?? inputTokens;
      outputTokens = count(usage.candidatesTokenCount) ?? outputTokens;
      totalTokens = count(usage.totalTokenCount) ?? totalTokens;
      cacheReadTokens = count(usage.cachedContentTokenCount) ?? cacheReadTokens;
    }

    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    const candidate = object(candidates[0]);
    const content = object(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];

    for (const rawPart of parts) {
      const part = object(rawPart);
      if (!part) continue;
      const sig = text(part.thoughtSignature);
      if (sig) lastThoughtSignature = sig;

      const isThought = part.thought === true;
      const partText = text(part.text);
      if (isThought && partText) {
        closeText();
        if (!thinkingOpen) {
          thinkingOpen = true;
          output.emit({ type: "thinking-start" });
        }
        output.emit({ type: "thinking-delta", text: partText });
      } else if (partText) {
        closeThinking();
        if (!textOpen) {
          textOpen = true;
          output.emit({ type: "text-start" });
        }
        output.emit({ type: "text-delta", text: partText });
      }

      const fnCall = object(part.functionCall);
      if (fnCall) {
        closeThinking();
        closeText();
        sawTool = true;
        const idx = toolIndex++;
        const callId = text(fnCall.id) ?? `call_${Date.now()}_${idx}`;
        const name = text(fnCall.name) ?? "function";
        output.emit({ type: "tool-call-start", index: idx, callId, name });
        const argsStr = typeof fnCall.args === "string"
          ? fnCall.args
          : JSON.stringify(fnCall.args ?? {});
        output.emit({ type: "tool-call-arguments-delta", index: idx, delta: argsStr });
        output.emit({ type: "tool-call-end", index: idx });
      }
    }

    const finishReason = text(candidate?.finishReason);
    if (finishReason) {
      closeThinking();
      closeText();
      if (lastThoughtSignature) {
        output.emit({
          type: "replay-state",
          providerKind: GOOGLE_REPLAY_KIND,
          value: { thoughtSignature: lastThoughtSignature },
        });
        lastThoughtSignature = null;
      }
      if (inputTokens !== null || outputTokens !== null) {
        output.emit({
          type: "usage",
          usage: {
            inputTokens,
            contextInputTokens: inputTokens,
            outputTokens,
            totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
            cacheReadTokens,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
        });
      }
      const reason = sawTool ? "tool-use" : finishReason === "MAX_TOKENS" ? "length" : "stop";
      output.emit({ type: "done", reason });
      doneEmitted = true;
      break;
    }
  }

  if (!doneEmitted) {
    closeThinking();
    closeText();
    if (lastThoughtSignature) {
      output.emit({
        type: "replay-state",
        providerKind: GOOGLE_REPLAY_KIND,
        value: { thoughtSignature: lastThoughtSignature },
      });
    }
    if (inputTokens !== null || outputTokens !== null) {
      output.emit({
        type: "usage",
        usage: {
          inputTokens,
          contextInputTokens: inputTokens,
          outputTokens,
          totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
          cacheReadTokens,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
      });
    }
    output.emit({ type: "done", reason: sawTool ? "tool-use" : "stop" });
  }
}

async function dispatchZedCompletion(
  llmToken: string,
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<void> {
  const metadata = extractModelMetadata(input.model);
  const modelId = input.model.id;

  if (metadata.provider === "anthropic") {
    await streamZedAnthropic(llmToken, modelId, metadata, input.request, output, context);
    return;
  }

  if (metadata.provider === "google") {
    await streamZedGoogle(llmToken, modelId, metadata, input.request, output, context);
    return;
  }

  if (metadata.provider === "x_ai") {
    const wrappedContext = createZedWrappedContext(
      context,
      "x_ai",
      modelId,
      input.request.cacheKey,
    );
    await streamOpenAiChat(
      {
        url: COMPLETIONS_URL,
        model: modelId,
        request: input.request,
        headers: zedCompletionHeaders(llmToken),
        maxTokensField: "max_completion_tokens",
        includeStreamUsage: true,
        includeServiceTier: false,
        includePromptCacheKey: false,
        extraBody: {
          parallel_tool_calls: metadata.supportsParallelToolCalls,
        },
      },
      output,
      wrappedContext,
    );
    return;
  }

  // Default: `open_ai` (OpenAI Responses API via Zed Cloud)
  const effort = input.request.reasoning.effort !== null &&
      metadata.reasoningEfforts.includes(input.request.reasoning.effort)
    ? input.request.reasoning.effort
    : null;
  const wrappedContext = createZedWrappedContext(
    context,
    "open_ai",
    modelId,
    input.request.cacheKey,
  );
  await streamOpenAiResponses(
    {
      url: COMPLETIONS_URL,
      model: modelId,
      request: {
        ...input.request,
        reasoning: {
          enabled: metadata.supportsThinking && input.request.reasoning.enabled,
          effort,
        },
      },
      headers: zedCompletionHeaders(llmToken),
      extraBody: {
        parallel_tool_calls: metadata.supportsParallelToolCalls,
        store: false,
      },
    },
    output,
    wrappedContext,
  );
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return {
      status: "request-error",
      message: "Add a Zed account before calling Zed Cloud models",
    };
  }

  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }

  let llmToken: string;
  let patchData: AccountData | null = null;
  try {
    const ensured = await ensureLlmToken(data, context.network);
    llmToken = ensured.llmToken;
    if (ensured.updatedData) {
      data = ensured.updatedData;
      patchData = ensured.updatedData;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401")) {
      return invalidResult(message, "Zed authorization expired; please sign in again");
    }
    if (isQuotaOrBillingError(error)) {
      return {
        status: "resource-error",
        message,
        patch: quotaExhaustedPatch(data, message),
      };
    }
    return { status: "request-error", message };
  }

  let emittedAnyEvent = false;
  const trackedOutput: ProviderOutput = {
    emit(event) {
      emittedAnyEvent = true;
      output.emit(event);
    },
  };

  try {
    await dispatchZedCompletion(llmToken, input, trackedOutput, context);
    return patchData
      ? {
        status: "completed",
        patch: { privateData: patchData as unknown as JsonValue, state: { status: "ready" } },
      }
      : { status: "completed" };
  } catch (error) {
    if (!emittedAnyEvent && isTokenRejectedError(error) && data.userId !== "jwt") {
      try {
        const refreshed = await ensureLlmToken(data, context.network, true);
        if (refreshed.updatedData) {
          data = refreshed.updatedData;
          patchData = refreshed.updatedData;
        }
        await dispatchZedCompletion(refreshed.llmToken, input, trackedOutput, context);
        return {
          status: "completed",
          ...(patchData
            ? {
              patch: {
                privateData: patchData as unknown as JsonValue,
                state: { status: "ready" },
              },
            }
            : {}),
        };
      } catch (retryError) {
        error = retryError;
      }
    }

    if (isTokenRejectedError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return invalidResult(message, "Zed authorization expired; please sign in again");
    }

    if (isQuotaOrBillingError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "resource-error",
        message,
        patch: quotaExhaustedPatch(data, message),
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "request-error",
      message,
      ...(patchData
        ? {
          patch: {
            privateData: patchData as unknown as JsonValue,
            state: { status: "ready" },
          },
        }
        : {}),
    };
  }
}

export const zedProvider: ProviderSupport = {
  id: "zed",
  displayName: {
    "en-US": "Zed Cloud (Student / Pro)",
    "zh-CN": "Zed Cloud（学生认证 / Pro）",
  },
  description: {
    "en-US":
      "Access Claude, GPT, Gemini, and Grok models through your Zed Student ($10/mo) or Zed Pro subscription.",
    "zh-CN":
      "通过 Zed 学生认证（$10/月）或 Zed Pro 订阅使用 Claude、GPT、Gemini 与 Grok 等托管模型。",
  },
  providerType: "anthropic",
  resourceType: RESOURCE_TYPE,
  models: zedModels,
  invoke,
};
