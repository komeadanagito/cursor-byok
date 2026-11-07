import type { JsonValue } from "cursor-byok:plugin";
import type { PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { credentialData } from "./resources.ts";
import { zcodeRequestHeaders } from "./headers.ts";

const MODEL_CAPABILITY_IMAGES = "images";
const DEFAULT_MAX_OUTPUT_TOKENS = 131_072;

type RawModel = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  images: boolean;
};

const FALLBACK_MODELS: RawModel[] = [
  { id: "glm-5.3", displayName: "GLM-5.3", images: false },
  { id: "glm-5.3-flash", displayName: "GLM-5.3 Flash", images: false },
  { id: "glm-5.2", displayName: "GLM-5.2", images: false },
  { id: "glm-5.1", displayName: "GLM-5.1", images: false },
  { id: "glm-5", displayName: "GLM-5", images: false },
  { id: "glm-4.7", displayName: "GLM-4.7", images: false },
  { id: "glm-4.6", displayName: "GLM-4.6", images: false },
];

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

function boolean(value: unknown): boolean {
  return value === true;
}

export function zcodeModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function zcodeChatUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export function parseModelsResponse(body: unknown): ModelDefinition[] {
  const root = record(body);
  const source = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
    ? root.models
    : null;
  if (!source) {
    throw new Error("ZCode model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const item of source) {
    const raw = typeof item === "string" ? { id: item } : record(item);
    if (!raw) continue;
    const id = text(raw.id ?? raw.model ?? raw.slug ?? raw.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = text(raw.display_name ?? raw.displayName ?? raw.name ?? raw.title) ?? id;
    const description = text(raw.description);
    const maxOutputTokens = positiveInteger(
      raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.max_completion_tokens,
    );
    const capabilities = record(raw.capabilities);
    const images = boolean(raw.supports_vision ?? raw.supportsVision) ||
      boolean(capabilities?.[MODEL_CAPABILITY_IMAGES]);
    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { images },
    });
  }
  return models;
}

function fallbackModels(): ModelDefinition[] {
  return FALLBACK_MODELS.map((model) => ({
    ...model,
    maxOutputTokens: 131_072,
    capabilities: { images: model.images },
  }));
}

export const zcodeModels: ModelSupport = {
  list: async ({ resource }, context: PluginContext): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a ZCode credential before syncing models");
    const data = credentialData(resource);
    const response = await context.network.fetch(zcodeModelsUrl(data.baseUrl), {
      method: "GET",
      headers: zcodeRequestHeaders({
        accept: "application/json",
        authorization: `Bearer ${data.apiKey}`,
      }, data),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`ZCode API key was rejected (HTTP ${response.status})`);
    }
    if (response.status === 404 || response.status === 405) {
      return fallbackModels();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ZCode model discovery failed (HTTP ${response.status}): ${response.body}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body) as JsonValue;
    } catch {
      throw new Error("ZCode model discovery returned invalid JSON");
    }
    const models = parseModelsResponse(body);
    return models.length > 0 ? models : fallbackModels();
  },
};
