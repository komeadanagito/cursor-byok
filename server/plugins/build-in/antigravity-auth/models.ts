import type { JsonValue } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
/**
 * CloudCode 按客户端版本裁剪模型目录:低于 2.16 的 UA 拿不到 Gemini 4 Argon。
 * 升级 UA 后 fetchAvailableModels 才会返回 gemini-4-argon-*。
 */
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.18.0 (aidev_client; os_type=darwin; arch=arm64; cl=975423596)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

/**
 * 只对外暴露 Gemini 4 Argon(Medium)、Gemini 3.8 Flash(Medium)、Claude Opus 5.5(Medium)、
 * Claude Sonnet 5.5(Medium) 与 GPT-OSS 120B(Medium);其余当前在售型号(High/Low、Tiered、
 * 更老的 2.x/3.1/3.5、tab 预览等)一律隐藏。新发布的型号不在本表内,会自动出现在目录里。
 */
const ANTIGRAVITY_HIDDEN_MODELS = new Set([
  "chat_20706",
  "chat_23310",
  "gemini-4-argon-high",
  "gemini-4-argon-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-tiered",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image",
  "gemini-3-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "claude-opus-5-5-high",
  "claude-opus-5-5-low",
  "claude-sonnet-5-5-high",
  "claude-sonnet-5-5-low",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

export const STATIC_ANTIGRAVITY_MODELS: ModelDefinition[] = [
  {
    id: "gemini-4-argon-medium",
    displayName: "Gemini 4 Argon (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
    privateData: { reasoningEfforts: ["low", "medium", "high"] },
  },
  {
    id: "gemini-3.8-flash-medium",
    displayName: "Gemini 3.8 Flash (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
    privateData: { reasoningEfforts: ["low", "medium", "high"] },
  },
  {
    id: "claude-opus-5-5-medium",
    displayName: "Claude Opus 5.5 (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
    privateData: { reasoningEfforts: ["low", "medium", "high"] },
  },
  {
    id: "claude-sonnet-5-5-medium",
    displayName: "Claude Sonnet 5.5 (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
    privateData: { reasoningEfforts: ["low", "medium", "high"] },
  },
  {
    id: "gpt-oss-120b-medium",
    displayName: "GPT-OSS 120B (Medium)",
    capabilities: { images: false },
    maxOutputTokens: 32768,
    privateData: { reasoningEfforts: [] },
  },
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const rawModels = object(root?.models);
  if (!rawModels) return [];

  const models: ModelDefinition[] = [];
  const seen = new Set<string>();

  for (const [modelId, raw] of Object.entries(rawModels)) {
    if (ANTIGRAVITY_HIDDEN_MODELS.has(modelId)) continue;
    const model = object(raw);
    if (!model) continue;

    const id = modelId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName = text(model.displayName) ?? id;
    const supportsThinking = model.supportsThinking === true;
    const reasoningEfforts = supportsThinking ? ["low", "medium", "high"] : [];
    const maxOutputTokens = typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : 65_536;

    models.push({
      id,
      displayName,
      capabilities: {
        images: model.supportsImages === true || id.includes("gemini") || id.includes("claude"),
      },
      maxOutputTokens,
      privateData: { reasoningEfforts },
    });
  }

  // 动态目录是权威来源:静态表只在探测失败时兜底,合并会把已下线模型带进目录。
  return models;
}

export function reasoningEfforts(model: ModelSnapshot): string[] {
  const data = object(model.privateData);
  const efforts = data?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
}

export const antigravityModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) return STATIC_ANTIGRAVITY_MODELS;
    let data;
    try {
      data = accountData(resource);
    } catch {
      return STATIC_ANTIGRAVITY_MODELS;
    }

    const payloads = [
      JSON.stringify({ project: data.projectId || "bamboo-precept-lgxtn" }),
      JSON.stringify({}),
    ];

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      for (const bodyPayload of payloads) {
        try {
          const response = await context.network.fetch(
            `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${data.accessToken}`,
                "content-type": "application/json",
                "user-agent": ANTIGRAVITY_USER_AGENT,
                ...ANTIGRAVITY_CLIENT_HEADERS,
              },
              body: bodyPayload,
            },
          );
          if (response.status >= 200 && response.status < 300) {
            const body = JSON.parse(response.body);
            const models = parseAntigravityModels(body);
            if (models.length > 0) return models;
          }
        } catch {
          // Continue
        }
      }
    }

    return STATIC_ANTIGRAVITY_MODELS;
  },
};
