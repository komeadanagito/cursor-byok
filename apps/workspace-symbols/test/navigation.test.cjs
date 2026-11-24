const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHandler } = require('../navigation.cjs');
const { makeVscode, location, locationLink, documentSymbol, SymbolKind } = require('./fakes.cjs');

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function handler(vscode, root) {
  return createHandler(vscode, {
    rootUri: { fsPath: root, scheme: 'file', authority: '', path: root },
    workspaceName: 'ws',
  });
}

// resolveFile validates against the real filesystem, so workspace files in a
// test must exist on disk even though the fake vscode serves their contents.
function touch(root, docs) {
  for (const [file, spec] of Object.entries(docs)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (spec.lines ?? []).join('\n'));
  }
}

function call(vscode, root, method, params) {
  return handler(vscode, root)({ jsonrpc: '2.0', id: 2, method, params });
}

function toolCall(vscode, root, name, args) {
  return call(vscode, root, 'tools/call', { name, arguments: args });
}

test('initialize replies with protocol version, capabilities and instructions', async (t) => {
  const root = setup(t);
  const res = await handler(makeVscode(), root)(INIT);
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.ok(res.result.capabilities.tools);
  assert.match(res.result.instructions, /semantic-/);
  assert.match(res.result.instructions, /one-based/i);
});

test('notifications and unknown methods are handled without errors on the wire', async (t) => {
  const root = setup(t);
  const h = handler(makeVscode(), root);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const res = await h({ jsonrpc: '2.0', id: 9, method: 'resources/list', params: {} });
  assert.equal(res.error.code, -32601);
  const ping = await h({ jsonrpc: '2.0', id: 10, method: 'ping' });
  assert.deepEqual(ping.result, {});
});

test('tools/list exposes the four navigation tools with the documented arguments', async (t) => {
  const root = setup(t);
  const res = await call(makeVscode(), root, 'tools/list');
  const names = res.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['find_definition', 'find_implementations', 'find_references', 'symbols_overview']);
  const byName = Object.fromEntries(res.result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(byName.symbols_overview.inputSchema.required, ['file_path']);
  for (const name of ['find_definition', 'find_references', 'find_implementations']) {
    assert.deepEqual(byName[name].inputSchema.required, ['file_path', 'line', 'symbol']);
  }
  assert.equal(res.result.tools.some(tool => tool.name === 'find_symbol'), false);
});

test('tools/call with an unknown tool name returns isError', async (t) => {
  const root = setup(t);
  const res = await toolCall(makeVscode(), root, 'nope', {});
  assert.equal(res.result.isError, true);
});

test('symbols_overview prints the tree with kinds and one-based inclusive line ranges', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const docs = { [file]: { lines: ['class A {', '  run() {}', '}'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeDocumentSymbolProvider': () => [
        documentSymbol('A', SymbolKind.Class, 0, 2, [
          documentSymbol('run', SymbolKind.Method, 1, 1),
        ]),
        documentSymbol('top', SymbolKind.Function, 0, 0),
      ],
    },
  });
  const res = await toolCall(vscode, root, 'symbols_overview', { file_path: 'a.js' });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  assert.match(text, /A.*Class.*lines 1-3/);
  assert.match(text, /run.*Method.*lines 2-2/);
  assert.match(text, /top.*Function/);
  assert.ok(text.indexOf('run') > text.indexOf('A'));
});

test('symbols_overview on a file with no provider-recognized language reports isError', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'notes.txt');
  const docs = { [file]: { languageId: 'plaintext', lines: ['hello'] } };
  touch(root, docs);
  const vscode = makeVscode({ docs });
  const res = await toolCall(vscode, root, 'symbols_overview', { file_path: 'notes.txt' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /no language service|install.*extension/i);
});

test('a document whose languageId is unknown to the host reports isError', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'x.mylang');
  const docs = { [file]: { languageId: 'mylang', lines: ['stuff'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    languages: ['javascript', 'plaintext'],
  });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'x.mylang', line: 1, symbol: 'stuff' });
  assert.equal(res.result.isError, true);
});

test('find_definition resolves the symbol column on the line and returns one-based results', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const target = path.join(root, 'b.js');
  const commandCalls = [];
  const docs = {
    [file]: { lines: ['import {run} from "./b.js";', 'run(x); run(y);', 'function run() {}'] },
    [target]: { lines: ['', '', 'function run() {}'] },
  };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandCalls,
    commandResults: {
      'vscode.executeDefinitionProvider': (uri, position) =>
        position.character >= 7 ? [location(target, 2)] : [],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('run', SymbolKind.Function, 2, 2)],
    },
  });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 2, symbol: 'run' });
  assert.equal(res.result.isError, undefined);
  // line 2 is 1-based: the provider must be queried at zero-based line 1.
  const calls = commandCalls.filter(call => call.command === 'vscode.executeDefinitionProvider');
  assert.ok(calls.every(call => call.position.line === 1));
  // The second `run` on the line is the one the provider answers for.
  assert.ok(calls.some(call => call.position.character > 4));
  const text = res.result.content[0].text;
  assert.match(text, /b\.js:3\b.*function run/);
});

