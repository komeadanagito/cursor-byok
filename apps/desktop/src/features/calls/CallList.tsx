//! Tool-style dense call inspector list: clear columns at desktop window width, expandable in place.
import { useState, type KeyboardEvent } from "react";
import type { LlmCall } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { chevronRightIcon, eyeIcon } from "../../shared/ui/icons";
import { CallDetails } from "./CallDetails";
import { TokenBar } from "./TokenBar";
import { agentLabel, compactTokens, duration, isFailed, outputSpeed, tokenTotal } from "./tokenParts";
import { callTokens } from "./callMetrics";
import styles from "./CallList.module.scss";

const PAGE_SIZE = 50;

function formatTime(ms: number) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time.slice(0, 5)}`;
}

export function CallList({ calls, dark, onOpenExternal }: {
  calls: LlmCall[];
  dark: boolean;
  onOpenExternal: (call: LlmCall) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const visible = calls.slice(0, shown);
  const scale = Math.max(1, ...calls.map(tokenTotal));

  if (calls.length === 0) {
    return <Card className={styles.card}><div className={styles.empty}>{t("暂无调用记录")}</div></Card>;
  }

  return <Card className={styles.card}>
    <div className={styles.list} role="list">
      <div className={[styles.grid, styles.header].join(" ")} aria-hidden>
        <span />
        <span>{t("时间")}</span>
        <span>{t("模型 / 代理")}</span>
        <span>{t("Token 构成")}</span>
        <span className={styles.right}>{t("耗时 / 首字")}</span>
        <span className={[styles.right, styles.speedCol].join(" ")}>{t("速度")}</span>
        <span />
      </div>
      {visible.map((call) => <CallRow
        key={call.call_id}
        call={call}
        scale={scale}
        dark={dark}
        open={openId === call.call_id}
        onToggle={() => setOpenId((current) => current === call.call_id ? null : call.call_id)}
        onOpenExternal={() => onOpenExternal(call)}
      />)}
    </div>
    {shown < calls.length && <button type="button" className={styles.more} onClick={() => setShown((value) => value + PAGE_SIZE)}>
      {t("显示更早的 {count} 条", { count: calls.length - shown })}
    </button>}
  </Card>;
}

function CallRow({ call, scale, dark, open, onToggle, onOpenExternal }: {
  call: LlmCall;
  scale: number;
  dark: boolean;
  open: boolean;
  onToggle: () => void;
  onOpenExternal: () => void;
}) {
  const failed = isFailed(call);
  const running = call.status === "running";
  const tokens = callTokens(call);
  const total = tokenTotal(call);
  const speed = outputSpeed(call);
  const agent = agentLabel(call);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  const tokenSummary = total > 0
    ? t("入 {input} · 缓 {read} · 出 {output}", {
      input: compactTokens(tokens.input ?? 0),
      read: compactTokens(tokens.read ?? 0),
      output: compactTokens(tokens.output ?? 0),
    })
    : "—";

  return <div role="listitem" className={[styles.item, open && styles.open].filter(Boolean).join(" ")}>
    <div role="button" tabIndex={0} aria-expanded={open} className={[styles.grid, styles.row].join(" ")} onClick={onToggle} onKeyDown={onKeyDown}>
      <span className={styles.lead}>
        <Icon icon={chevronRightIcon} size="0.95em" className={styles.chevron} />
        <span
          className={[styles.dot, failed && styles.dotFailed, running && styles.dotRunning].filter(Boolean).join(" ")}
          title={failed ? ([call.http_status && `HTTP ${call.http_status}`, call.error_kind, call.error_message].filter(Boolean).join(" · ") || call.status) : call.status}
        />
      </span>
      <span className={styles.time}>{formatTime(call.created_at_ms)}</span>
      <span className={styles.modelCell}>
        <span className={styles.modelTop} title={call.model_id}>
          <span className={styles.modelName}>{call.display_name}</span>
          {call.route === "cursor_official" && <span className={`${styles.badge} ${styles.badgeOfficial}`}>{t("官方")}</span>}
        </span>
        <span className={styles.modelMeta}>
          {agent && <span className={[styles.badge, call.run_kind === "subagent" && styles.badgeSubagent].filter(Boolean).join(" ")}>{agent}</span>}
          {call.conversation_id && <span className={styles.convId}>{call.conversation_id.slice(0, 8)}</span>}
        </span>
      </span>
      <span className={styles.tokenCell} title={tokenSummary}>
        <span className={styles.tokenTop}>
          <span className={styles.tokenTotal}>{total > 0 ? compactTokens(total) : "—"}</span>
          <span className={styles.tokenSub}>{(tokens.read ?? 0) > 0 ? `${t("缓")} ${compactTokens(tokens.read ?? 0)}` : (tokens.output ?? 0) > 0 ? `${t("出")} ${compactTokens(tokens.output ?? 0)}` : ""}</span>
        </span>
        <TokenBar call={call} scale={scale} dark={dark} />
      </span>
      <span className={styles.metricCell}>
        <span className={styles.metricMain}>{duration(call.duration_ms)}</span>
        <span className={styles.metricSub}>{call.ttft_ms != null ? `TTFT ${duration(call.ttft_ms)}` : "—"}</span>
      </span>
      <span className={[styles.metricCell, styles.speedCol].join(" ")}>
        {failed
          ? <span className={styles.metricError}>{call.http_status ? `HTTP ${call.http_status}` : t("失败")}</span>
          : <span className={styles.metricMain}>{speed === null ? "—" : `${speed.toFixed(0)} tok/s`}</span>}
      </span>
      <span>
        <TooltipTrigger label={t("在新窗口查看详情")}>
          <button
            type="button"
            className={styles.openBtn}
            aria-label={t("在新窗口查看详情")}
            onClick={(event) => { event.stopPropagation(); onOpenExternal(); }}
          >
            <Icon icon={eyeIcon} size="1.05em" />
          </button>
        </TooltipTrigger>
      </span>
    </div>
    {open && <div className={styles.detailsWrap}><CallDetails call={call} dark={dark} /></div>}
  </div>;
}
