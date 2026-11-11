import type { LlmRequest } from "cursor-byok:provider";
import type { ResourceImportFile, ResourceSnapshot } from "cursor-byok:resource";
import { parseZedModels, zedModels } from "./models.ts";
import {
  decodeBase64UrlSafe,
  decryptZedAccessToken,
  encodeBase64UrlSafe,
  generateZedKeypair,
  pkcs1ToSpkiDer,
  zedNativeAppOAuth,
} from "./oauth.ts";
import { ANTHROPIC_REPLAY_KIND, unwrapZedStreamLine, zedProvider } from "./provider.ts";
import {
  type AccountData,
  credentialDraft,
  parseAuthenticatedUserResponse,
  parseCredentialFiles,
  presentAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

function fakeJwt(expSeconds: number): string {
  const header = encodeBase64UrlSafe(new TextEncoder().encode(JSON.stringify({ alg: "HS256" })));
  const payload = encodeBase64UrlSafe(
    new TextEncoder().encode(JSON.stringify({ sub: "42", exp: expSeconds })),
  );
  return `${header}.${payload}.sig`;
}

function account(overrides: Partial<AccountData> = {}): AccountData {
  return {
    userId: "12345",
    accessToken: "zed-secret-access-token-abcdef",
    systemId: "00000000-0000-4000-8000-000000000001",
    organizationId: "org_student_1",
    displayName: "octocat",
    llmToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
    llmTokenExpiresAtMs: Date.now() + 3600 * 1000,
    quota: {
      plan: "zed_student",
      planLabel: "Zed Student ($10/mo)",
      subscriptionStartedAtMs: 1_700_000_000_000,
      subscriptionEndedAtMs: 1_702_592_000_000,
      editPredictionsUsed: 200,
      editPredictionsLimit: 2000,
      hasOverdueInvoices: false,
      limitReached: false,
      coolingUntilMs: null,
      updatedAtMs: Date.now(),
    },
    ...overrides,
  };
}

function snapshot(data: AccountData): ResourceSnapshot {
  return {
    id: "resource-zed-1",
    type: RESOURCE_TYPE,
    key: `zed:${data.userId}`,
    privateData: data as never,
    state: { status: "ready" },
  };
}

function request(): LlmRequest {
  return {
    instructions: "You are a helpful coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello Zed" }] }],
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
    reasoning: { enabled: true, effort: "high" },
    latency: "fast",
    maxOutputTokens: 8_192,
    cacheKey: "thread-zed-1",
  };
}

Deno.test("RSA-2048 PKCS#1 public key roundtrips with RSA-OAEP SHA-256 encryption", async () => {
  const { publicKeyBase64Url, privateKeyJwk } = await generateZedKeypair();
  const pkcs1Bytes = decodeBase64UrlSafe(publicKeyBase64Url);
  // PKCS#1 RSAPublicKey starts with an ASN.1 SEQUENCE (0x30)
  assertEquals(pkcs1Bytes[0], 0x30);

  const spkiBytes = pkcs1ToSpkiDer(pkcs1Bytes);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    spkiBytes.buffer.slice(spkiBytes.byteOffset, spkiBytes.byteOffset + spkiBytes.byteLength) as ArrayBuffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

  const plaintext = "zed_live_token_student_plan_987654321";
  const encrypted = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(plaintext),
  );
  const encryptedBase64Url = encodeBase64UrlSafe(new Uint8Array(encrypted));

  const decrypted = await decryptZedAccessToken(privateKeyJwk, encryptedBase64Url);
  assertEquals(decrypted, plaintext);
});

