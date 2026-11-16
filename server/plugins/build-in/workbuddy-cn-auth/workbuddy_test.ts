import type { ResourceSnapshot } from "cursor-byok:resource";
import { CLIENT_HEADERS } from "./config.ts";
import { authorizedGatewayHeaders, workbuddyGatewayHeaders } from "./headers.ts";
import { chatUrl, fallbackModels, mergeModels, modelsUrl, parseModelsResponse } from "./models.ts";
import {
  accountData,
  credentialDraft,
  isJwtExpired,
  parseCredentialFiles,
  RESOURCE_TYPE,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message ? message + ": " : ""}expected ${right}, received ${left}`);
  }
}

Deno.test("models discovery parses OpenAI-style model list and deduplicates", () => {
  const models = parseModelsResponse({
    data: [
      { id: "hunyuan", name: "混元" },
      { id: "hunyuan", name: "duplicate" },
      { id: "glm-5.3", max_output_tokens: 8192, supports_vision: true },
    ],
  });
  assertEquals(models.length, 2);
  assertEquals(models[0].id, "hunyuan");
  assertEquals(models[1].maxOutputTokens, 8192);
  assertEquals(models[1].capabilities?.images, true);
});

Deno.test("model endpoints join gateway base without double slashes", () => {
  assertEquals(modelsUrl("https://copilot.tencent.com/"), "https://copilot.tencent.com/v1/models");
  assertEquals(
    chatUrl("https://copilot.tencent.com"),
    "https://copilot.tencent.com/v2/chat/completions",
  );
});

Deno.test("gateway headers carry fresh conversation ids on every call", () => {
  const first = workbuddyGatewayHeaders("https://copilot.tencent.com");
  const second = workbuddyGatewayHeaders("https://copilot.tencent.com");
  assert(first["x-conversation-id"] !== second["x-conversation-id"], "conversation id must rotate");
  assertEquals(first["x-ide-type"], "WorkBuddy");
  assertEquals(first.referer, "https://copilot.tencent.com/");
});

Deno.test("authorized headers include Bearer token", () => {
  const headers = authorizedGatewayHeaders("tok-123", "https://copilot.tencent.com");
  assertEquals(headers.authorization, "Bearer tok-123");
  assertEquals(headers.accept, "application/json");
});

Deno.test("JWT expiry uses exp claim with buffer", () => {
  const expired = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 }));
  const future = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  assert(isJwtExpired(`h.${expired}.s`), "past exp must be expired");
  assert(!isJwtExpired(`h.${future}.s`), "future exp must be valid");
  assert(!isJwtExpired("opaque-token"), "opaque token cannot be judged expired");
});

Deno.test("credential import parses desktop info nested auth/account shape", async () => {
  const { credentials } = await parseCredentialFiles([{
    name: "workbuddy-desktop.info",
    content: JSON.stringify({
      auth: { accessToken: "eyJ.token.value", refreshToken: "rt-1" },
      account: { uid: "u-42" },
    }),
  }]);
  assertEquals(credentials.length, 1);
  assertEquals(credentials[0].accessToken, "eyJ.token.value");
  assertEquals(credentials[0].refreshToken, "rt-1");
  assertEquals(credentials[0].openId, "u-42");
});

Deno.test("credential import accepts raw bearer token", async () => {
  const { credentials } = await parseCredentialFiles([{
    name: "token.txt",
    content: "eyJhbGciOiJSUzI1NiJ9.payload.sig",
  }]);
  assertEquals(credentials.length, 1);
  assertEquals(credentials[0].accessToken, "eyJhbGciOiJSUzI1NiJ9.payload.sig");
});

Deno.test("credential draft produces stable key and round-trips through accountData", async () => {
  const draft = await credentialDraft({
    accessToken: "opaque-access-token",
    openId: "op-9f8e",
    displayName: "张三",
  });
  assert(draft.key.startsWith("workbuddy-cn:op-9f8e"), "key must use open id");
  const snapshot: ResourceSnapshot = {
    id: "r-1",
    type: RESOURCE_TYPE,
    key: draft.key,
    privateData: draft.privateData,
    state: { status: "ready" },
  };
  const data = accountData(snapshot);
  assertEquals(data.openId, "op-9f8e");
  assertEquals(data.displayName, "张三");
  assertEquals(data.gatewayBase, "https://copilot.tencent.com");
});

Deno.test("client headers identify official WorkBuddy CLI", () => {
  const headers = CLIENT_HEADERS;
  assert(headers["user-agent"].includes("CodeBuddy"), "user-agent must include CodeBuddy");
  assertEquals(headers.origin, "https://www.codebuddy.cn");
});

Deno.test("fallback model catalog covers the full WorkBuddy model set", () => {
  // 兜底表必须覆盖本机客户端的完整模型目录（16+），确保 API 不可用时也不缺模型。
  const fallback = fallbackModels();
  const ids = fallback.map((m) => m.id);
  assert(ids.length >= 16, `expected >=16 models, got ${ids.length}`);
  for (
    const key of [
      "hy4-preview",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "kimi-k3-1",
      "minimax-m3.1-flash",
      "mimo-v2.6-pro",
    ]
  ) {
    assert(ids.includes(key), `missing model ${key}`);
  }
});

Deno.test("merge keeps remote override but fills from baseline", () => {
  const baseline = [
    {
      id: "glm-5.3",
      displayName: "GLM-5.3",
      description: "base desc",
      maxOutputTokens: 131072,
      capabilities: { images: false },
    },
    {
      id: "kimi-k3-1",
      displayName: "Kimi-K3",
      maxOutputTokens: 131072,
      capabilities: { images: false },
    },
  ];
  const remote = parseModelsResponse({
    data: [
      { id: "glm-5.3", name: "RemoteGLM", max_output_tokens: 4096, supports_vision: true },
      { id: "brand-new", name: "Brand New" },
    ],
  });
  const merged = mergeModels(remote, baseline);
  assertEquals(merged.length, 3);
  const glm = merged.find((m) => m.id === "glm-5.3")!;
  assertEquals(glm.displayName, "GLM-5.3", "baseline display name kept");
  assertEquals(glm.maxOutputTokens, 4096, "remote token limit wins");
  assertEquals(glm.capabilities?.images, true, "remote vision flag wins");
  const kimi = merged.find((m) => m.id === "kimi-k3-1")!;
  assertEquals(kimi.displayName, "Kimi-K3", "baseline-only model preserved");
  assert(merged.some((m) => m.id === "brand-new"), "remote-only model appended");
});
