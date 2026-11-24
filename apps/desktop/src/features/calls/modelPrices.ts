//! Computes per-model call costs from per-million prices; mirrors the server overview cost rules.
import type { LlmCall, ModelPrice } from "../../shared/api";

const MILLION = 1_000_000;

/**
 * Fresh input tokens per call: Anthropic reports input_tokens excluding cache,
 * OpenAI reports input_tokens containing cache traffic — same rule as the server.
 */
export function freshInput(call: Pick<LlmCall, "request_type" | "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): number {
  const input = call.input_tokens ?? 0;
  const read = call.cache_read_tokens ?? 0;
  const write = call.cache_write_tokens ?? 0;
  return call.request_type === "anthropic" ? Math.max(0, input) : Math.max(0, input - read - write);
}

/** NULL cache prices bill at the input rate. */
export function callCost(
  call: Pick<LlmCall, "request_type" | "input_tokens" | "cache_read_tokens" | "cache_write_tokens" | "output_tokens">,
  price: ModelPrice,
): number {
  const cacheReadRate = price.cache_read_per_million ?? price.input_per_million;
  const cacheWriteRate = price.cache_write_per_million ?? price.input_per_million;
  return (
    freshInput(call) * price.input_per_million +
    (call.cache_read_tokens ?? 0) * cacheReadRate +
    (call.cache_write_tokens ?? 0) * cacheWriteRate +
    (call.output_tokens ?? 0) * price.output_per_million
  ) / MILLION;
}

/** Cost of the currently listed calls for one (provider_url, model_id); null when unpriced. */
export function periodCost(
  calls: Pick<LlmCall, "provider_url" | "model_id" | "request_type" | "input_tokens" | "cache_read_tokens" | "cache_write_tokens" | "output_tokens">[],
  providerUrl: string,
  modelId: string,
  price: ModelPrice | null,
): number | null {
  if (!price) return null;
  return calls
    .filter((call) => call.provider_url === providerUrl && call.model_id === modelId)
    .reduce((total, call) => total + callCost(call, price), 0);
}

/** A price draft is complete once input and output hold non-negative numbers. */
export function parseRate(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
