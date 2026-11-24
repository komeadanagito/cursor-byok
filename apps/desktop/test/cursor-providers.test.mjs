import assert from 'node:assert/strict';
import test from 'node:test';
import { manualProviders, mergeOrder, pluginProviders, testStatus } from '../src/features/models/cursorProviders.ts';
import { modelBrand, providerBrand } from '../src/shared/utils/modelBrand.ts';

const model = (hash, base_url, model_id, extra = {}) => ({ model_hash: hash, base_url, model_id, type: 'openai', group_name: null, ...extra });

test('a model name names its maker, the family winning over the relay', () => {
  assert.equal(modelBrand('claude-sonnet-4-5'), 'claude');
  assert.equal(modelBrand('deepseek-ai/DeepSeek-V3'), 'deepseek');
  assert.equal(modelBrand('meta-llama/llama-3.1-70b'), 'meta');
  assert.equal(modelBrand('o3-mini'), 'openai');
  assert.equal(modelBrand('glm-4.5-air'), 'zhipu');
});

test('a name that only contains a maker word mid-token is not recognized', () => {
  assert.equal(modelBrand('turbo3'), null);
  assert.equal(modelBrand('myclaude'), null);
});

test('an API address names its provider by domain, a local port by the tool that listens there', () => {
  assert.equal(providerBrand('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(providerBrand('api.moonshot.cn'), 'moonshot');
  assert.equal(providerBrand('http://127.0.0.1:11434'), 'ollama');
  assert.equal(providerBrand('http://127.0.0.1:18642'), null);
  assert.equal(providerBrand('https://relay.example.com'), null);
  assert.equal(providerBrand('https://notopenai.com'), null);
});

test('official providers show their brand while retaining their address as the group identity', () => {
  const providers = manualProviders([
    model('a', 'https://chatgpt.com/backend-api', 'custom-alias'),
    model('b', 'https://api.openai.com/v1', 'custom-alias'),
    model('c', 'https://api.anthropic.com/v1', 'custom-alias'),
    model('d', 'https://claude.ai', 'custom-alias', { group_name: 'Work' }),
    model('e', 'https://relay.example.com', 'claude-sonnet-4-5'),
  ]);
  assert.deepEqual(providers.map(({ key, name, brand }) => [key, name, brand]), [
    ['manual:chatgpt.com', 'ChatGPT', 'openai'],
    ['manual:api.openai.com', 'OpenAI', 'openai'],
    ['manual:api.anthropic.com', 'Claude', 'claude'],
    ['manual:Work', 'Work', 'claude'],
    ['manual:relay.example.com', 'relay.example.com', 'claude'],
  ]);
});

test('manual models group by supplier in first-appearance order and Magpie models stay out', () => {
  const providers = manualProviders([
    model('a', 'https://api.deepseek.com', 'deepseek-chat'),
    model('m', 'http://127.0.0.1:18642', 'openai/gpt-5', { group_name: 'Magpie', gateway_capabilities: { thinking: true, efforts: [] } }),
    model('b', 'https://relay.example.com', 'claude-opus-4', { type: 'anthropic' }),
    model('c', 'https://api.deepseek.com', 'deepseek-reasoner', { type: 'anthropic' }),
  ]);
  assert.deepEqual(providers.map(p => [p.name, p.models.map(m => m.model_hash), p.types]), [
    ['api.deepseek.com', ['a', 'c'], ['openai', 'anthropic']],
    ['relay.example.com', ['b'], ['anthropic']],
  ]);
});

test('a relay shows its models’ maker only when they all share one', () => {
  const [single] = manualProviders([model('a', 'https://relay.example.com', 'claude-opus-4'), model('b', 'https://relay.example.com', 'claude-haiku-4')]);
  const [mixed] = manualProviders([model('a', 'https://relay.example.com', 'claude-opus-4'), model('b', 'https://relay.example.com', 'gpt-5')]);
  assert.equal(single.brand, 'claude');
  assert.equal(mixed.brand, null);
});

test('a configured supplier name splits models of one host into their own providers', () => {
  const providers = manualProviders([
    model('a', 'https://relay.example.com', 'gpt-5', { group_name: 'Work' }),
    model('b', 'https://relay.example.com', 'gpt-5'),
  ]);
  assert.deepEqual(providers.map(p => p.name), ['Work', 'relay.example.com']);
});

test('plugin models group by plugin', () => {
  const descriptor = (id, pluginId) => ({ id, pluginId, pluginName: pluginId, icon: `${pluginId}.svg` });
  assert.deepEqual(pluginProviders([descriptor('1', 'codex'), descriptor('2', 'other'), descriptor('3', 'codex')])
    .map(p => [p.key, p.models.map(m => m.id)]), [['plugin:codex', ['1', '3']], ['plugin:other', ['2']]]);
});

test('one failed test marks the provider failed even after others passed; untested stays idle', () => {
  const results = new Map([['a', { status: 'success' }], ['b', { status: 'error', error: 'x' }]]);
  assert.equal(testStatus(['a', 'b'], results), 'failed');
  assert.equal(testStatus(['a', 'c'], results), 'ready');
  assert.equal(testStatus(['c'], results), 'idle');
});

test('reordering one provider keeps the slots its models held in the full order', () => {
  assert.deepEqual(mergeOrder(['a', 'x', 'b', 'y', 'c'], ['c', 'a', 'b']), ['c', 'x', 'a', 'y', 'b']);
});
