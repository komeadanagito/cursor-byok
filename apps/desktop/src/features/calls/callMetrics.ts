//! Computes call statistics using reported input and cache usage.
import type { LlmCall } from "../../shared/api";

type Counts = Pick<LlmCall, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "request_type" | "usage">;

export function callTokens(call: Counts) {
  const read = call.cache_read_tokens ?? 0;
  const write = call.cache_write_tokens ?? 0;
  const reported = call.input_tokens;
  const totalInput = call.usage?.context_input_tokens ?? (reported === null ? null :
    call.request_type === "anthropic" ? reported + read + write : Math.max(reported, read + write));
  return { read, write, input: totalInput === null ? null : Math.max(0, totalInput - read - write), totalInput, output: call.output_tokens };
}

export function cacheMetrics(calls: Counts[]) {
  let hits = 0;
  let reported = 0;
  let read = 0;
  let input = 0;
  for (const call of calls) {
    const tokens = callTokens(call);
    if (call.cache_read_tokens !== null) {
      reported++;
      if (tokens.read > 0) hits++;
      if (tokens.totalInput !== null) {
        read += tokens.read;
        input += tokens.totalInput;
      }
    }
  }
  return { hits, reported, read, input };
}

export function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
