//! Lists calls newest first, one compact row each, expanding a row in place into its details.
import { useState, type KeyboardEvent } from "react";
import type { LlmCall } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { chevronRightIcon, providerIcon } from "../../shared/ui/icons";
import { modelLogo } from "../../shared/utils/brandIcons";
import { CallDetails } from "./CallDetails";
import { TokenBar } from "./TokenBar";
import { agentLabel, compactTokens, duration, isFailed, outputSpeed, tokenTotal } from "./tokenParts";
import { callTokens } from "./callMetrics";
import styles from "./CallList.module.scss";

const PAGE_SIZE = 50;

function when(ms: number) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time.slice(0, 5)}`;
}

const count = (value: number | null) => value ? compactTokens(value) : "—";

export function CallList({ calls, dark }: { calls: LlmCall[]; dark: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const visible = calls.slice(0, shown);
  // Scale every bar by the largest call overall so loading more keeps existing bars unchanged.
  const scale = Math.max(0, ...calls.map(tokenTotal));

  if (calls.length === 0) return <Card className={styles.card}><div className={styles.empty}>{t("暂无调用记录")}</div></Card>;

  return <Card className={styles.card}>
    <div className={styles.list} role="list">
      <div className={[styles.grid, styles.header].join(" ")} aria-hidden>
        <span />
        <span>{t("时间")}</span>
        <span>{t("代理")}</span>
        <span>{t("模型")}</span>
        <span className={styles.barColumn}>{t("Token 构成")}</span>
        <span className={[styles.number, styles.mid].join(" ")}>{t("输入")}</span>
        <span className={[styles.number, styles.mid].join(" ")}>{t("缓存读取")}</span>
        <span className={[styles.number, styles.mid].join(" ")}>{t("输出")}</span>
        <span className={[styles.number, styles.wide].join(" ")}>{t("首字")}</span>
        <span className={styles.number}>{t("耗时")}</span>
        <span className={[styles.number, styles.wide].join(" ")}>{t("速度")}</span>
        <span />
        <span className={styles.number}>{t("合计")}</span>
      </div>
      {visible.map(call => <CallRow key={call.call_id} call={call} scale={scale} dark={dark}
        open={open === call.call_id} onToggle={() => setOpen(current => current === call.call_id ? null : call.call_id)} />)}
    </div>
    {shown < calls.length && <button type="button" className={styles.more} onClick={() => setShown(value => value + PAGE_SIZE)}>
      {t("显示更早的 {count} 条", { count: calls.length - shown })}
    </button>}
  </Card>;
}

function CallRow({ call, scale, dark, open, onToggle }: { call: LlmCall; scale: number; dark: boolean; open: boolean; onToggle: () => void }) {
  const failed = isFailed(call);
  const running = call.status === "running";
  const tokens = callTokens(call);
  const speed = outputSpeed(call);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };
  const bar = <TokenBar call={call} scale={scale} dark={dark} />;
  return <div role="listitem" className={[styles.item, open && styles.open].filter(Boolean).join(" ")}>
    <div role="button" tabIndex={0} aria-expanded={open} className={[styles.grid, styles.row].join(" ")} onClick={onToggle} onKeyDown={onKeyDown}>
      <span className={styles.lead}>
        {running ? <span className={styles.pulse} /> : <Icon icon={chevronRightIcon} size="1em" className={styles.chevron} />}
      </span>
      <span className={styles.muted}>{when(call.created_at_ms)}</span>
      <span><span className={[styles.tag, call.run_kind === "subagent" && styles.subagent].filter(Boolean).join(" ")}>{agentLabel(call)}</span></span>
      <span className={styles.model}>
        <span className={styles.modelLine} title={call.model_id}>
          <Icon className={styles.modelLogo} mask={modelLogo({ model_id: call.model_id, base_url: call.provider_url })} icon={providerIcon} size="1em" />
          <span className={styles.modelName}>{call.display_name}</span>
          {call.route === "cursor_official" && <span className={styles.route}>{t("Cursor 官方")}</span>}
          <span className={styles.faint}>{call.conversation_id.slice(0, 8)}</span>
        </span>
        <span className={styles.inlineBar}>{bar}</span>
      </span>
      <span className={styles.barColumn}>{bar}</span>
      <span className={[styles.number, styles.mid].join(" ")}>{count(tokens.input)}</span>
      <span className={[styles.number, styles.mid].join(" ")}>{count(tokens.read)}</span>
      <span className={[styles.number, styles.mid].join(" ")}>{count(tokens.output)}</span>
      <span className={[styles.number, styles.wide].join(" ")}>{duration(call.ttft_ms)}</span>
      <span className={styles.number}>{duration(call.duration_ms)}</span>
      <span className={[styles.number, styles.wide].join(" ")}>{speed === null ? "—" : speed.toFixed(0)}</span>
      <span className={styles.mark}>
        {failed && <TooltipTrigger label={[call.http_status && `HTTP ${call.http_status}`, call.error_kind, call.error_message].filter(Boolean).join("\n") || call.status}>
          <span className={styles.errorDot} role="img" aria-label={t("失败")} />
        </TooltipTrigger>}
      </span>
      <span className={[styles.number, styles.total].join(" ")}>{count(tokenTotal(call))}</span>
    </div>
    {open && <CallDetails call={call} dark={dark} />}
  </div>;
}
