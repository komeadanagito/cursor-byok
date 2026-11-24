import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceExtensionEntry, workspaceExtensionNeedsAttention } from '../src/features/models/workspaceExtension.ts';

const status = (state, installed_version = null, expected_version = '1.1.0', cursor_cli = true) => ({ state, installed_version, expected_version, cursor_cli });

test('entry reports nothing before the first status fetch', () => {
  assert.deepEqual(workspaceExtensionEntry(null), { kind: 'none' });
});

test('missing state maps to an installable entry', () => {
  assert.deepEqual(workspaceExtensionEntry(status('missing')), { kind: 'missing' });
});

test('outdated state carries installed and expected versions', () => {
  assert.deepEqual(workspaceExtensionEntry(status('outdated', '0.9.0')),
    { kind: 'outdated', installed: '0.9.0', expected: '1.1.0' });
  assert.deepEqual(workspaceExtensionEntry(status('outdated')),
    { kind: 'outdated', installed: null, expected: '1.1.0' });
});

test('current state reports the installed version, falling back to expected', () => {
  assert.deepEqual(workspaceExtensionEntry(status('current', '1.1.0')), { kind: 'current', version: '1.1.0' });
  assert.deepEqual(workspaceExtensionEntry(status('current', null, '1.1.0')), { kind: 'current', version: '1.1.0' });
});

test('menu attention dot lights for missing or outdated only', () => {
  assert.equal(workspaceExtensionNeedsAttention(null), false);
  assert.equal(workspaceExtensionNeedsAttention(status('missing')), true);
  assert.equal(workspaceExtensionNeedsAttention(status('outdated', '0.9')), true);
  assert.equal(workspaceExtensionNeedsAttention(status('current', '1.1.0')), false);
});
