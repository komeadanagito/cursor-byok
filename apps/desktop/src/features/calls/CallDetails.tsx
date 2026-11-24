//! Expands one call in place: its facts, token makeup, and the recorded request and response.
import { useEffect, useState } from "react";
import { api, type CallDetail, type LlmCall } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { JsonEditor, formatStructuredText } from "../../shared/ui/JsonEditor";
import { copyIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { TokenBar } from "./TokenBar";
import { agentLabel, duration, isFailed, outputSpeed, tokenColors, tokenLabel, tokenParts, tokenTotal } from "./tokenParts";
import styles from "./CallDetails.module.scss";

type Preview = "headers" | "body" | "response" | "trace";

const joined = (...parts: Array<string | number | null | undefined | false>) =>
  parts.filter(part => part !== null && part !== undefined && part !== false && part !== "").join(" · ");
const grouped = (value: number | null) => value === null ? null : value.toLocaleString();
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(2)} MB`;

export function CallDetails({ call, dark }: { call: LlmCall; dark: boolean }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetch when a running call settles so its recorded response is complete.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api.call(call.call_id).then(value => { if (!cancelled) setDetail(value); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [call.call_id, call.status]);

  const speed = outputSpeed(call);
  const facts: Array<[string, string | null, boolean?]> = [
    [t("时间"), new Date(call.created_at_ms).toLocaleString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false })],
    [t("状态"), joined(call.status, call.finish_reason, call.http_status && `HTTP ${call.http_status}`)],
    [t("模型"), call.display_name === call.model_id ? call.model_id : `${call.display_name} → ${call.model_id}`],
    [t("思考强度"), joined(call.reasoning_effort, call.fast && "fast")],
    [t("上游"), joined(call.provider_type, call.provider_url)],
    [t("最终请求"), joined(call.request_type, call.request_url)],
    [t("路由"), call.route === "cursor_official" ? t("Cursor 官方") : "BYOK"],
    [t("代理"), agentLabel(call)],
    [t("会话"), call.conversation_id],
    [t("运行"), joined(call.run_id, `#${call.provider_call_index}`)],
    ["TTFB / TTFR", joined(duration(call.ttfb_ms), duration(call.ttfr_ms))],
    [t("首字 / 耗时"), joined(duration(call.ttft_ms), duration(call.duration_ms))],
    [t("输出速度"), speed === null ? null : `${speed.toFixed(1)} tok/s`],
    [t("推理 Token"), grouped(call.reasoning_tokens)],
    [t("消息 / 工具"), t("{messages} 条消息 · {tools} 个工具定义 · 发起 {launched} 次", {
      messages: call.message_count, tools: call.tool_count, launched: call.launched_tool_count ?? "—" })],
    ["Call ID", call.call_id],
    [t("错误"), joined(call.error_kind, call.error_message), true],
  ];
  const parts = tokenParts(call).filter(({ value }) => value > 0);
  const total = tokenTotal(call);
  const colors = tokenColors(dark);

  return <div className={[styles.root, isFailed(call) && styles.failed].filter(Boolean).join(" ")}>
    <dl className={styles.facts}>
      {facts.filter(([, value]) => value).map(([label, value, danger]) => <div key={label}>
        <dt>{label}</dt>
        <dd className={danger ? styles.danger : undefined}>{value}</dd>
      </div>)}
    </dl>

    {total > 0 && <section className={styles.section}>
      <h4>{t("Token 构成")}</h4>
      <TokenBar call={call} scale={total} dark={dark} thick />
      <div className={styles.legend}>
        {parts.map(({ part, value }) => <span key={part}>
          <i style={{ background: colors[part] }} />{tokenLabel(part)}
          <strong>{value.toLocaleString()}</strong>
          <small>{Math.round(value / total * 100)}%</small>
        </span>)}
      </div>
    </section>}

    <section className={styles.section}>
      <h4>{t("请求与响应")}</h4>
      {error ? <div className={styles.note}>{error}</div>
        : detail ? <TracePreview detail={detail} />
          : <div className={styles.note}>{t("正在加载记录…")}</div>}
    </section>
  </div>;
}

