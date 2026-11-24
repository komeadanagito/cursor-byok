//! Derives the providers the Cursor page lists from configured models: manual ones by supplier name, plugin ones by plugin.
import type { Model, ModelType, PluginModelDescriptor } from "../../shared/api";
import { modelBrand, providerBrand } from "../../shared/utils/modelBrand.ts";
import { modelProviderName } from "../../shared/utils/modelProvider.ts";
import type { CursorModelTestState } from "./CursorModelTestResult";

export const MAGPIE_PROVIDER = "magpie";

export type ManualProvider = {
  kind: "manual";
  key: string;
  name: string;
  host: string;
  brand: string | null;
  types: ModelType[];
  models: Model[];
};

export type PluginProvider = {
  kind: "plugin";
  key: string;
  name: string;
  iconSrc: string;
  models: PluginModelDescriptor[];
};

export type CursorProvider = ManualProvider | PluginProvider;

export type ProviderStatus = "ready" | "failed" | "idle" | "off";

/** Manual models grouped by supplier name, in the order their first model appears; Magpie's are listed on their own. */
export function manualProviders(models: Model[]): ManualProvider[] {
  const providers = new Map<string, ManualProvider>();
  for (const model of models) {
    if (model.gateway_capabilities) continue;
    const name = modelProviderName(model);
    const provider = providers.get(name);
    if (provider) {
      provider.models.push(model);
      if (!provider.types.includes(model.type)) provider.types.push(model.type);
      continue;
    }
    providers.set(name, { kind: "manual", key: `manual:${name}`, name, host: hostOf(model.base_url), brand: null, types: [model.type], models: [model] });
  }
  for (const provider of providers.values()) {
    const model = provider.models[0];
    const brand = providerBrand(model.base_url);
    if (!model.group_name?.trim()) {
      if (brand === "openai") {
        provider.name = provider.name === "chatgpt.com" || provider.name.endsWith(".chatgpt.com") ? "ChatGPT" : "OpenAI";
      }
      if (brand === "claude") provider.name = "Claude";
    }
    // A relay of no maker's shows its models' maker when they all share one.
    const makers = new Set(provider.models.map(model => modelBrand(model.model_id)));
    provider.brand = brand ?? (makers.size === 1 ? [...makers][0] : null);
  }
  return [...providers.values()];
}

export function pluginProviders(models: PluginModelDescriptor[]): PluginProvider[] {
  const providers = new Map<string, PluginProvider>();
  for (const model of models) {
    const provider = providers.get(model.pluginId);
    if (provider) provider.models.push(model);
    else providers.set(model.pluginId, { kind: "plugin", key: `plugin:${model.pluginId}`, name: model.pluginName, iconSrc: model.icon, models: [model] });
  }
  return [...providers.values()];
}

/** Failed when any model's last test failed; ready once one passed and none failed. */
export function testStatus(ids: string[], results: Map<string, CursorModelTestState>): ProviderStatus {
  const states = ids.map(id => results.get(id)?.status);
  if (states.includes("error")) return "failed";
  return states.includes("success") ? "ready" : "idle";
}

/** [subset] reordered inside the full manual order: the subset keeps the slots it held, in its new order. */
export function mergeOrder(all: string[], subset: string[]): string[] {
  const members = new Set(subset);
  const queue = [...subset];
  return all.map(hash => members.has(hash) ? queue.shift()! : hash);
}

function hostOf(baseUrl: string) {
  const value = baseUrl.trim();
  try { return new URL(value).host; } catch { return value; }
}
