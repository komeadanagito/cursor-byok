const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activate } = require('../extension.cjs');
const { spawnRelay, responses } = require('./fakes.cjs');

const root = dir => ({ name: 'a-long-workspace-folder-name', uri: { scheme: 'vscode-remote', fsPath: dir, toString: () => `vscode-remote://ssh-remote+fixture${dir}` } });

const semanticExe = () => process.platform === 'win32' ? 'byok-semantic.exe' : 'byok-semantic';
const semanticTargetDir = () => `${process.platform}-${process.arch}`;

function fakeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'bin', semanticTargetDir());
  fs.mkdirSync(target, { recursive: true });
  const exe = path.join(target, semanticExe());
  fs.writeFileSync(exe, '#! fake binary\n');
  fs.chmodSync(exe, 0o644);
  return { dir, exe };
}

// bin/** resolves into the fake binary tree; every other file resolves into the
// real extension directory so relay.cjs stays runnable.
function setup(t, folders, { binDir } = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-storage-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const bin = binDir ?? fakeBinDir(t).dir;
  const errors = [];
  const workspace = {
    isTrusted: true,
    workspaceFolders: folders,
    getConfiguration: () => ({ get: () => undefined }),
  };
  let change;
  workspace.onDidChangeWorkspaceFolders = cb => { change = cb; return { dispose() {} }; };
  const active = new Map();
  const api = {
    workspace,
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
    languages: { getLanguages: async () => [], getLanguageConfiguration: () => ({}) },
    window: { showErrorMessage: msg => errors.push(msg), showInformationMessage: () => {}, showWarningMessage: () => {} },
    cursor: { mcp: {
      registerServer({ name, server }) { active.set(name, server); },
      unregisterServer(name) { active.delete(name); },
    } },
  };
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: storage, scheme: 'file', toString: () => `file://${storage}` },
    asAbsolutePath: file => file.startsWith('bin' + path.sep) || file.startsWith('bin/')
      ? path.join(bin, file)
      : path.join(__dirname, '..', file),
  };
  return { workspace, active, api, context, storage, errors, binDir: bin, onFoldersChange: folders => change(folders) };
}

test('each workspace root registers a relayed symbols server and a bundled byok-semantic server', async (t) => {
  const { workspace, active, api, context, storage, onFoldersChange } = setup(t, [root('/one/repo'), root('/two/repo')]);
  const activation = await activate(context, api);
  await activation.ready;
  assert.equal(active.size, 4);
  const symbols = [...active.entries()].find(([id]) => id.startsWith('symbols-'));
  assert.equal(symbols[1].command, process.execPath);
  assert.equal(symbols[1].args.length, 1);
  assert.ok(symbols[1].args[0].endsWith('relay.cjs'));
  assert.equal(symbols[1].env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(symbols[1].env.BYOK_SYMBOLS_SOCKET);
  const semantic = [...active.entries()].find(([id]) => id.startsWith('semantic-'));
  const expected = `bin${path.sep}${semanticTargetDir()}${path.sep}${semanticExe()}`;
  assert.ok(semantic[1].command.endsWith(expected), `${semantic[1].command} must end with ${expected}`);
  assert.deepEqual(semantic[1].args, ['/one/repo']);
  assert.deepEqual(semantic[1].env, {});
  const ids = new Set([...active.keys()].map(id => id.replace(/^(symbols|semantic)-/, '')));
  assert.equal(ids.size, 2);

  onFoldersChange({ added: [root('/three/repo')], removed: [workspace.workspaceFolders[0]] });
  await activation.ready;
  assert.equal(active.size, 4);
  assert.ok(![...active.values()].some(server => server.args?.[0] === '/one/repo'), 'removed root unregisters both servers');
  assert.ok([...active.keys()].some(id => id.startsWith('semantic-')), 'added root keeps registering semantic');
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });
});

test('activate restores the executable bit VSIX extraction drops', async (t) => {
  const { dir, exe } = fakeBinDir(t);
  assert.equal(fs.statSync(exe).mode & 0o111, 0);
  const { active, api, context } = setup(t, [root('/repo')], { binDir: dir });
  const activation = await activate(context, api);
  await activation.ready;
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(exe).mode & 0o777, 0o755);
  }
  assert.ok([...active.keys()].some(id => id.startsWith('semantic-')));
});

test('a platform without a bundled binary reports it and registers only symbols', async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-bin-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const { active, api, context, errors } = setup(t, [root('/repo'), root('/repo2')], { binDir: empty });
  const activation = await activate(context, api);
  await activation.ready;
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });
  assert.equal(active.size, 2);
  assert.ok([...active.keys()].every(id => id.startsWith('symbols-')));
  assert.equal(errors.length, 1, 'one message even with several workspace roots');
  assert.match(errors[0], new RegExp(`${process.platform}-${process.arch}`));
  assert.match(errors[0], /bin[/\\]/);
});

test('the socket for each workspace root lives in a private short mkdtemp directory', async (t) => {
  // The socket path must stay far below the 104-byte sockaddr_un limit even when
  // globalStorage resolves to a deeply nested directory; registering in
  // globalStorage directly was the regression that broke every symbols server
  // on macOS with EINVAL.
  const deep = path.join(t.name ? fs.mkdtempSync(path.join(os.tmpdir(), 'ext-deep-')) : os.tmpdir(), 'very', 'deep', 'storage', 'path', 'that', 'is', 'way', 'past', 'one', 'hundred', 'and', 'four', 'bytes', 'total', 'abc');
  fs.mkdirSync(deep, { recursive: true });
  t.after(() => fs.rmSync(deep.slice(0, deep.indexOf(`${path.sep}very`)), { recursive: true, force: true }));
  const { api, context, active } = setup(t, [root('/deep/repo')]);
  context.globalStorageUri = { fsPath: deep, scheme: 'file', toString: () => `file://${deep}` };
  const activation = await activate(context, api);
  await activation.ready;
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });
  const socketPath = [...active.entries()].find(([id]) => id.startsWith('symbols-'))[1].env.BYOK_SYMBOLS_SOCKET;
  assert.ok(Buffer.byteLength(socketPath) < 104, socketPath);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  const relay = spawnRelay(socketPath);
  t.after(() => relay.kill());
  const next = responses(relay.stdout);
  relay.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  assert.equal((await next()).result.protocolVersion, '2025-06-18');
});

test('remote diagnostics report the effective route rather than a local-file guess', async (t) => {
  const { api, context } = setup(t, []);
  api.env = { remoteName: 'ssh-remote' };
  api.workspace.getConfiguration = () => ({ get: () => 'never' });
  let command, warning;
  api.commands.registerCommand = (_, callback) => { command = callback; return { dispose() {} }; };
  api.window = { showWarningMessage: msg => { warning = msg; } };
  await activate(context, api);
  t.after(() => { for (const sub of context.subscriptions) sub.dispose(); });
  await command();
  assert.match(warning, /never/);
  assert.match(warning, /always/);
});
