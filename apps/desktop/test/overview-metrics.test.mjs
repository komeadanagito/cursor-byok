import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMoney } from '../src/shared/utils/numberFormat.ts';
import { metricSeries, primaryCurrency } from '../src/features/home/metrics/overviewSeries.ts';

const bucket = (over = {}) => ({
  bucket_start_ms: 0,
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  calls: 0,
  failed_calls: 0,
  avg_ttft_ms: null,
  output_tokens_per_second: null,
  costs: [],
  ...over,
});

test('money keeps two decimals from one cent up and two significant digits below it', () => {
  assert.equal(formatMoney('USD', 1234.5), '$1,234.50');
  assert.equal(formatMoney('CNY', 0.03), '¥0.03');
  assert.equal(formatMoney('USD', 0.0002), '$0.0002');
  assert.equal(formatMoney('USD', 0.002345), '$0.0023');
  assert.equal(formatMoney('USD', 0), '$0.00');
});

test('the cost sparkline follows the currency with the larger spend', () => {
  assert.equal(primaryCurrency([{ currency: 'USD', amount: 0.5 }, { currency: 'CNY', amount: 3 }]), 'CNY');
  assert.equal(primaryCurrency([]), null);
});

test('each card series reads its own bucket field and leaves gaps where nothing was measured', () => {
  const series = metricSeries([
    bucket({ input_tokens: 10, cache_read_tokens: 30, output_tokens: 5, calls: 2, failed_calls: 1, avg_ttft_ms: 400, output_tokens_per_second: 50, costs: [{ currency: 'USD', amount: 0.2 }] }),
    bucket(),
  ], 'USD');
  assert.deepEqual(series.tokens, [45, 0]);
  assert.deepEqual(series.calls, [2, 0]);
  assert.deepEqual(series.failed, [1, 0]);
  assert.deepEqual(series.cost, [0.2, 0]);
  // Hit rate is read / (read + fresh input); an empty bucket has no rate, not 0%.
  assert.deepEqual(series.cacheHitRate, [0.75, null]);
  assert.deepEqual(series.ttft, [400, null]);
  assert.deepEqual(series.speed, [50, null]);
});

test('without any priced currency the cost series stays flat at zero', () => {
  const series = metricSeries([bucket({ costs: [{ currency: 'CNY', amount: 1 }] })], null);
  assert.deepEqual(series.cost, [0]);
});
