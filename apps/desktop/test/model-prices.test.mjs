import assert from 'node:assert/strict';
import test from 'node:test';
import { callCost, freshInput, parseRate, periodCost } from '../src/features/calls/modelPrices.ts';

const price = (over = {}) => ({
  input_per_million: 2,
  output_per_million: 10,
  cache_read_per_million: null,
  cache_write_per_million: null,
  currency: 'USD',
  updated_at_ms: 0,
  ...over,
});

const anthropicCall = { provider_url: 'https://api.anthropic.com', model_id: 'claude-sonnet-4-5', request_type: 'anthropic', input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 400_000, cache_write_tokens: 100_000 };
const openaiCall = { provider_url: 'https://api.openai.com', model_id: 'gpt-5', request_type: 'openai-chat', input_tokens: 1_500_000, output_tokens: 500_000, cache_read_tokens: 400_000, cache_write_tokens: 100_000 };

test('Anthropic input_tokens excludes cache; OpenAI input_tokens includes it', () => {
  // Anthropic reports fresh input directly: 1M fresh.
  assert.equal(freshInput(anthropicCall), 1_000_000);
  // OpenAI reports total prompt traffic: 1.5M - 0.4M read - 0.1M write = 1M fresh.
  assert.equal(freshInput(openaiCall), 1_000_000);
});

test('call cost bills fresh input, caches at input rate when unset, and output', () => {
  // 1M*2 + 0.4M*2 + 0.1M*2 + 0.5M*10 = 8 USD for both request shapes.
  assert.equal(callCost(anthropicCall, price()), 8);
  assert.equal(callCost(openaiCall, price()), 8);
});

test('explicit cache rates override the input rate', () => {
  const priced = price({ cache_read_per_million: 0.5, cache_write_per_million: 3 });
  // 1M*2 + 0.4M*0.5 + 0.1M*3 + 0.5M*10 = 7.5 USD.
  assert.equal(callCost(anthropicCall, priced), 7.5);
});

test('periodCost is null for unpriced models and only sums matching calls', () => {
  const calls = [anthropicCall, openaiCall, { ...anthropicCall, model_id: 'other' }];
  assert.equal(periodCost(calls, 'https://api.anthropic.com', 'claude-sonnet-4-5', null), null);
  assert.equal(periodCost(calls, 'https://api.anthropic.com', 'claude-sonnet-4-5', price()), 8);
});

test('parseRate accepts non-negative numbers and rejects junk', () => {
  assert.equal(parseRate(' 2.5 '), 2.5);
  assert.equal(parseRate('0'), 0);
  assert.equal(parseRate(''), null);
  assert.equal(parseRate('-1'), null);
  assert.equal(parseRate('abc'), null);
});