function headerLines(headers: unknown): Array<[string, string]> {
  if (Array.isArray(headers)) return headers.map(entry => Array.isArray(entry) ? [String(entry[0]), String(entry[1])] : ["", JSON.stringify(entry)]);
  if (headers && typeof headers === "object") return Object.entries(headers).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  return [];
}

function TracePreview({ detail }: { detail: CallDetail }) {
  const { request, response_chunks: chunks, cursor_trace: trace } = detail;
  const headers = headerLines(request?.headers);
  const tabs: Array<{ value: Preview; label: string }> = [
    ...(request ? [{ value: "headers" as const, label: t("请求头 {count}", { count: headers.length }) }, { value: "body" as const, label: t("请求体") }] : []),
    { value: "response", label: t("响应流") },
    ...(trace ? [{ value: "trace" as const, label: t("Cursor 追踪") }] : []),
  ];
  const [tab, setTab] = useState<Preview>(tabs.find(item => item.value === "body") ? "body" : "response");
  const [raw, setRaw] = useState(false);
  const showMessage = useMessage();

  const responseText = chunks.map(chunk => chunk.data).join("");
  const responseBytes = chunks.reduce((sum, chunk) => sum + chunk.byte_count, 0);
  const source = tab === "headers" ? headers.map(([key, value]) => `${key}: ${value}`).join("\n")
    : tab === "body" ? JSON.stringify(request?.body)
      : tab === "response" ? responseText
        : JSON.stringify(trace);
  const meta = tab === "headers" || tab === "body" ? request && bytes(request.byte_count)
    : tab === "response" ? chunks.length > 0 && joined(t("{count} 个分块", { count: chunks.length }), bytes(responseBytes),
      t("末块 +{time}", { time: duration(chunks.at(-1)?.received_offset_ms ?? null) }))
      : trace && joined(trace.trace.request_id, t("{count} 个工件", { count: trace.artifacts.length }));
  const text = raw ? source : formatStructuredText(source);
  const json = /^\s*[{[]/.test(source);
  const empty = tab === "response" ? chunks.length === 0 : tab !== "trace" && !request;

  const copy = async () => {
    try {
      await api.copyCursorText(text);
      showMessage(t("已复制"));
    } catch (cause) {
      showMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div className={styles.preview}>
    <div className={styles.toolbar}>
      <div className={styles.segments} role="tablist">
        {tabs.map(item => <button key={item.value} type="button" role="tab" aria-selected={item.value === tab}
          onClick={() => { setTab(item.value); setRaw(false); }}>{item.label}</button>)}
      </div>
      {meta && <span className={styles.meta}>{meta}</span>}
      <span className={styles.spacer} />
      {!empty && tab !== "headers" && <button type="button" className={styles.textButton} onClick={() => setRaw(value => !value)}>
        {raw ? t("格式化") : t("原文")}
      </button>}
      {!empty && <button type="button" className={styles.textButton} onClick={() => void copy()}>
        <Icon icon={copyIcon} size="1em" />{t("复制")}
      </button>}
    </div>
    {empty ? <div className={styles.emptyBody}>{t("未记录该内容。开启「详细记录」后，新的调用会保存请求与响应。")}</div>
      : tab === "headers" ? <div className={styles.headers}>
        {headers.map(([key, value], index) => <div key={`${key}-${index}`}><span>{key}</span><code>{value}</code></div>)}
      </div>
        : <JsonEditor key={`${tab}-${raw}`} ariaLabel={tabs.find(item => item.value === tab)?.label ?? ""} value={text}
          readOnly autoFormat={false} language={json ? "json" : "plaintext"}
          height={Math.min(420, Math.max(72, text.split("\n").length * 18 + 28))} />}
  </div>;
}