Deno.test("native_app_signin OAuth begin and complete decrypt credentials and fetch student plan", async () => {
  const dummyContext = {
    signal: new AbortController().signal,
    network: {
      fetch: (url: string) => {
        if (url.endsWith("/client/users/me")) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({
              user: { id: 888, github_login: "student-dev" },
              organizations: [{ id: "org_edu_888", name: "Personal" }],
              plan: {
                plan_v3: "zed_student",
                subscription_period: {
                  started_at: "2026-11-01T00:00:00Z",
                  ended_at: "2026-12-01T00:00:00Z",
                },
                usage: {
                  edit_predictions: { used: 50, limit: { limited: 2000 } },
                },
              },
            }),
          });
        }
        if (url.endsWith("/client/llm_tokens")) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({
              token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
            }),
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
      stream: () => Promise.reject(new Error("unexpected stream")),
    },
  };

  const began = await zedNativeAppOAuth.begin(
    {
      redirectUri: "http://127.0.0.1:54321/",
      state: "unused-state",
      codeChallenge: "unused-challenge",
    },
    dummyContext as never,
  );
  const authUrl = new URL(began.authorizationUrl);
  assertEquals(authUrl.origin + authUrl.pathname, "https://zed.dev/native_app_signin");
  assertEquals(authUrl.searchParams.get("native_app_port"), "54321");
  const pubKeyParam = authUrl.searchParams.get("native_app_public_key");
  assert(pubKeyParam && pubKeyParam.length > 100, "missing native_app_public_key");

  // Simulate cloud.zed.dev encrypting the access_token with the public key
  const spkiBytes = pkcs1ToSpkiDer(decodeBase64UrlSafe(pubKeyParam));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    spkiBytes.buffer.slice(spkiBytes.byteOffset, spkiBytes.byteOffset + spkiBytes.byteLength) as ArrayBuffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const rawAccessToken = "zed_student_secret_token_xyz";
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(rawAccessToken),
  );
  const callbackCode = JSON.stringify({
    user_id: "888",
    access_token: encodeBase64UrlSafe(new Uint8Array(cipherBuffer)),
  });

  const drafts = await zedNativeAppOAuth.complete(
    began.session,
    {
      code: callbackCode,
      redirectUri: "http://127.0.0.1:54321/",
      codeVerifier: "unused-verifier",
    },
    dummyContext as never,
  );

  assertEquals(drafts.length, 1);
  assertEquals(drafts[0].key, "zed:888");
  const saved = drafts[0].privateData as unknown as AccountData;
  assertEquals(saved.userId, "888");
  assertEquals(saved.accessToken, rawAccessToken);
  assertEquals(saved.displayName, "student-dev");
  assertEquals(saved.organizationId, "org_edu_888");
  assertEquals(saved.quota?.plan, "zed_student");
  assertEquals(saved.quota?.planLabel, "Zed Student ($10/mo)");
});

Deno.test("credential import accepts space-separated, JSON, env, and JWT formats without leaking secrets", async () => {
  const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const files: ResourceImportFile[] = [
    { name: "keychain.txt", content: "1001 zed_keychain_secret_token_123456" },
    {
      name: "account.json",
      content: JSON.stringify({
        user_id: 1002,
        access_token: "zed_json_secret_token_123456",
        github_login: "zed-coder",
      }),
    },
    {
      name: "zed.env",
      content: "ZED_USER_ID=1003\nZED_ACCESS_TOKEN=zed_env_secret_token_123456\n",
    },
    { name: "token.key", content: jwt },
    { name: "broken.json", content: "{invalid" },
  ];

  const parsed = parseCredentialFiles(files);
  assertEquals(parsed.credentials.length, 4);
  assertEquals(parsed.warnings.length, 1);
  assertEquals(parsed.credentials[0].userId, "1001");
  assertEquals(parsed.credentials[1].userId, "1002");
  assertEquals(parsed.credentials[1].displayName, "zed-coder");
  assertEquals(parsed.credentials[2].userId, "1003");
  assertEquals(parsed.credentials[3].userId, "jwt");

  const draft = await credentialDraft({
    ...parsed.credentials[1],
    quota: parseAuthenticatedUserResponse({
      user: { github_login: "zed-coder" },
      plan: {
        plan_v3: "zed_student",
        usage: { edit_predictions: { used: 500, limit: 2000 } },
      },
    }).quota,
  });
  const view = presentAccount(snapshot(draft.privateData as unknown as AccountData));
  assertEquals(view.displayName, "zed-coder");
  assertEquals(view.description, "Zed Student ($10/mo)");
  assertEquals(view.metrics?.[0]?.value, 75);
  assert(!JSON.stringify(view).includes("zed_json_secret_token_123456"));
});

