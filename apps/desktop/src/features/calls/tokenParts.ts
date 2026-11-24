//! Orders, names and colors the token parts shared by the call chart, row bars and details.
import type { LlmCall } from "../../shared/api";
import { callTokens } from "./callMetrics";

export type TokenPart = "read" | "input" | "write" | "output";

// Validated with the dataviz palette checks against both theme surfaces;
// the order is the stacking order, so adjacent pairs stay distinguishable.
const COLORS: Record<"dark" | "light", Record<TokenPart, string>> = {
  dark: { read: "#2E9E72", input: "#3F86D8", write: "#B0679E", output: "#BD8128" },
  light: { read: "#1F9A6B", input: "#2F74C8", write: "#A8558F", output: "#C08020" },
};

export const tokenColors = (dark: boolean) => COLORS[dark ? "dark" : "light"];

export function tokenLabel(part: TokenPart) {
  switch (part) {
    case "read": return t("缓存读取");
    case "input": return t("非缓存输入");
    case "write": return t("缓存写入");
    case "output": return t("输出");
  }
}

export function tokenParts(call: LlmCall): Array<{ part: TokenPart; value: number }> {
  const tokens = callTokens(call);
  return [
    { part: "read", value: tokens.read },
    { part: "input", value: tokens.input ?? 0 },
    { part: "write", value: tokens.write },
    { part: "output", value: tokens.output ?? 0 },
  ];
}

export const tokenTotal = (call: LlmCall) => tokenParts(call).reduce((total, { value }) => total + value, 0);

export function compactTokens(value: number) {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

export function duration(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function outputSpeed(call: LlmCall) {
  const { output_tokens: output, duration_ms: total, ttft_ms: first } = call;
  return output !== null && total !== null && first !== null && total > first ? output * 1_000 / (total - first) : null;
}

export const isFailed = (call: LlmCall) => call.status === "failed" || call.status === "error";

export function agentLabel(call: LlmCall) {
  if (call.run_kind === "subagent") return call.subagent_kind || t("子代理");
  return call.run_kind === "root" ? t("主代理") : t("未记录代理");
}
