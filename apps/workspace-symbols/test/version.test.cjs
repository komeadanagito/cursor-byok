const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checkVersion = path.join(__dirname, '..', 'scripts', 'check-version.mjs');

function run(args) {
  return spawnSync(process.execPath, [checkVersion, ...args], { encoding: 'utf8' });
}

test('the extension version matches the desktop app version', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
});

test('check-version rejects a manifest drifting from the app version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'tauri.conf.json'), JSON.stringify({ version: '1.1.0' }));
  const result = run([path.join(dir, 'package.json'), path.join(dir, 'tauri.conf.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /9\.9\.9/);
  assert.match(result.stderr, /1\.1\.0/);
});