Deno.test("model discovery parses Zed Cloud models and refreshes expired LLM tokens", async () => {
  let modelsAttempts = 0;
  let mintedTokens = 0;
  const freshJwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const context = {
    signal: new AbortController().signal,
    network: {
      fetch: (url: string) => {
        if (url.endsWith("/models")) {
          modelsAttempts += 1;
          if (modelsAttempts === 1) {
            return Promise.resolve({
              status: 401,
              headers: { "x-zed-expired-token": "true" },
              body: "expired token",
            });
          }
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({
              models: [
                {
                  provider: "anthropic",
                  id: "claude-sonnet-4-5",
                  display_name: "Claude Sonnet 4.5",
                  max_output_tokens: 64000,
                  supports_thinking: true,
                  supports_images: true,
                },
                {
                  provider: "open_ai",
                  id: "gpt-5.2",
                  display_name: "GPT-5.2",
                  max_output_tokens: 32768,
                  supports_thinking: true,
                  supported_effort_levels: ["low", "medium", "high"],
                },
              ],
              default_model: "claude-sonnet-4-5",
              recommended_models: ["claude-sonnet-4-5", "gpt-5.2"],
            }),
          });
        }
        if (url.endsWith("/client/llm_tokens")) {
          mintedTokens += 1;
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({ token: freshJwt }),
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
      stream: () => Promise.reject(new Error("unexpected stream")),
    },
  };

  const discovered = await zedModels.list(
    { resource: snapshot(account()) },
    context as never,
  );
  assertEquals(modelsAttempts, 2);
  assertEquals(mintedTokens, 1);
  assertEquals(discovered.map((m) => m.id), ["claude-sonnet-4-5", "gpt-5.2"]);
  assertEquals(discovered[0].displayName, "Claude Sonnet 4.5 (Zed)");
  assertEquals(discovered[0].maxOutputTokens, 64000);
});

