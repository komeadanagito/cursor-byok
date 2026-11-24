import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheMetrics, callTokens, median } from '../src/features/calls/callMetrics.ts';

const base = { request_type: 'openai-responses', input_tokens: 1000, output_tokens: 31, cache_read_tokens: 800, cache_write_tokens: 0 };

test('warm token percentage and request hit rate have independent denominators', () => {
  const cold = { ...base, cache_read_tokens: 0 };
  const unreported = { ...base, cache_read_tokens: null };
  assert.deepEqual(cacheMetrics([base, cold, unreported]), { hits: 1, reported: 2, read: 800, input: 2000 });
});

test('Anthropic uncached usage is added to reads and writes once', () => {
  assert.deepEqual(callTokens({ ...base, request_type: 'anthropic', input_tokens: 100, cache_write_tokens: 90 }),
    { read: 800, write: 90, input: 100, totalInput: 990, output: 31 });
});

test('provider context input is preferred and missing timings are absent', () => {
  assert.equal(callTokens({ ...base, usage: { context_input_tokens: 1100 } }).totalInput, 1100);
  assert.equal(median([]), null);
  assert.equal(median([100, 1000, 200, 300]), 250);
});
