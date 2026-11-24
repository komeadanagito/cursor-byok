//! Overview stat cards: one headline number per metric with its trend over the selected range.
import type { ReactNode } from "react";
import type { OverviewBucket, OverviewGranularity, OverviewMetrics } from "../../../shared/api";
import { Card } from "../../../shared/ui/Card";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import { formatCompactInteger, formatInteger, formatMoney } from "../../../shared/utils/numberFormat";
import { metricSeries, primaryCurrency } from "./overviewSeries";
import { Sparkline } from "./Sparkline";
import styles from "./HomeMetrics.module.scss";

function formatMetricValue(value: number) {
  const full = formatInteger(value);
  const compact = formatCompactInteger(value);
  return full === compact ? full : `${full} (${compact})`;
}

function formatRate(value: number | null) {
  return value === null ? "—" : `${(Math.max(0, Math.min(1, value)) * 100).toFixed(value >= 0.9995 || value === 0 ? 0 : 1)}%`;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function formatLatency(ms: number) {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatSpeed(value: number) {
  return `${value.toFixed(value < 100 ? 1 : 0)} tok/s`;
}

function elementAnchor(element: HTMLElement): TooltipAnchor {
  return {
    contextElement: element,
    getBoundingClientRect: () => element.getBoundingClientRect(),
  };
}

function InfoTooltip({ content }: { content: string }) {
  const { show, hide } = useTooltip();
  const open = (element: HTMLElement) => show(elementAnchor(element), undefined, <div className={styles.tooltipText}>{content}</div>);

  return <button
    type="button"
    className={styles.info}
    aria-label={t("查看说明")}
    onMouseEnter={(event) => open(event.currentTarget)}
    onMouseLeave={hide}
    onFocus={(event) => open(event.currentTarget)}
    onBlur={hide}
  ><Icon icon={informationOutlineIcon} size="1em" /></button>;
}

function StatCard({ label, info, value, valueTitle, detail, detailTone, trend }: {
  label: string;
  info?: string;
  value: string;
  valueTitle?: string;
  detail: ReactNode;
  detailTone?: "muted" | "warning" | "danger";
  trend: ReactNode;
}) {
  return <Card as="article" className={styles.card}>
    <div className={styles.label}>
      <span>{label}</span>
      {info && <InfoTooltip content={info} />}
    </div>
    <div className={styles.value} title={valueTitle ?? value}>{value}</div>
    <div className={`${styles.detail} ${detailTone === "warning" ? styles.detailWarning : detailTone === "danger" ? styles.detailDanger : ""}`}>{detail}</div>
    {trend}
  </Card>;
}

export function HomeMetrics({ metrics, series, granularity }: {
  metrics: OverviewMetrics;
  series: OverviewBucket[];
  granularity: OverviewGranularity;
}) {
  const freshInput = metrics.input_tokens;
  const cacheHitRate = rate(metrics.cache_read_tokens, metrics.cache_read_tokens + freshInput);
  const cacheReuseRate = rate(metrics.cache_read_tokens, metrics.cache_read_tokens + metrics.cache_write_tokens + freshInput);
  const successRate = rate(metrics.successful_calls, metrics.llm_calls);
  const failureRate = rate(metrics.failed_calls, metrics.llm_calls);
  const currency = primaryCurrency(metrics.costs);
  const trend = metricSeries(series, currency);
  const times = series.map((bucket) => bucket.bucket_start_ms);
  const costDisplay = metrics.costs.length > 0 ? metrics.costs.map((cost) => formatMoney(cost.currency, cost.amount)).join(" + ") : "—";
  const spark = (values: (number | null)[], format: (value: number) => string, label: string, tone?: "accent" | "danger") =>
    <Sparkline values={values} times={times} granularity={granularity} format={format} label={label} tone={tone} />;

  const tokensInfo = [
    t("总请求 Token 包含提示词和模型输出。"),
    "",
    t("总请求：{tokens}", { tokens: formatMetricValue(metrics.token_usage) }),
    t("提示词：{tokens}", { tokens: formatMetricValue(metrics.prompt_tokens) }),
    t("输出推算：{tokens}", { tokens: formatMetricValue(metrics.output_tokens) }),
    t("非缓存输入：{tokens}", { tokens: formatMetricValue(freshInput) }),
    t("缓存读取：{tokens}", { tokens: formatMetricValue(metrics.cache_read_tokens) }),
    t("缓存写入：{tokens}", { tokens: formatMetricValue(metrics.cache_write_tokens) }),
  ].join("\n");
  const costInfo = [
    t("按“调用详细”页配置的模型价格估算，缓存价留空时与输入价相同。"),
    ...metrics.costs.map((cost) => t("{currency} 费用：{amount}", { currency: cost.currency, amount: formatMoney(cost.currency, cost.amount) })),
    ...(metrics.costs.length > 1 && currency ? [t("走势图按 {currency} 绘制", { currency })] : []),
    ...(metrics.unpriced_calls > 0 ? ["", t("{count} 次调用未定价", { count: formatMetricValue(metrics.unpriced_calls) })] : []),
  ].join("\n");
  const cacheInfo = [
    t("公式：缓存读取 /（缓存读取 + 非缓存输入）"),
    t("默认 {defaultRate} / 计入创建 {reuseRate}", { defaultRate: formatRate(cacheHitRate), reuseRate: formatRate(cacheReuseRate) }),
  ].join("\n");

  return <section className={styles.root} aria-label={t("调用统计")}>
    <StatCard
      label={t("总令牌")}
      info={tokensInfo}
      value={formatCompactInteger(metrics.token_usage)}
      valueTitle={formatInteger(metrics.token_usage)}
      detail={t("输入 {input} · 输出 {output}", { input: formatCompactInteger(metrics.prompt_tokens), output: formatCompactInteger(metrics.output_tokens) })}
      trend={spark(trend.tokens, (value) => formatCompactInteger(value), t("总令牌走势"))}
    />
    <StatCard
      label={t("费用")}
      info={costInfo}
      value={costDisplay}
      detail={metrics.unpriced_calls > 0
        ? t("{count} 次调用未定价", { count: formatCompactInteger(metrics.unpriced_calls) })
        : metrics.costs.length > 0 ? t("全部调用已定价") : t("尚未定价任何模型")}
      detailTone={metrics.unpriced_calls > 0 ? "warning" : "muted"}
      trend={spark(trend.cost, (value) => formatMoney(currency ?? "USD", value), t("费用走势"))}
    />
    <StatCard
      label={t("调用次数")}
      value={formatCompactInteger(metrics.llm_calls)}
      valueTitle={formatInteger(metrics.llm_calls)}
      detail={t("成功率 {rate}", { rate: formatRate(successRate) })}
      trend={spark(trend.calls, (value) => formatInteger(value), t("调用次数走势"))}
    />
    <StatCard
      label={t("缓存命中率")}
      info={cacheInfo}
      value={formatRate(cacheHitRate)}
      detail={t("缓存读取 {tokens}", { tokens: formatCompactInteger(metrics.cache_read_tokens) })}
      trend={spark(trend.cacheHitRate, (value) => formatRate(value), t("缓存命中率走势"))}
    />
    <StatCard
      label={t("首字耗时")}
      value={metrics.avg_ttft_ms === null ? "—" : formatLatency(metrics.avg_ttft_ms)}
      detail={t("每次调用平均")}
      trend={spark(trend.ttft, formatLatency, t("首字耗时走势"))}
    />
    <StatCard
      label={t("输出速度")}
      value={metrics.output_tokens_per_second === null ? "—" : formatSpeed(metrics.output_tokens_per_second)}
      detail={t("首字之后，每次调用平均")}
      trend={spark(trend.speed, formatSpeed, t("输出速度走势"))}
    />
    <StatCard
      label={t("失败")}
      value={formatInteger(metrics.failed_calls)}
      detail={t("失败率 {rate}", { rate: formatRate(failureRate) })}
      detailTone={metrics.failed_calls > 0 ? "danger" : "muted"}
      trend={spark(trend.failed, (value) => formatInteger(value), t("失败走势"), metrics.failed_calls > 0 ? "danger" : "accent")}
    />
  </section>;
}
