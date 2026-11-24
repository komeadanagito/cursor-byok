//! Minimal fake of the `vscode` API surface navigation.cjs uses, for tests.
const { spawn } = require('node:child_process');
const path = require('node:path');

const RELAY = path.join(__dirname, '..', 'relay.cjs');

function spawnRelay(socketPath) {
  return spawn(process.execPath, [RELAY], {
    env: { ...process.env, BYOK_SYMBOLS_SOCKET: socketPath, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Reads newline-delimited JSON-RPC responses from a stream.
function responses(stream) {
  const queue = [];
  const waiters = [];
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (waiters.length) waiters.shift()(message);
      else queue.push(message);
    }
  });
  return () => new Promise(resolve => {
    if (queue.length) return resolve(queue.shift());
    waiters.push(resolve);
  });
}

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
  Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
  Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
  Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24,
  TypeParameter: 25,
};

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}

function fileUri(fsPath) {
  return { scheme: 'file', authority: '', path: fsPath, fsPath, toString: () => `file://${fsPath}` };
}

const Uri = {
  file: fileUri,
  joinPath(base, ...segments) {
    const fsPath = path.join(base.fsPath, ...segments);
    return { scheme: base.scheme, authority: base.authority, path: `${base.path}/${segments.join('/')}`, fsPath, toString: () => `${base.scheme}://${base.authority}${base.path}/${segments.join('/')}` };
  },
};

// Word chars matching VS Code's JavaScript-ish word pattern closely enough:
// dots and commas are separators, $ and _ are word chars.
const WORD = /[A-Za-z0-9_$]+/g;

function makeDoc(uri, { languageId = 'javascript', lines = [] } = {}) {
  return {
    uri,
    languageId,
    get lineCount() { return lines.length; },
    lineAt(i) { return { text: lines[i] }; },
    getWordRangeAtPosition(pos) {
      const text = lines[pos.line] ?? '';
      const re = new RegExp(WORD.source, 'g');
      let m;
      while ((m = re.exec(text))) {
        if (pos.character >= m.index && pos.character < m.index + m[0].length) {
          return { start: { line: pos.line, character: m.index }, end: { line: pos.line, character: m.index + m[0].length } };
        }
      }
      return undefined;
    },
  };
}

// docs: { fsPath: {languageId?, lines: string[]} }
// commandResults: { commandName: (uri, position) => any }
// commandCalls (out): records every executeCommand call as {command, uri, position}
function makeVscode({ docs = {}, commandResults = {}, commandCalls = [], languages = ['javascript', 'typescript', 'plaintext'] } = {}) {
  return {
    Position,
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    SymbolKind,
    Uri,
    workspace: {
      async openTextDocument(uri) {
        const spec = docs[uri.fsPath];
        if (spec === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return makeDoc(uri, spec);
      },
    },
    languages: {
      async getLanguages() { return languages; },
      getLanguageConfiguration() { return { wordPattern: WORD }; },
    },
    commands: {
      async executeCommand(command, uri, position) {
        commandCalls.push({ command, uri, position });
        const fn = commandResults[command];
        if (!fn) return undefined;
        return fn(uri, position);
      },
    },
  };
}

// Helpers to build fake results ------------------------------------------------

function location(fsPath, line, character = 0) {
  return {
    uri: fileUri(fsPath),
    range: { start: { line, character }, end: { line, character: character + 3 } },
  };
}

function locationLink(fsPath, selectionLine) {
  return {
    targetUri: fileUri(fsPath),
    targetRange: { start: { line: selectionLine, character: 0 }, end: { line: selectionLine + 2, character: 0 } },
    targetSelectionRange: { start: { line: selectionLine, character: 4 }, end: { line: selectionLine, character: 7 } },
  };
}

function documentSymbol(name, kind, startLine, endLine, children = []) {
  return {
    name,
    kind,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } },
    selectionRange: { start: { line: startLine, character: 0 }, end: { line: startLine, character: name.length } },
    children,
  };
}

module.exports = { SymbolKind, Position, Uri, makeVscode, location, locationLink, documentSymbol, fileUri, spawnRelay, responses };
