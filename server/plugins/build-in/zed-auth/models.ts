import type { JsonValue } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import {
  accountData,
  ensureLlmToken,
  ZED_CLOUD_BASE_URL,
  ZED_VERSION,
  ZED_VERSION_HEADER,
} from "./resources.ts";

export type ZedUpstreamProvider = "anthropic" | "open_ai" | "google" | "x_ai";

export type ZedModelMetadata = {
  provider: ZedUpstreamProvider;
  supportsThinking: boolean;
  supportsDisablingThinking: boolean;
  supportsFastMode: boolean;
  supportsParallelToolCalls: boolean;
  reasoningEfforts: string[];
  maxOutputTokens: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function inferUpstreamProvider(modelId: string, rawProvider?: unknown): ZedUpstreamProvider {
  const normalized = text(rawProvider)?.toLowerCase();
  if (
    normalized === "anthropic" ||
    normalized === "open_ai" ||
    normalized === "google" ||
    normalized === "x_ai"
  ) {
    return normalized;
  }
  if (normalized === "openai") return "open_ai";
  if (normalized === "xai") return "x_ai";

  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gemini-")) return "google";
  if (lower.startsWith("grok-")) return "x_ai";
  return "open_ai";
}

function parseEffortLevels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const levels: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      levels.push(item.trim());
      continue;
    }
    const obj = object(item);
    const val = text(obj?.value ?? obj?.id ?? obj?.name);
    if (val) levels.push(val);
  }
  return [...new Set(levels)];
}

export function parseZedModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.models ?? body;
  if (!Array.isArray(source)) {
    throw new Error("Zed model discovery response does not contain a model list");
  }

  const seen = new Set<string>();
  const models: ModelDefinition[] = [];

  for (const item of source) {
    const raw = object(item);
    if (!raw || raw.is_disabled === true) continue;
    const id = text(raw.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const provider = inferUpstreamProvider(id, raw.provider);
    const displayName = text(raw.display_name ?? raw.displayName) ?? id;
    const maxOutputTokens = positiveInteger(raw.max_output_tokens ?? raw.maxOutputTokens) ?? 16_384;
    const supportsImages = raw.supports_images !== false;
    const supportsThinking = raw.supports_thinking === true;
    const supportsDisablingThinking = raw.supports_disabling_thinking !== false;
    const supportsFastMode = raw.supports_fast_mode === true;
    const supportsParallelToolCalls = raw.supports_parallel_tool_calls !== false;
    const reasoningEfforts = parseEffortLevels(raw.supported_effort_levels);

    const metadata: ZedModelMetadata = {
      provider,
      supportsThinking,
      supportsDisablingThinking,
      supportsFastMode,
      supportsParallelToolCalls,
      reasoningEfforts,
      maxOutputTokens,
    };

    models.push({
      id,
      displayName: `${displayName} (Zed)`,
      maxOutputTokens,
      capabilities: { images: supportsImages },
      privateData: metadata as unknown as JsonValue,
    });
  }

  const defaultModel = text(root?.default_model);
  const recommended = new Set<string>(
    Array.isArray(root?.recommended_models)
      ? root.recommended_models.map((item) => text(item)).filter((item): item is string => !!item)
      : [],
  );

  if (defaultModel || recommended.size > 0) {
    models.sort((left, right) => {
      const leftRank = left.id === defaultModel ? 2 : recommended.has(left.id) ? 1 : 0;
      const rightRank = right.id === defaultModel ? 2 : recommended.has(right.id) ? 1 : 0;
      return rightRank - leftRank;
    });
  }

  return models;
}

export function extractModelMetadata(model: ModelSnapshot): ZedModelMetadata {
  const data = object(model.privateData);
  const provider = inferUpstreamProvider(model.id, data?.provider);
  const reasoningEfforts = Array.isArray(data?.reasoningEfforts)
    ? data.reasoningEfforts.filter((item): item is string => typeof item === "string")
    : [];
  const maxOutputTokens = positiveInteger(data?.maxOutputTokens) ?? 16_384;
  return {
    provider,
    supportsThinking: data?.supportsThinking === true ||
      model.id.includes("opus") ||
      model.id.includes("sonnet-4") ||
      model.id.startsWith("gpt-5"),
    supportsDisablingThinking: data?.supportsDisablingThinking !== false,
    supportsFastMode: data?.supportsFastMode === true,
    supportsParallelToolCalls: data?.supportsParallelToolCalls !== false,
    reasoningEfforts,
    maxOutputTokens,
  };
}

export const zedModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) {
      throw new Error("Add a Zed account before syncing Zed models");
    }
    const data = accountData(resource);
    const { llmToken } = await ensureLlmToken(data, context.network);

    let response = await context.network.fetch(`${ZED_CLOUD_BASE_URL}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${llmToken}`,
        accept: "application/json",
        "x-zed-client-supports-x-ai": "true",
        [ZED_VERSION_HEADER]: ZED_VERSION,
      },
    });

    if (
      response.status === 401 ||
      response.headers["x-zed-expired-token"] !== undefined ||
      response.headers["x-zed-outdated-token"] !== undefined
    ) {
      const refreshed = await ensureLlmToken(data, context.network, true);
      response = await context.network.fetch(`${ZED_CLOUD_BASE_URL}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${refreshed.llmToken}`,
          accept: "application/json",
          "x-zed-client-supports-x-ai": "true",
          [ZED_VERSION_HEADER]: ZED_VERSION,
        },
      });
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Zed model discovery failed (HTTP ${response.status}): ${response.body}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(response.body) as JsonValue;
    } catch {
      throw new Error("Zed model discovery returned invalid JSON");
    }

    const models = parseZedModels(body);
    if (models.length === 0) {
      throw new Error("Zed model discovery returned no supported models");
    }
    return models;
  },
};