test('a symbol whose only occurrence yields no provider results is a normal empty result', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const docs = { [file]: { lines: ['run(x);'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeDefinitionProvider': () => [],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('run', SymbolKind.Function, 0, 0)],
    },
  });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 1, symbol: 'run' });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /no results/i);
});

test('symbol absent from the line reports isError naming file, line and line text', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const docs = { [file]: { lines: ['const alpha = 1;'] } };
  touch(root, docs);
  const vscode = makeVscode({ docs });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 1, symbol: 'beta' });
  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.match(text, /a\.js/);
  assert.match(text, /a\.js:1/);
  assert.match(text, /const alpha = 1;/);
  assert.match(text, /beta/);
});

test('symbol that only appears as a substring of a longer identifier is not a match', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const commandCalls = [];
  const docs = { [file]: { lines: ['runner.go();'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandCalls,
    commandResults: { 'vscode.executeDefinitionProvider': () => [location(file, 0)] },
  });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 1, symbol: 'run' });
  assert.equal(res.result.isError, true);
  assert.equal(commandCalls.filter(call => call.command === 'vscode.executeDefinitionProvider').length, 0);
});

test('find_references returns locations outside the workspace as absolute paths', async (t) => {
  const root = setup(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, 'lib.js');
  fs.writeFileSync(outside, 'export function run() {}\n');
  const file = path.join(root, 'a.js');
  const docs = { [file]: { lines: ['run();', 'run();'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeReferenceProvider': () => [location(outside, 0), location(file, 1)],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('run', SymbolKind.Function, 1, 1)],
    },
  });
  const res = await toolCall(vscode, root, 'find_references', { file_path: 'a.js', line: 1, symbol: 'run' });
  const text = res.result.content[0].text;
  assert.match(text, new RegExp(outside.replace(/[/.]/g, c => `\\${c}`) + ':1'));
  assert.match(text, /a\.js:2\b.*run\(\);/);
});

test('LocationLink results use targetUri and targetSelectionRange', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const target = path.join(root, 'b.js');
  const docs = {
    [file]: { lines: ['obj.m();'] },
    [target]: { lines: ['x', 'x', 'x', 'x', '  m() {}'] },
  };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeDefinitionProvider': () => [locationLink(target, 4)],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('m', SymbolKind.Method, 0, 0)],
    },
  });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 1, symbol: 'm' });
  assert.match(res.result.content[0].text, /b\.js:5\b.*m\(\)/);
});

test('find_implementations queries the implementation provider', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const commandCalls = [];
  const docs = { [file]: { lines: ['iface.call();'] } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandCalls,
    commandResults: {
      'vscode.executeImplementationProvider': () => [location(file, 0)],
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('call', SymbolKind.Method, 0, 0)],
    },
  });
  const res = await toolCall(vscode, root, 'find_implementations', { file_path: 'a.js', line: 1, symbol: 'call' });
  assert.equal(res.result.isError, undefined);
  assert.ok(commandCalls.some(call => call.command === 'vscode.executeImplementationProvider'));
});

test('results are truncated at 200 entries with the total reported', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const many = Array.from({ length: 250 }, (_, i) => location(file, i % 10));
  const docs = { [file]: { lines: Array.from({ length: 10 }, (_, i) => `call${i}();`) } };
  touch(root, docs);
  const vscode = makeVscode({
    docs,
    commandResults: {
      'vscode.executeReferenceProvider': () => many,
      'vscode.executeDocumentSymbolProvider': () => [documentSymbol('call', SymbolKind.Function, 0, 0)],
    },
  });
  const res = await toolCall(vscode, root, 'find_references', { file_path: 'a.js', line: 1, symbol: 'call0' });
  const text = res.result.content[0].text;
  const count = (text.match(/a\.js:\d+/g) || []).length;
  assert.equal(count, 200);
  assert.match(text, /250/);
  assert.match(text, /truncat/i);
});

test('paths escaping the workspace root are rejected', async (t) => {
  const root = setup(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-out-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsideDir, 'x.js'), 'run();');
  const file = path.join(root, 'a.js');
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(path.join(outsideDir, 'x.js'), path.join(root, 'sub', 'link.js'));
  const vscode = makeVscode({ docs: { [file]: { lines: [''] } } });
  for (const file_path of ['../x.js', path.join(outsideDir, 'x.js'), 'sub/link.js']) {
    const res = await toolCall(vscode, root, 'find_definition', { file_path, line: 1, symbol: 'run' });
    assert.equal(res.result.isError, true, file_path);
    assert.match(res.result.content[0].text, /outside|workspace/i, file_path);
  }
});

test('line out of range reports isError', async (t) => {
  const root = setup(t);
  const file = path.join(root, 'a.js');
  const docs = { [file]: { lines: ['run();'] } };
  touch(root, docs);
  const vscode = makeVscode({ docs });
  const res = await toolCall(vscode, root, 'find_definition', { file_path: 'a.js', line: 5, symbol: 'run' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /line 5/);
});