Deno.test("Anthropic provider streams thinking, text, tool calls, replay state, and usage via Zed NDJSON", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const events: Array<Record<string, unknown>> = [];

  const context = {
    signal: new AbortController().signal,
    network: {
      fetch: () => Promise.reject(new Error("unexpected fetch")),
      stream: (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return Promise.resolve({
          status: 200,
          headers: {},
          lines: (async function* () {
            yield JSON.stringify({ status: "queued" });
            yield JSON.stringify({ status: "started" });
            yield JSON.stringify({
              event: {
                type: "message_start",
                message: { usage: { input_tokens: 120, cache_read_input_tokens: 80 } },
              },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "" },
              },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "Analyzing file..." },
              },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature: "sig_abc_123" },
              },
            });
            yield JSON.stringify({
              event: { type: "content_block_stop", index: 0 },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_start",
                index: 1,
                content_block: { type: "text", text: "" },
              },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_delta",
                index: 1,
                delta: { type: "text_delta", text: "Let me read the file." },
              },
            });
            yield JSON.stringify({
              event: { type: "content_block_stop", index: 1 },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_start",
                index: 2,
                content_block: {
                  type: "tool_use",
                  id: "toolu_01",
                  name: "read_file",
                  input: {},
                },
              },
            });
            yield JSON.stringify({
              event: {
                type: "content_block_delta",
                index: 2,
                delta: { type: "input_json_delta", partial_json: '{"path":"main.rs"}' },
              },
            });
            yield JSON.stringify({
              event: { type: "content_block_stop", index: 2 },
            });
            yield JSON.stringify({
              event: {
                type: "message_delta",
                delta: { stop_reason: "tool_use" },
                usage: { output_tokens: 45 },
              },
            });
            yield JSON.stringify({
              event: { type: "message_stop" },
            });
            yield JSON.stringify({ status: "stream_ended" });
          })(),
        });
      },
    },
  };

  const models = parseZedModels({
    models: [{
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5",
      max_output_tokens: 64000,
      supports_thinking: true,
    }],
  });

  const result = await zedProvider.invoke(
    {
      model: models[0],
      resource: snapshot(account()),
      request: request(),
    },
    { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    context as never,
  );

  assertEquals(result, { status: "completed" });
  assertEquals(capturedUrl, "https://cloud.zed.dev/completions");
  assertEquals(capturedBody?.provider, "anthropic");
  assertEquals(capturedBody?.model, "claude-sonnet-4-5");
  assertEquals(capturedBody?.thread_id, "thread-zed-1");

  assert(events.some((e) => e.type === "thinking-delta" && e.text === "Analyzing file..."));
  assert(events.some((e) => e.type === "text-delta" && e.text === "Let me read the file."));
  assert(events.some((e) => e.type === "tool-call-start" && e.name === "read_file"));
  assert(
    events.some((e) =>
      e.type === "replay-state" &&
      e.providerKind === ANTHROPIC_REPLAY_KIND &&
      (e.value as { signature?: string })?.signature === "sig_abc_123"
    ),
  );
  const usageEvent = events.find((e) => e.type === "usage") as {
    type: "usage";
    usage: Record<string, unknown>;
  };
  assert(usageEvent !== undefined);
  assertEquals(usageEvent.usage, {
    inputTokens: 120,
    contextInputTokens: 200,
    outputTokens: 45,
    totalTokens: 245,
    cacheReadTokens: 80,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
  assert(events.some((e) => e.type === "done" && e.reason === "tool-use"));
});

Deno.test("OpenAI provider wraps Responses API payload in Zed CompletionBody and unwraps stream", async () => {
  let capturedBody: Record<string, unknown> = {};
  const events: Array<Record<string, unknown>> = [];

  const context = {
    signal: new AbortController().signal,
    network: {
      fetch: () => Promise.reject(new Error("unexpected fetch")),
      stream: (_url: string, init?: { body?: string }) => {
        capturedBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return Promise.resolve({
          status: 200,
          headers: {},
          lines: (async function* () {
            yield JSON.stringify({
              event: {
                type: "response.output_text.delta",
                delta: "Hello from GPT via Zed",
              },
            });
            yield JSON.stringify({
              event: {
                type: "response.completed",
                response: {
                  status: "completed",
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
              },
            });
            yield JSON.stringify({ status: "stream_ended" });
          })(),
        });
      },
    },
  };

  const models = parseZedModels({
    models: [{
      provider: "open_ai",
      id: "gpt-5.2",
      display_name: "GPT-5.2",
      max_output_tokens: 32768,
      supports_thinking: true,
      supported_effort_levels: ["low", "medium", "high"],
    }],
  });

  const result = await zedProvider.invoke(
    {
      model: models[0],
      resource: snapshot(account()),
      request: request(),
    },
    { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    context as never,
  );

  assertEquals(result, { status: "completed" });
  assertEquals(capturedBody?.provider, "open_ai");
  assertEquals(capturedBody?.model, "gpt-5.2");
  assert(events.some((e) => e.type === "text-delta" && e.text === "Hello from GPT via Zed"));
  assert(events.some((e) => e.type === "done" && e.reason === "stop"));
});

Deno.test("provider marks resource as cooling when Zed Student $10/mo spending limit is reached (HTTP 402/429)", async () => {
  const context = {
    signal: new AbortController().signal,
    network: {
      fetch: () => Promise.reject(new Error("unexpected fetch")),
      stream: () =>
        Promise.resolve({
          status: 402,
          headers: {},
          lines: (async function* () {
            yield '{"error":"monthly_spending_limit_reached: $10.00 student credit exhausted"}';
          })(),
        }),
    },
  };

  const models = parseZedModels({
    models: [{
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5",
      max_output_tokens: 64000,
    }],
  });

  const result = await zedProvider.invoke(
    {
      model: models[0],
      resource: snapshot(account()),
      request: request(),
    },
    { emit: () => {} },
    context as never,
  );

  assertEquals(result.status, "resource-error");
  if (result.status === "resource-error") {
    assertEquals(result.patch?.state?.status, "cooling");
  }
});

Deno.test("unwrapZedStreamLine surfaces Zed failed status objects with retry_after", () => {
  let message = "";
  try {
    unwrapZedStreamLine(
      JSON.stringify({
        status: {
          failed: {
            code: "upstream_http_429",
            message: "Too many requests",
            retry_after: 12.5,
          },
        },
      }),
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("upstream_http_429"));
  assert(message.includes("retry_after=12.5"));
});
