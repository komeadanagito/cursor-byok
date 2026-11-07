import type { LlmRequest } from "cursor-byok:provider";
import type { ResourceImportFile, ResourceSnapshot } from "cursor-byok:resource";
import { zcodeIdentityHeaders, zcodeRequestHeaders } from "./headers.ts";
import { parseModelsResponse, zcodeChatUrl } from "./models.ts";
import { zcodeProvider, zcodeRequestBody } from "./provider.ts";
import {
  credentialData,
  credentialDraft,
  normalizeBaseUrl,
  parseCredentialFiles,
  presentCredential,
  type ZCodeCredential,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

function credential(): ZCodeCredential {
  return {
    apiKey: "test-key-123456789",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    displayName: "Test Coding Plan",
    appVersion: "3.10.2",
    sourceTitle: "electron",
    aiSdkVersion: null,
    nodeMajor: null,
    osVersion: null,
    sessionId: "session-stable",
    releaseChannel: "production",
  };
}

function request(): LlmRequest {
  return {
    instructions: "You are a coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
    reasoning: { enabled: true, effort: "high" },
    latency: "fast",
    maxOutputTokens: 8_192,
    cacheKey: "conversation-1",
  };
}

function snapshot(data: ZCodeCredential): ResourceSnapshot {
  return {
    id: "resource-1",
    type: "zcode-credential",
    key: "zcode:test",
    privateData: data as never,
    state: { status: "ready" },
  };
}


Deno.test("ZCode headers mirror the official client identity and request IDs", () => {
  const data = credential();
  const first = zcodeIdentityHeaders(data);
  const second = zcodeIdentityHeaders(data);
  assert(first["User-Agent"].startsWith("ZCode/3.10.2 ai-sdk/provider-utils/4.0.39"));
  assertEquals(first["HTTP-Referer"], "https://zcode.z.ai");
  assertEquals(first["X-Title"], "Z Code@electron");
  assertEquals(first["X-ZCode-Agent"], "glm");
  assertEquals(first["X-ZCode-Session-Type"], "main");
  assertEquals(first["X-ZCode-App-Version"], "3.10.2");
  assertEquals(first["X-Session-Id"], "session-stable");
  assert(first["X-Query-Id"] !== second["X-Query-Id"]);
  assert(first["X-Request-Id"] !== second["X-Request-Id"]);
  assert(first["X-ZCode-Trace-Id"] !== second["X-ZCode-Trace-Id"]);
  const headers = zcodeRequestHeaders({
    authorization: "Bearer test-key-123456789",
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
  }, data);
  assertEquals(headers.authorization, "Bearer test-key-123456789");
  assertEquals(headers["X-ZCode-Agent"], "glm");
  assert(!Object.keys(headers).some((key) => key.toLowerCase().startsWith("x-stainless-")));
});

Deno.test("os version comes from the host release, not the Deno user agent", () => {
  const live = zcodeIdentityHeaders(credential())["X-Os-Version"];
  // Deno's navigator.userAgent is "Deno/<ver>" and has no OS version in it, so
  // the release probe must be what fills this in. A real client never sends
  // "unknown" on a supported platform.
  assert(live.length > 0, "X-Os-Version must not be empty");
  assertEquals(live, Deno.osRelease());

  const captured = { ...credential(), osVersion: "15.1.1" };
  assertEquals(zcodeIdentityHeaders(captured)["X-Os-Version"], "15.1.1");
});

Deno.test("captured runtime versions override the built-in defaults", () => {
  const headers = zcodeIdentityHeaders({
    ...credential(),
    appVersion: "3.11.0",
    aiSdkVersion: "4.0.27",
    nodeMajor: "20",
    sourceTitle: "cli",
  });
  assert(headers["User-Agent"].startsWith("ZCode/3.11.0 ai-sdk/provider-utils/4.0.27 runtime/node.js/20"));
  assertEquals(headers["X-Title"], "Z Code@cli");
  assertEquals(headers["X-ZCode-App-Version"], "3.11.0");
});

Deno.test("session id rotates per conversation and keeps the captured id otherwise", () => {
  const data = credential();
  assertEquals(zcodeIdentityHeaders(data)["X-Session-Id"], "session-stable");
  assertEquals(
    zcodeIdentityHeaders(data, "677d8593-a860-45bf-b1a0-74ec55405956")["X-Session-Id"],
    "677d8593-a860-45bf-b1a0-74ec55405956",
  );
});

Deno.test("base URLs normalize Claude Code and chat-completion forms", () => {
  assertEquals(normalizeBaseUrl(), "https://api.z.ai/api/coding/paas/v4");
  assertEquals(
    normalizeBaseUrl("https://api.z.ai/api/anthropic"),
    "https://api.z.ai/api/coding/paas/v4",
  );
  assertEquals(
    normalizeBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"),
    "https://open.bigmodel.cn/api/coding/paas/v4",
  );
  assertEquals(
    zcodeChatUrl("https://api.z.ai/api/coding/paas/v4"),
    "https://api.z.ai/api/coding/paas/v4/chat/completions",
  );
  let rejected = false;
  try {
    normalizeBaseUrl("https://example.com/v1");
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test("credential import accepts JSON, env, and raw API keys without leaking secrets", async () => {
  const files: ResourceImportFile[] = [
    {
      name: "zcode.json",
      content: JSON.stringify({
        apiKey: "json-key-123456",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        displayName: "Z.AI Coding",
        appVersion: "3.10.2",
        sourceTitle: "cli",
      }),
    },
    {
      name: "zcode.env",
      content:
        "ZCODE_API_KEY=env-key-123456\nZCODE_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4\n",
    },
    { name: "api.key", content: "raw-key-123456" },
    { name: "broken.json", content: "{not json" },
  ];
  const parsed = await parseCredentialFiles(files);
  assertEquals(parsed.credentials.length, 3);
  assertEquals(parsed.warnings.length, 1);
  const draft = await credentialDraft(parsed.credentials[0]);
  assert(String(draft.key).startsWith("zcode:"));
  // privateData is the secret store: the key must live there and only there.
  assert(JSON.stringify(draft.privateData).includes("json-key-123456"));
  const view = presentCredential(snapshot(draft.privateData as never));
  assertEquals(view.displayName, "Z.AI Coding");
  assert(!JSON.stringify(view).includes("json-key-123456"));
  const data = credentialData(snapshot(draft.privateData as never));
  assertEquals(data.sourceTitle, "cli");
});

Deno.test("model discovery parses OpenAI-compatible lists", () => {
  const models = parseModelsResponse({
    data: [
      { id: "glm-5.3", display_name: "GLM-5.3", max_output_tokens: 131072 },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", supports_vision: true },
      { id: "glm-5.3" },
    ],
  });
  assertEquals(models.map((model) => model.id), ["glm-5.3", "glm-5.3-flash"]);
  assertEquals(models[0].maxOutputTokens, 131072);
  assertEquals(models[1].capabilities, { images: true });
});

Deno.test("request body preserves thinking and streams tool calls", () => {
  assertEquals(zcodeRequestBody(request()), {
    thinking: { type: "enabled", clear_thinking: false },
    reasoning_effort: "high",
    tool_stream: true,
  });
  const defaults = request();
  defaults.reasoning = { enabled: false, effort: null };
  defaults.tools = [];
  assertEquals(zcodeRequestBody(defaults), {
    thinking: { type: "enabled", clear_thinking: false },
  });
});


Deno.test("provider injects identity headers and coding-plan body fields", async () => {
  let capturedUrl = "";
  let capturedInit: { headers?: Record<string, string>; body?: string } | undefined;
  const data = credential();
  const context = {
    network: {
      fetch: () => Promise.reject(new Error("fetch was not expected")),
      stream: (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        capturedUrl = url;
        capturedInit = init;
        return Promise.resolve({
          status: 200,
          headers: {},
          lines: (async function* () {
            yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}';
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
            yield "data: [DONE]";
          })(),
        });
      },
    },
    signal: new AbortController().signal,
  };
  const events: unknown[] = [];
  const result = await zcodeProvider.invoke(
    {
      model: {
        id: "glm-5.3",
        displayName: "GLM-5.3",
        maxOutputTokens: 131072,
        capabilities: { images: false },
      },
      resource: snapshot(data),
      request: request(),
    },
    { emit: (event: unknown) => events.push(event) },
    context as never,
  );
  assertEquals(result, { status: "completed" });
  assertEquals(capturedUrl, "https://api.z.ai/api/coding/paas/v4/chat/completions");
  assertEquals(capturedInit?.headers?.authorization, "Bearer test-key-123456789");
  assert(capturedInit?.headers?.["User-Agent"].startsWith("ZCode/3.10.2"));
  assertEquals(capturedInit?.headers?.["X-ZCode-Agent"], "glm");
  const body = JSON.parse(capturedInit?.body ?? "{}");
  assertEquals(body.model, "glm-5.3");
  assertEquals(body.max_tokens, 8192);
  assert(body.max_completion_tokens === undefined);
  assert(body.stream_options === undefined);
  assert(body.prompt_cache_key === undefined);
  assertEquals(body.thinking, { type: "enabled", clear_thinking: false });
  assertEquals(body.reasoning_effort, "high");
  assertEquals(body.tool_stream, true);
  assert(events.some((event) =>
    (event as { type?: string }).type === "text-delta"
  ));
});
