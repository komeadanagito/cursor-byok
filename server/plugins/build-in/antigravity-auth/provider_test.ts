import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityProvider, isQuotaError } from "./provider.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-4-argon-medium",
        displayName: "Gemini 4 Argon Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-4-argon-medium");
  assert(!("sessionId" in body), "unsupported sessionId field was sent");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("provider replays tool calls with callId so Anthropic tool_use blocks keep their id", async () => {
  let requestBody = "";

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "claude-sonnet-5-5-medium",
        displayName: "Claude Sonnet 5.5 (Medium)",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: {
        ...request(),
        messages: [
          { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
          {
            role: "assistant",
            text: "Checking.",
            thinking: "",
            replayState: null,
            toolCalls: [{
              index: 0,
              callId: "call_42",
              name: "get_weather",
              arguments: { city: "Paris" },
            }],
          },
          {
            role: "tool",
            callId: "call_42",
            name: "get_weather",
            content: "sunny",
            isError: false,
            parts: [],
          },
        ],
      },
    },
    { emit: () => {} },
    context({
      stream: (_url, init) => {
        requestBody = init?.body ?? "";
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"It is sunny."}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  const body = JSON.parse(requestBody) as {
    request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  };
  const functionCall = body.request.contents[1].parts[1] as {
    functionCall: { id: string; name: string };
  };
  assertEquals(functionCall.functionCall.id, "call_42");
  const functionResponse = body.request.contents[2].parts[0] as {
    functionResponse: { id: string; name: string };
  };
  assertEquals(functionResponse.functionResponse.id, "call_42");
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});

Deno.test("provider tags emitted thoughtSignature with modelFamily and skips incompatible cross-model signatures on replay", async () => {
  const emitted: Array<Record<string, unknown>> = [];

  // 1. Claude turn emits replay-state tagged with modelFamily: "claude"
  await antigravityProvider.invoke(
    {
      model: {
        id: "claude-sonnet-5-5-medium",
        displayName: "Claude Sonnet 5.5 (Medium)",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => emitted.push(event as unknown as Record<string, unknown>) },
    context({
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"claude_sig_123"}]},"finishReason":"STOP"}]}}',
        ]),
      }),
    }),
  );

  const replayEvent = emitted.find((e) => e.type === "replay-state") as {
    type: string;
    providerKind: string;
    value: { thoughtSignature?: string; modelFamily?: string };
  } | undefined;
  assert(replayEvent !== undefined);
  assertEquals(replayEvent.providerKind, "antigravity");
  assertEquals(replayEvent.value, {
    thoughtSignature: "claude_sig_123",
    modelFamily: "claude",
  });

  // 2. Switching to Gemini 4 Hydrogen in the same conversation must NOT send Claude's signature or legacy untagged signatures,
  //    while a matching gemini-4 signature MUST be preserved.
  let capturedBody = "";
  await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-4-hydrogen-high",
        displayName: "Gemini 4 Hydrogen (High)",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: {
        ...request(),
        messages: [
          { role: "user", content: [{ type: "text", text: "turn 1" }] },
          {
            role: "assistant",
            text: "",
            thinking: "",
            replayState: {
              providerKind: "antigravity",
              value: { thoughtSignature: "claude_sig_123", modelFamily: "claude" },
            },
            toolCalls: [{ index: 0, callId: "c1", name: "ping", arguments: {} }],
          },
          { role: "tool", callId: "c1", name: "ping", content: "ok", isError: false, parts: [] },
          {
            role: "assistant",
            text: "",
            thinking: "",
            replayState: {
              providerKind: "antigravity",
              value: { thoughtSignature: "legacy_untagged_sig" },
            },
            toolCalls: [{ index: 0, callId: "c2", name: "ping", arguments: {} }],
          },
          { role: "tool", callId: "c2", name: "ping", content: "ok", isError: false, parts: [] },
          {
            role: "assistant",
            text: "",
            thinking: "",
            replayState: {
              providerKind: "antigravity",
              value: { thoughtSignature: "gemini4_sig_456", modelFamily: "gemini-4" },
            },
            toolCalls: [{ index: 0, callId: "c3", name: "ping", arguments: {} }],
          },
          { role: "tool", callId: "c3", name: "ping", content: "ok", isError: false, parts: [] },
        ],
      },
    },
    { emit: () => {} },
    context({
      stream: (_url, init) => {
        capturedBody = init?.body ?? "";
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}',
          ]),
        };
      },
    }),
  );

  const body = JSON.parse(capturedBody) as {
    request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  };
  const modelTurns = body.request.contents.filter((c) => c.role === "model");
  assertEquals(modelTurns[0].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assertEquals(modelTurns[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assertEquals(modelTurns[2].parts[0].thoughtSignature, "gemini4_sig_456");
});
