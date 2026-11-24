//! Overview stat strip in the classic 4-column connected layout (no horizontal scrollbar).
import type { OverviewMetrics } from "../../../shared/api";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { CacheHitRateChart } from "./CacheHitRateChart";
import styles from "./HomeMetrics.module.scss";

function formatMetricValue(value: number) {
  const full = formatInteger(value);
  const compact = formatCompactInteger(value);
  return full === compact ? full : `${full} (${compact})`;
}

function formatRate(value: number | null) {
  return value === null ? t("暂无数据") : `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;
}

function calculateRate(numerator: number, denominator: number) {
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

  return <button
    type="button"
    className={styles.info}
    aria-label={t("查看说明")}
    onMouseEnter={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onMouseLeave={hide}
    onFocus={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onBlur={hide}
  ><Icon icon={informationOutlineIcon} size="1.1em" /></button>;
}

export function HomeMetrics({ metrics, refreshVersion = 0 }: { metrics: OverviewMetrics; refreshVersion?: number }) {
  const inputTokens = metrics.input_tokens;
  const outputTokens = metrics.output_tokens;
  const defaultCacheHitRate = calculateRate(metrics.cache_read_tokens, metrics.cache_read_tokens + inputTokens);
  const cacheReuseRate = calculateRate(
    metrics.cache_read_tokens,
    metrics.cache_read_tokens + metrics.cache_write_tokens + inputTokens,
  );
  const successfulCallRate = calculateRate(metrics.successful_calls, metrics.llm_calls);

  const cacheTooltip = [
    t("当前：{rate}", { rate: formatRate(defaultCacheHitRate) }),
    t("公式：缓存读取 /（缓存读取 + 非缓存输入）"),
    t("默认 {defaultRate} / 计入创建 {reuseRate}", {
      defaultRate: formatRate(defaultCacheHitRate),
      reuseRate: formatRate(cacheReuseRate),
    }),
  ].join("\n");
  const callsTooltip = [
    t("按历史 LLM 调用记录汇总，进行中的调用不计入。"),
    "",
    t("总调用：{count}", { count: formatMetricValue(metrics.llm_calls) }),
    t("成功调用：{count}", { count: formatMetricValue(metrics.successful_calls) }),
    t("异常调用：{count}", { count: formatMetricValue(metrics.failed_calls) }),
    t("成功占比：{rate}", { rate: formatRate(successfulCallRate) }),
  ].join("\n");
  const tokensTooltip = [
    t("总请求 Token 包含提示词和模型输出。"),
    "",
    t("总请求：{tokens}", { tokens: formatMetricValue(metrics.token_usage) }),
    t("提示词：{tokens}", { tokens: formatMetricValue(metrics.prompt_tokens) }),
    t("输出推算：{tokens}", { tokens: formatMetricValue(outputTokens) }),
    t("非缓存输入：{tokens}", { tokens: formatMetricValue(inputTokens) }),
    t("缓存读取：{tokens}", { tokens: formatMetricValue(metrics.cache_read_tokens) }),
    t("缓存写入：{tokens}", { tokens: formatMetricValue(metrics.cache_write_tokens) }),
    "",
    t("缓存读写已计入提示词侧统计。"),
  ].join("\n");
  const latencyTooltip = [
    t("首字耗时：{value}", { value: metrics.avg_ttft_ms === null ? t("暂无数据") : formatLatency(metrics.avg_ttft_ms) }),
    t("输出速度：{value}", { value: metrics.output_tokens_per_second === null ? t("暂无数据") : formatSpeed(metrics.output_tokens_per_second) }),
  ].join("\n");

  return <div className={styles.scroller}>
    <section className={styles.root} aria-label={t("调用统计")}>
      <article className={styles.metric}>
        <div className={styles.label}>{t("缓存命中率")}<InfoTooltip content={cacheTooltip} /></div>
        <CacheHitRateChart rate={defaultCacheHitRate ?? 0} animationKey={refreshVersion} />
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("LLM 调用")}<InfoTooltip content={callsTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(metrics.llm_calls)}>{formatCompactInteger(metrics.llm_calls)}</div>
          <div className={styles.secondary}>{t("成功 {successful} / 异常 {failed}", {
            successful: formatCompactInteger(metrics.successful_calls),
            failed: formatCompactInteger(metrics.failed_calls),
          })}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("Token 消耗")}<InfoTooltip content={tokensTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(metrics.token_usage)}>{formatCompactInteger(metrics.token_usage)}</div>
          <div className={styles.secondary}>{t("提示词 {tokens}", { tokens: formatCompactInteger(metrics.prompt_tokens) })}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("响应与速度")}<InfoTooltip content={latencyTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={metrics.avg_ttft_ms === null ? "—" : formatLatency(metrics.avg_ttft_ms)}>
            {metrics.avg_ttft_ms === null ? "—" : formatLatency(metrics.avg_ttft_ms)}
          </div>
          <div className={styles.secondary}>
            {metrics.output_tokens_per_second === null ? t("首字耗时平均") : formatSpeed(metrics.output_tokens_per_second)}
          </div>
        </div>
      </article>
    </section>
  </div>;
}
