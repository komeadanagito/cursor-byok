const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { startServer, createHandler } = require('../navigation.cjs');
const { makeVscode, location, documentSymbol, SymbolKind, spawnRelay, responses } = require('./fakes.cjs');

test('relay exits non-zero with the socket path on stderr when the socket is missing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'no.sock');
  const relay = spawnRelay(socketPath);
  let stderr = '';
  relay.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => relay.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, new RegExp(socketPath.replace(/[/.]/g, c => `\\${c}`)));
  assert.match(stderr, /ENOENT|socket/i);
});

test('full MCP round trip through a real socket and relay process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.js');
  const target = path.join(root, 'b.js');
  const docs = {
    [file]: { lines: ['run(x);'] },
    [target]: { lines: ['function run() {}'] },
  };
  for (const [name, spec] of Object.entries(docs)) fs.writeFileSync(name, spec.lines.join('\n'));
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeDefinitionProvider': () => [location(target, 0)],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('run', SymbolKind.Function, 0, 0)],
    },
  });
  const socketPath = path.join(root, 'symbols.sock');
  const server = await startServer(socketPath, createHandler(vscode, {
    rootUri: { fsPath: root, scheme: 'file', authority: '', path: root },
    workspaceName: 'ws',
  }));
  t.after(() => server.close());

  const relay = spawnRelay(socketPath);
  t.after(() => relay.kill());
  const next = responses(relay.stdout);
  const send = message => relay.stdin.write(`${JSON.stringify(message)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const init = await next();
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await next();
  assert.equal(list.result.tools.length, 4);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_definition', arguments: { file_path: 'a.js', line: 1, symbol: 'run' } } });
  const call = await next();
  assert.equal(call.id, 3);
  assert.match(call.result.content[0].text, /b\.js:1\b.*function run/);

  // Malformed JSON on the wire is answered with a parse error, not silence.
  relay.stdin.write('this is not json\n');
  const bad = await next();
  assert.equal(bad.error.code, -32700);
});
