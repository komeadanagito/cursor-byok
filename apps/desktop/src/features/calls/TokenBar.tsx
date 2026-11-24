//! Draws one call's token parts as a stacked bar scaled against the largest call.
import type { LlmCall } from "../../shared/api";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { compactTokens, tokenColors, tokenLabel, tokenParts } from "./tokenParts";
import styles from "./TokenBar.module.scss";

export function TokenBar({ call, scale, dark, thick = false }: { call: LlmCall; scale: number; dark: boolean; thick?: boolean }) {
  const parts = tokenParts(call).filter(({ value }) => value > 0);
  const total = parts.reduce((sum, { value }) => sum + value, 0);
  if (total === 0) return <div className={styles.track} />;
  const colors = tokenColors(dark);
  const label = parts.map(({ part, value }) =>
    `${tokenLabel(part)}  ${value.toLocaleString()}  ${Math.round(value / total * 100)}%`).join("\n");
  return <TooltipTrigger label={`${label}\n${t("合计")}  ${compactTokens(total)}`}>
    <div className={[styles.track, thick && styles.thick].filter(Boolean).join(" ")} role="img" aria-label={label}>
      <div className={styles.fill} style={{ width: `${Math.max(2, total / Math.max(scale, total) * 100)}%` }}>
        {parts.map(({ part, value }) => <span key={part} style={{ flexGrow: value, background: colors[part] }} />)}
      </div>
    </div>
  </TooltipTrigger>;
}
