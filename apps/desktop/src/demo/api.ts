import type {
  CallDetail,
  CursorHarnessStatus,
  ExternalApiSettings,
  LlmCall,
  MagpieCatalog,
  Model,
  ModelPrice,
  ModelPriceEntry,
  ModelPriceInput,
  Overview,
  OverviewBucket,
  ProxySettings,
  StatisticsStorage,
  TabSettings,
  VisionSettings,
  WorkspaceExtensionStatus,
} from "../shared/api";

const API_ROOT = "/__byok-api__/api";
const FIXED_NOW = Date.UTC(2026, 7, 27, 8, 0, 0);

const models: Model[] = [
  createModel({ hash: "mock-claude-sonnet", order: 1, name: "Claude Sonnet 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-sonnet-4-20250514" }),
  createModel({ hash: "mock-claude-opus", order: 2, name: "Claude Opus 4", type: "anthropic", url: "https://api.anthropic.com", modelId: "claude-opus-4-20250514" }),
  createModel({ hash: "mock-gpt", order: 3, name: "GPT-5.2", type: "openai", url: "https://api.openai.com", modelId: "gpt-5.2" }),
  createModel({ hash: "mock-o3", order: 4, name: "o3", type: "openai", url: "https://api.openai.com", modelId: "o3" }),
  createModel({ hash: "mock-deepseek-v3", order: 5, name: "DeepSeek V3.2", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-chat", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-deepseek-r1", order: 6, name: "DeepSeek R1", type: "openai", url: "https://api.deepseek.com", modelId: "deepseek-reasoner", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-gemini-pro", order: 7, name: "Gemini 2.5 Pro", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-pro", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-gemini-flash", order: 8, name: "Gemini 2.5 Flash", type: "openai", url: "https://generativelanguage.googleapis.com", modelId: "gemini-2.5-flash", endpoint: "/v1beta/openai/chat/completions" }),
  createModel({ hash: "mock-qwen-max", order: 9, name: "Qwen3 Max", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen3-max", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-qwen-plus", order: 10, name: "Qwen Plus", type: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode", modelId: "qwen-plus", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-k2", order: 11, name: "Kimi K2", type: "openai", url: "https://api.moonshot.cn", modelId: "kimi-k2-0711-preview", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-kimi-128k", order: 12, name: "Moonshot V1 128K", type: "openai", url: "https://api.moonshot.cn", modelId: "moonshot-v1-128k", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-glm-45", order: 13, name: "GLM-4.5", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-glm-air", order: 14, name: "GLM-4.5-Air", type: "openai", url: "https://open.bigmodel.cn", modelId: "glm-4.5-air", endpoint: "/api/paas/v4/chat/completions" }),
  createModel({ hash: "mock-mistral-large", order: 15, name: "Mistral Large", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-large-latest", endpoint: "/v1/chat/completions" }),
  createModel({ hash: "mock-mistral-small", order: 16, name: "Mistral Small", type: "openai", url: "https://api.mistral.ai", modelId: "mistral-small-latest", endpoint: "/v1/chat/completions" }),
];

const magpieModels: MagpieCatalog["models"] = [
  { id: "anthropic/claude-sonnet-4.5", magpie_label: "Claude Sonnet 4.5", context_window: 200_000, reasoning: true, modalities: { input: ["text", "image"] } },
  { id: "anthropic/claude-haiku-4.5", magpie_label: "Claude Haiku 4.5", context_window: 200_000, reasoning: true, modalities: { input: ["text", "image"] } },
  { id: "openai/gpt-5.2", magpie_label: "GPT-5.2", context_window: 400_000, reasoning: true, modalities: { input: ["text", "image"] } },
  { id: "openai/gpt-5.2-mini", magpie_label: "GPT-5.2 mini", context_window: 400_000, reasoning: true, modalities: { input: ["text"] } },
  { id: "google/gemini-2.5-pro", magpie_label: "Gemini 2.5 Pro", context_window: 1_048_576, reasoning: true, modalities: { input: ["text", "image"] } },
  { id: "deepseek/deepseek-v3.2", magpie_label: "DeepSeek V3.2", context_window: 128_000, reasoning: false, modalities: { input: ["text"] } },
];
let magpie: MagpieCatalog | null = null;
let workspaceExtension: WorkspaceExtensionStatus = { state: "missing", installed_version: null, expected_version: "1.1.0", cursor_cli: true };
const modelPriceMap = new Map<string, ModelPrice>();
const priceKey = (providerUrl: string, modelId: string) => `${providerUrl}${modelId}`;
// Two priced models (one per currency) so the price table and the overview
// estimate both show priced and unpriced calls.
modelPriceMap.set(priceKey("https://api.openai.com/v1/responses", "gpt-5.2"), {
  input_per_million: 1.25, output_per_million: 10, cache_read_per_million: 0.125, cache_write_per_million: null, currency: "USD", updated_at_ms: FIXED_NOW,
});
modelPriceMap.set(priceKey("https://api.deepseek.com/v1/chat/completions", "deepseek-chat"), {
  input_per_million: 2, output_per_million: 8, cache_read_per_million: null, cache_write_per_million: null, currency: "CNY", updated_at_ms: FIXED_NOW,
});

function magpieCursorModels(): Model[] {
  if (!magpie) return [];
  const disabled = magpie.disabled;
  return magpie.models.filter(model => !disabled.includes(model.id)).map((model, index) => ({
    ...createModel({ hash: `magpie-${model.id}`, order: 100 + index, name: model.magpie_label ?? model.id, type: "openai", url: `http://127.0.0.1:${magpie!.port}`, modelId: model.id }),
    gateway_capabilities: { thinking: Boolean(model.reasoning), efforts: model.reasoning ? ["low", "medium", "high"] : [] },
  }));
}

const calls: LlmCall[] = Array.from({ length: 24 }, (_, index) => {
  const model = models[index % models.length];
  const failed = index === 7 || index === 19;
  return {
    call_kind: "provider_llm",
    route: "local_byok",
    call_id: `mock-call-${String(index + 1).padStart(3, "0")}`,
    run_id: `mock-run-${Math.floor(index / 3) + 1}`,
    conversation_id: `mock-conversation-${Math.floor(index / 4) + 1}`,
    provider_call_index: index + 1,
    model_hash: model.model_hash,
    provider_type: model.type,
    provider_url: model.type === "anthropic" ? `${model.base_url}/v1/messages` : `${model.base_url}${model.openai_endpoint}`,
    request_type: model.type === "anthropic" ? "anthropic" : "openai-chat",
    request_url: model.type === "anthropic" ? `${model.base_url}/v1/messages` : `${model.base_url}${model.openai_endpoint}`,
    model_id: model.model_id,
    display_name: model.display_name,
    reasoning_effort: index % 2 === 0 ? "high" : null,
    fast: index % 3 === 0,
    status: failed ? "failed" : "completed",
    finish_reason: failed ? null : "stop",
    created_at_ms: FIXED_NOW - index * 3 * 60_000,
    ttfb_ms: 210 + index * 13,
    ttfr_ms: 290 + index * 15,
    ttft_ms: 370 + index * 17,
    duration_ms: failed ? 812 : 1_420 + index * 71,
    input_tokens: 4_800 + index * 337,
    output_tokens: failed ? 0 : 820 + index * 43,
    total_tokens: failed ? 4_800 + index * 337 : 5_620 + index * 380,
    cache_read_tokens: 3_100 + index * 251,
    cache_write_tokens: 320 + index * 19,
    reasoning_tokens: index % 2 === 0 ? 420 + index * 11 : null,
    message_count: 14 + (index % 8),
    tool_count: 3 + (index % 5),
    launched_tool_count: index % 4,
    run_kind: index % 6 === 2 ? "subagent" : "root",
    subagent_kind: index % 6 === 2 ? "Explore" : null,
    http_status: failed ? 429 : 200,
    error_kind: failed ? "provider_rate_limit" : null,
    error_message: failed ? "Mock provider rate limit" : null,
    detailed: true,
  };
});

let harnessStatus: CursorHarnessStatus = {
  platform: "macos",
  ca: "ready",
  configured_models: models.length,
  enabled_models: models.length,
  integration: "enabled",
  settings_applied: true,
  proxy_url: "http://127.0.0.1:54321",
  ca_install_command: null,
};

let commitSettings = { model_id: "mock-claude-sonnet", prompt: "", prompt_locale: "zh-CN", default_prompt: "Summarize the staged diff as a Conventional Commit message." };
let detailed = true;
let portSettings = { proxy_port: 0, service_port: 0, inference_port: 0 };
let visionSettings: VisionSettings = { mode: "cursor" };
let externalApiSettings: ExternalApiSettings = { enabled: false, api_key: "" };
let proxySettings: ProxySettings = {
  mode: "default",
  address: "",
  auth_enabled: false,
  username: "",
  has_password: false,
};
let tabSettings: TabSettings = { mode: "public", address: "" };
let storage: StatisticsStorage = { call_count: calls.length, trace_count: calls.length };

export function installDemoApi() {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(requestUrl, window.location.href);
    if (!url.pathname.startsWith(API_ROOT)) return nativeFetch(input, init);

    const path = url.pathname.slice(API_ROOT.length) || "/";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await readBody(input, init);

    if (path === "/plugins/runtime" && method === "GET") return json({ state: "ready", version: "demo", target: null, phase: null, downloaded_bytes: 0, total_bytes: null, error: null });
    if (path === "/plugins" && method === "GET") return json([]);
    if (path === "/models" && method === "GET") return json([...models, ...magpieCursorModels()]);
    if (path === "/providers/magpie" && method === "GET") return json(magpie);
    if (path === "/providers/magpie" && method === "POST") {
      magpie = { port: 18_642, models: magpieModels, disabled: magpie?.disabled ?? ["openai/gpt-5.2-mini", "deepseek/deepseek-v3.2"] };
      return empty();
    }
    if (path === "/providers/magpie" && method === "DELETE") {
      magpie = null;
      return empty();
    }
    if (path === "/providers/magpie/selection" && method === "PUT" && magpie) {
      const enabled = body as string[];
      magpie = { ...magpie, disabled: magpie.models.map(model => model.id).filter(id => !enabled.includes(id)) };
      return empty();
    }
    if (path === "/models" && method === "POST") return json(models);
    if (path === "/models/order") return json(models);
    if (path === "/models/discover") return json({ models: models.map((model) => model.model_id) });
    if (path === "/models/import-v0049" && method === "GET") {
      return json({ source: "demo", total: 0, new_models: 0, existing_models: 0, models: [] });
    }
    if (path === "/models/import-v0049") return json({ imported: 0, skipped: 0, total: 0 });
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) && method === "POST") {
      return json({ duration_ms: 1_284, first_valid_response_ms: 418, output_tokens: 42, tokens_per_second: 38.6, tokens_estimated: false, output: "Mock connectivity test passed." });
    }
    if (/^\/models\/[^/]+\/test\/[^/]+$/.test(path) || /^\/models\/[^/]+$/.test(path)) {
      return method === "DELETE" ? empty() : json(models[0]);
    }
    if (path === "/overview") return json(createOverview(url.searchParams));
    if (path === "/llm-calls") return json(calls);
    if (path.startsWith("/llm-calls/")) return json(createCallDetail(path.slice("/llm-calls/".length)));
    if (path === "/harness/cursor/status") return json(harnessStatus);
    if (path === "/harness/cursor/ca/initialize") return json(harnessStatus);
    if (path === "/harness/cursor/workspace-extension/status") return json(workspaceExtension);
    if (path === "/harness/cursor/workspace-extension/install") {
      workspaceExtension = { ...workspaceExtension, state: "current", installed_version: workspaceExtension.expected_version };
      return json(workspaceExtension);
    }
    if (path === "/harness/cursor/workspace-extension/vsix") return json({ saved_to: `~/Downloads/byok-workspace-symbols-${workspaceExtension.expected_version}.vsix` });
    if (path === "/harness/cursor/enabled") {
      const enabled = Boolean((body as { enabled?: unknown } | null)?.enabled);
      harnessStatus = {
        ...harnessStatus,
        integration: enabled ? "enabled" : "disabled",
        settings_applied: enabled,
        proxy_url: enabled ? "http://127.0.0.1:54321" : null,
      };
      return json(harnessStatus);
    }
    if (path === "/model-prices" && method === "GET") return json(modelPriceEntries());
    if (path === "/model-prices" && method === "PUT") {
      const input = body as ModelPriceInput | null;
      if (!input || typeof input.provider_url !== "string" || typeof input.model_id !== "string") {
        return json({ error: "model-prices: provider_url and model_id are required" }, 400);
      }
      modelPriceMap.set(`${input.provider_url}${input.model_id}`, {
        input_per_million: Number(input.input_per_million ?? 0),
        output_per_million: Number(input.output_per_million ?? 0),
        cache_read_per_million: input.cache_read_per_million ?? null,
        cache_write_per_million: input.cache_write_per_million ?? null,
        currency: input.currency === "CNY" ? "CNY" : "USD",
        updated_at_ms: Date.now(),
      });
      return json({ ok: true });
    }
    if (path === "/model-prices" && method === "DELETE") {
      const key = body as { provider_url?: string; model_id?: string } | null;
      if (key?.provider_url && key?.model_id) modelPriceMap.delete(`${key.provider_url}${key.model_id}`);
      return empty();
    }
    if (path === "/settings/commit") {
      if (method === "PUT") commitSettings = { ...commitSettings, ...(body as object) };
      return json(commitSettings);
    }
    if (path === "/settings/observability" && method === "GET") return json({ detailed });
    if (path === "/settings/observability") {
      detailed = Boolean((body as { detailed?: unknown } | null)?.detailed);
      return json({ detailed });
    }
    if (path === "/settings/vision") {
      if (method === "PUT") visionSettings = body as VisionSettings;
      return json(visionSettings);
    }
    if (path === "/settings/ports" && method === "GET") return json(portSettings);
    if (path === "/settings/ports") {
      portSettings = body as typeof portSettings;
      return json(portSettings);
    }
    if (path === "/settings/external-api" && method === "GET") return json({ ...externalApiSettings, base_url: "http://127.0.0.1:3000/byok/v1" });
    if (path === "/settings/external-api") {
      externalApiSettings = body as ExternalApiSettings;
      return json({ ...externalApiSettings, base_url: "http://127.0.0.1:3000/byok/v1" });
    }
    if (path === "/settings/storage/statistics" && method === "GET") return json(storage);
    if (path === "/settings/storage/statistics") {
      const scope = (body as { scope?: string } | null)?.scope ?? "details";
      storage = scope === "all" ? { call_count: 0, trace_count: 0 } : storage;
      return json(storage);
    }
    if (path === "/settings/proxy" && method === "GET") return json(proxySettings);
    if (path === "/settings/proxy") {
      const next = body as Partial<ProxySettings>;
      proxySettings = { ...proxySettings, ...next, has_password: Boolean(next.has_password) };
      return json(proxySettings);
    }
    if (path === "/settings/tab" && method === "GET") return json(tabSettings);
    if (path === "/settings/tab") {
      tabSettings = body as TabSettings;
      return json(tabSettings);
    }
    if (path === "/settings/desktop" && method === "GET") return json({ silent_start: false, show_dock_icon: true });
    if (path === "/settings/desktop") return json(body);
    if (path === "/desktop/open-external-url") {
      const target = (body as { url?: string } | null)?.url;
      if (target) {
        const next = new URL(target, window.location.href);
        if (next.origin === window.location.origin && next.hash) window.location.hash = next.hash;
      }
      return empty();
    }
    if (path.endsWith("/dismissals")) return empty();

    return json({ message: `Unhandled demo endpoint: ${method} ${path}` }, 404);
  };
}

function createModel({ hash, order, name, type, url, modelId, endpoint = "/v1/responses" }: {
  hash: string;
  order: number;
  name: string;
  type: Model["type"];
  url: string;
  modelId: string;
  endpoint?: string;
}): Model {
  return {
    model_hash: hash,
    supports_images: true,
    sort_order: order,
    display_name: name,
    group_name: null,
    type,
    base_url: url,
    use_full_url: false,
    tooltip_data: `${name} Mock 通道`,
    model_id: modelId,
    reasoning_effort: type === "openai" ? "high" : null,
    openai_endpoint: type === "openai" ? endpoint : "",
    openai_extra_params_enabled: false,
    openai_extra_params: {},
    custom_headers_enabled: false,
    anthropic_extra_params_enabled: false,
    anthropic_extra_params: {},
    context_window_tokens: 200_000,
    max_completion_tokens: type === "openai" ? 32_000 : null,
    anthropic_max_tokens: type === "anthropic" ? 32_000 : null,
    anthropic_thinking_effort: type === "anthropic" ? "high" : null,
    thinking_budget_tokens: null,
    created_at_ms: FIXED_NOW - order * 86_400_000,
    updated_at_ms: FIXED_NOW,
  };
}

function channelName(call: LlmCall): string {
  const model = models.find((candidate) => candidate.model_hash === call.model_hash);
  if (model?.group_name?.trim()) return model.group_name.trim();
  if (call.model_hash?.startsWith("magpie-")) return "Magpie";
  try {
    return new URL(call.provider_url).hostname;
  } catch {
    return call.provider_url.replace(/^[a-z]+:\/\//, "").split("/")[0] || call.provider_url;
  }
}

function modelPriceEntries(): ModelPriceEntry[] {
  const latest = new Map<string, { call: LlmCall; ms: number }>();
  for (const call of calls) {
    const key = `${call.provider_url}${call.model_id}`;
    const current = latest.get(key);
    if (!current || call.created_at_ms > current.ms) latest.set(key, { call, ms: call.created_at_ms });
  }
  return [...latest.values()]
    .sort((a, b) => b.ms - a.ms)
    .map(({ call }) => {
      const key = `${call.provider_url}${call.model_id}`;
      return {
        provider_url: call.provider_url,
        model_id: call.model_id,
        channel_name: channelName(call),
        last_call_ms: call.created_at_ms,
        price: modelPriceMap.get(key) ?? null,
      };
    });
}

// Mirrors the server: priced calls sum per currency with fresh input for the
// provider's usage shape, and every call without a price is counted.
function demoCosts() {
  const totals = new Map<string, number>();
  let unpriced = 0;
  for (const call of calls) {
    const price = modelPriceMap.get(priceKey(call.provider_url, call.model_id));
    if (!price) {
      unpriced += 1;
      continue;
    }
    const fresh = call.request_type === "anthropic"
      ? Math.max(0, call.input_tokens ?? 0)
      : Math.max(0, (call.input_tokens ?? 0) - (call.cache_read_tokens ?? 0) - (call.cache_write_tokens ?? 0));
    const cacheRead = price.cache_read_per_million ?? price.input_per_million;
    const cacheWrite = price.cache_write_per_million ?? price.input_per_million;
    const amount = (
      fresh * price.input_per_million
      + (call.cache_read_tokens ?? 0) * cacheRead
      + (call.cache_write_tokens ?? 0) * cacheWrite
      + (call.output_tokens ?? 0) * price.output_per_million
    ) / 1_000_000;
    totals.set(price.currency, (totals.get(price.currency) ?? 0) + amount);
  }
  return {
    costs: [...totals].map(([currency, amount]) => ({ currency, amount })),
    unpriced_calls: unpriced,
  };
}

function createOverview(params: URLSearchParams): Overview {
  const start = Number(params.get("start_ms"));
  const end = Number(params.get("end_ms"));
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 365 * 86_400_000;
  const granularity = duration <= 2 * 60 * 60_000 ? "minute" : duration <= 2 * 86_400_000 ? "hour" : "day";
  const step = granularity === "minute" ? 60_000 : granularity === "hour" ? 3_600_000 : 86_400_000;
  const count = granularity === "minute" ? Math.min(60, Math.max(10, Math.ceil(duration / step))) : granularity === "hour" ? Math.min(24, Math.max(8, Math.ceil(duration / step))) : Math.min(365, Math.max(7, Math.ceil(duration / step)));
  const { costs, unpriced_calls } = demoCosts();
  const series = createSeries(count, step, Number.isFinite(end) && end > 0 ? end : FIXED_NOW, costs);
  const totals = series.reduce((sum, bucket) => ({
    input: sum.input + bucket.input_tokens,
    cacheRead: sum.cacheRead + bucket.cache_read_tokens,
    cacheWrite: sum.cacheWrite + bucket.cache_write_tokens,
    output: sum.output + bucket.output_tokens,
    calls: sum.calls + bucket.calls,
    failed: sum.failed + bucket.failed_calls,
  }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, failed: 0 });
  const timed = series.filter((bucket) => bucket.calls > 0);
  const mean = (values: number[]) => values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    metrics: {
      llm_calls: totals.calls,
      successful_calls: totals.calls - totals.failed,
      failed_calls: totals.failed,
      token_usage: totals.input + totals.cacheRead + totals.cacheWrite + totals.output,
      prompt_tokens: totals.input + totals.cacheRead + totals.cacheWrite,
      input_tokens: totals.input,
      cache_read_tokens: totals.cacheRead,
      cache_write_tokens: totals.cacheWrite,
      output_tokens: totals.output,
      costs,
      unpriced_calls,
      avg_ttft_ms: mean(timed.flatMap((bucket) => bucket.avg_ttft_ms ?? [])),
      output_tokens_per_second: mean(timed.flatMap((bucket) => bucket.output_tokens_per_second ?? [])),
    },
    granularity,
    series,
  };
}

function createSeries(count: number, step: number, end: number, costs: { currency: string; amount: number }[]): OverviewBucket[] {
  const waves = Array.from({ length: count }, (_, index) => 0.72 + ((index * 17) % 31) / 50);
  const waveTotal = waves.reduce((sum, wave) => sum + wave, 0);
  return waves.map((wave, index) => {
    const calls = Math.max(1, Math.round(5.4 * wave));
    return {
      bucket_start_ms: end - (count - index) * step,
      // input : cache_read = 1 : 99，使默认口径缓存命中率恰为 99%
      input_tokens: Math.round(800 * wave),
      cache_read_tokens: Math.round(79_200 * wave),
      cache_write_tokens: Math.round(7_500 * wave),
      output_tokens: Math.round(12_500 * wave),
      calls,
      failed_calls: index % 9 === 4 ? 1 : 0,
      avg_ttft_ms: Math.round(620 + ((index * 37) % 23) * 18),
      output_tokens_per_second: 48 + ((index * 13) % 17) * 1.6,
      costs: costs.map((cost) => ({ currency: cost.currency, amount: cost.amount * wave / waveTotal })),
    };
  });
}

function createCallDetail(id: string): CallDetail {
  const call = calls.find((item) => item.call_id === decodeURIComponent(id)) ?? calls[0];
  return {
    call,
    request: {
      headers: { authorization: "Bearer sk-demo-••••", "content-type": "application/json" },
      body: { model: call.model_id, stream: true, messages: [{ role: "user", content: "Mock Agent request" }] },
      byte_count: 8_426,
    },
    response_chunks: [
      { seq: 1, received_offset_ms: 418, data: `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_demo","model":"${call.model_id}"}}\n\n`, byte_count: 128 },
      { seq: 2, received_offset_ms: 512, data: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Mock answer"}\n\n', byte_count: 96 },
      { seq: 3, received_offset_ms: 1_380, data: 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4800,"output_tokens":820}}}\n\n', byte_count: 164 },
    ],
    cursor_trace: null,
  };
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (typeof raw !== "string" || raw.length === 0) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return raw; }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty() {
  return new Response(null, { status: 204 });
}
