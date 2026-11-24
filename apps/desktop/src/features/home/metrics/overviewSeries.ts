//! Derives the per-card sparkline series from the overview buckets.
import type { CurrencyCost, OverviewBucket } from "../../../shared/api";

/** USD and CNY never add up, so the cost sparkline follows the larger spend. */
export function primaryCurrency(costs: CurrencyCost[]): string | null {
  return costs.reduce<CurrencyCost | null>((best, cost) => (best === null || cost.amount > best.amount ? cost : best), null)?.currency ?? null;
}

export function metricSeries(series: OverviewBucket[], currency: string | null) {
  return {
    tokens: series.map((bucket) => bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens),
    cost: series.map((bucket) => bucket.costs.find((cost) => cost.currency === currency)?.amount ?? 0),
    calls: series.map((bucket) => bucket.calls),
    cacheHitRate: series.map((bucket) => {
      const denominator = bucket.cache_read_tokens + bucket.input_tokens;
      return denominator > 0 ? bucket.cache_read_tokens / denominator : null;
    }),
    ttft: series.map((bucket) => bucket.avg_ttft_ms),
    speed: series.map((bucket) => bucket.output_tokens_per_second),
    failed: series.map((bucket) => bucket.failed_calls),
  };
}
