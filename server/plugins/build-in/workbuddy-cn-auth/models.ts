//! WorkBuddy CN 模型同步：以本机客户端的完整模型表为骨架，
//! 从模型网关 GET /v1/models 拉取到的模型覆盖/追加，保证始终展示完整列表。
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { authorizedGatewayHeaders } from "./headers.ts";
import { accountData } from "./resources.ts";

const DEFAULT_MAX_OUTPUT_TOKENS = 131_072;

type RawModel = {
  id: string;
  displayName: string;
  images: boolean;
  description?: string;
};

/**
 * WorkBuddy CN 桌面客户端的完整模型目录。
 * id 为 /v2/chat/completions 接受的值，取自本机 CodeBuddy 客户端实际配置。
 * 网关的 /v1/models 端点并非所有环境都返回完整列表，因此以本表为骨架兜底。
 */
const FALLBACK_MODELS: RawModel[] = [
  {
    id: "hy4-preview",
    displayName: "Hy4",
    images: true,
    description: "腾讯混元 Hy4（限时免费车道，0x 倍率）",
  },
  { id: "hy3", displayName: "Hy3", images: false, description: "腾讯混元 Hy3" },
  { id: "hy3-x", displayName: "Hy3", images: false, description: "腾讯混元 Hy3（高速通道）" },
  { id: "step-5-preview", displayName: "Step-5-Preview", images: false },
  { id: "space-bunny", displayName: "Space-Bunny", images: false },
  {
    id: "deepseek-v4.1-flash",
    displayName: "DeepSeek-V4.1-Flash",
    images: true,
    description: "夜间折扣 · 0.11x",
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek-V4-Pro",
    images: false,
    description: "夜间折扣 · 0.51x",
  },
  { id: "glm-5.3", displayName: "GLM-5.3", images: false, description: "订阅优先 · 0.69x" },
  {
    id: "glm-5.3-flash",
    displayName: "GLM-5.3-Flash",
    images: false,
    description: "订阅优先 · 0.08x",
  },
  { id: "glm-5.2", displayName: "GLM-5.2", images: false, description: "夜间折扣 · 0.79x" },
  { id: "glm-5.1", displayName: "GLM-5.1", images: false },
  { id: "kimi-k3-1", displayName: "Kimi-K3", images: false, description: "Kimi K3 · 1.62x" },
  {
    id: "kimi-k2.8-preview",
    displayName: "Kimi-K2.8-Preview",
    images: false,
    description: "0.77x",
  },
  { id: "minimax-m3", displayName: "MiniMax-M3", images: false },
  {
    id: "minimax-m3.1-flash",
    displayName: "MiniMax-M3.1-Flash",
    images: false,
    description: "0.08x",
  },
  { id: "mimo-v2.6-pro", displayName: "Xiaomi MiMo-V2.6-Pro", images: false, description: "0.13x" },
];

function toDefinition(model: RawModel): ModelDefinition {
  return {
    id: model.id,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    capabilities: { images: model.images },
  };
}

function record(value: unknown): Record<string, unknown> | null {
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

export function modelsUrl(gatewayBase: string): string {
  return `${gatewayBase.replace(/\/+$/, "")}/v1/models`;
}

export function chatUrl(gatewayBase: string): string {
  return `${gatewayBase.replace(/\/+$/, "")}/v2/chat/completions`;
}

/** 把网关响应解析为 ModelDefinition 列表。 */
export function parseModelsResponse(body: unknown): ModelDefinition[] {
  const root = record(body);
  const source = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
    ? root.models
    : null;
  if (!source) throw new Error("WorkBuddy 模型发现响应不包含模型列表");
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const item of source) {
    const raw = typeof item === "string" ? { id: item } : record(item);
    if (!raw) continue;
    const id = text(raw.id ?? raw.model ?? raw.slug ?? raw.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const capabilities = record(raw.capabilities);
    const images = raw.supports_vision === true || raw.supportsVision === true ||
      capabilities?.images === true;
    models.push({
      id,
      displayName: text(raw.display_name ?? raw.displayName ?? raw.name ?? raw.title) ?? id,
      ...(text(raw.description) ? { description: text(raw.description)! } : {}),
      maxOutputTokens: positiveInteger(
        raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.max_completion_tokens,
      ) ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { images },
    });
  }
  return models;
}

/**
 * 合并策略：以完整静态表为骨架，API 返回的同 id 模型覆盖其展示字段，
 * API 独有的模型追加到列表。这样无论网关返回多少模型，用户都能看到完整目录。
 */
export function mergeModels(
  remote: ModelDefinition[],
  fallback: ModelDefinition[],
): ModelDefinition[] {
  const byId = new Map<string, ModelDefinition>();
  for (const model of fallback) byId.set(model.id, { ...model });
  for (const model of remote) {
    const base = byId.get(model.id);
    byId.set(model.id, {
      id: model.id,
      displayName: base?.displayName ?? model.displayName,
      ...(model.description ?? base?.description
        ? { description: model.description ?? base!.description }
        : {}),
      maxOutputTokens: model.maxOutputTokens ?? base?.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        images: model.capabilities?.images ?? base?.capabilities?.images ?? false,
      },
    });
  }
  return [...byId.values()];
}

export function fallbackModels(): ModelDefinition[] {
  return FALLBACK_MODELS.map(toDefinition);
}

export const workbuddyModels: ModelSupport = {
  list: async ({ resource }, context: PluginContext): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("请先添加 WorkBuddy CN 凭证后再同步模型");
    const data = accountData(resource);
    const baseline = fallbackModels();
    try {
      const response = await context.network.fetch(modelsUrl(data.gatewayBase), {
        method: "GET",
        headers: authorizedGatewayHeaders(data.accessToken, data.gatewayBase),
      });
      if (response.status === 401 || response.status === 403) {
        // 凭证被拒时仍返回完整静态表，避免模型目录被清空；调用时会有明确的鉴权错误。
        return baseline;
      }
      if (response.status < 200 || response.status >= 300) return baseline;
      let body: unknown;
      try {
        body = JSON.parse(response.body) as JsonValue;
      } catch {
        return baseline;
      }
      const remote = parseModelsResponse(body);
      return remote.length > 0 ? mergeModels(remote, baseline) : baseline;
    } catch {
      // 网络异常同样回落完整静态表。
      return baseline;
    }
  },
};
