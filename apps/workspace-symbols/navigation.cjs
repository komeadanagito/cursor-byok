//! Serves MCP navigation tools for one workspace root over a local socket, backed by the editor's language services.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PROTOCOL_VERSION = '2025-06-18';
const MAX_RESULTS = 200;

const KIND_NAMES = [
  'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field',
  'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String',
  'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct',
  'Event', 'Operator', 'TypeParameter',
];

const NO_SERVICE = file =>
  `${file}: no language service is available for this file. Install a Cursor extension for its language to enable navigation.`;

const FILE_PATH = {
  type: 'string',
  description: 'File inside this workspace, relative to the workspace root or absolute.',
};
const LINE = {
  type: 'integer',
  minimum: 1,
  description: 'One-based line number that contains the symbol.',
};
const SYMBOL = {
  type: 'string',
  description: 'Symbol text exactly as it appears on that line (for example a function or method name). It determines the column used for the query.',
};

const TOOLS = [
  {
    name: 'symbols_overview',
    description: 'List the symbols of one file in this workspace as an indented tree. Each entry shows its name, kind (Class, Method, Function, …) and one-based inclusive line range.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH }, required: ['file_path'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'find_definition',
    description: 'Find where a symbol is defined, using the language services of the editor — identical to Go to Definition. Give the file, the one-based line the symbol appears on, and the symbol text; the column is resolved automatically.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH, line: LINE, symbol: SYMBOL }, required: ['file_path', 'line', 'symbol'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'find_references',
    description: 'Find all references to a symbol, using the language services of the editor — identical to Find All References. Give the file, the one-based line the symbol appears on, and the symbol text.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH, line: LINE, symbol: SYMBOL }, required: ['file_path', 'line', 'symbol'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'find_implementations',
    description: 'Find implementations of a symbol (interface, abstract method, …), using the language services of the editor — identical to Go to Implementations. Give the file, the one-based line the symbol appears on, and the symbol text.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH, line: LINE, symbol: SYMBOL }, required: ['file_path', 'line', 'symbol'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const COMMANDS = {
  find_definition: 'vscode.executeDefinitionProvider',
  find_references: 'vscode.executeReferenceProvider',
  find_implementations: 'vscode.executeImplementationProvider',
};

const INSTRUCTIONS = [
  'Answers come from the language extensions already loaded in this Cursor window, so results match Go to Definition and Find All References exactly. All line numbers are one-based.',
  'To find code by name or by description of what it does, use the search tool of the semantic-… server instead. The tools here answer where a known symbol is defined, referenced or implemented, and which symbols a file contains.',
].join(' ');

class ToolError extends Error {}

// --- workspace paths ---------------------------------------------------------

// Resolves file_path against the workspace root and rejects paths that escape it
// after `..` segments and symlinks are resolved. The returned URI keeps the
// root's scheme/authority so remote (vscode-remote) documents open correctly.
function resolveFile(vscode, ctx, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ToolError('file_path must be a non-empty path inside the workspace.');
  }
  const absolute = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(ctx.rootUri.fsPath, filePath);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new ToolError(`${filePath}: file not found on the workspace host.`);
  }
  const rel = path.relative(ctx.realRoot, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError(`${filePath} resolves outside the workspace root ${ctx.rootUri.fsPath}; only files inside the workspace are served.`);
  }
  return {
    uri: vscode.Uri.joinPath(ctx.rootUri, ...rel.split(path.sep)),
    relPath: rel === '' ? path.basename(real) : rel,
  };
}

// --- language-service checks -------------------------------------------------

// "No provider" is only reliably observable through the languageId: VS Code maps
// a missing provider and an empty provider result to the same undefined/[] for
// every execute* command, so the document's languageId is the honest signal.
async function assertLanguageService(vscode, doc, relPath) {
  if (!doc.languageId || doc.languageId === 'plaintext') throw new ToolError(NO_SERVICE(relPath));
  const known = await vscode.languages.getLanguages();
  if (!known.includes(doc.languageId)) throw new ToolError(NO_SERVICE(relPath));
}

// --- symbol lookup -----------------------------------------------------------

// A symbol occurrence counts only at an identifier boundary: `run` inside
// `runner` must not produce a column. Word characters come from the language
// configuration via getWordRangeAtPosition.
function isWordCharBefore(vscode, doc, line, character, wordPattern) {
  const range = doc.getWordRangeAtPosition(new vscode.Position(line, character - 1), wordPattern);
  return range !== undefined && range.end.character === character;
}

function isWordCharAt(vscode, doc, line, character, wordPattern) {
  const range = doc.getWordRangeAtPosition(new vscode.Position(line, character), wordPattern);
  return range !== undefined && range.start.character < character;
}

function symbolColumns(vscode, doc, line, text, symbol) {
  const config = vscode.languages.getLanguageConfiguration?.(doc.languageId);
  let wordPattern = config?.wordPattern;
  if (typeof wordPattern === 'string') wordPattern = new RegExp(wordPattern);
  const columns = [];
  let index = 0;
  while ((index = text.indexOf(symbol, index)) >= 0) {
    const end = index + symbol.length;
    const leftOk = index === 0 || !isWordCharBefore(vscode, doc, line, index, wordPattern);
    const rightOk = end >= text.length || !isWordCharAt(vscode, doc, line, end, wordPattern);
    if (leftOk && rightOk) columns.push(index);
    index = end;
  }
  return columns;
}

// --- result formatting -------------------------------------------------------

async function readLineText(vscode, uri, line, cache) {
  const key = uri.toString();
  if (!cache.has(key)) {
    let lines;
    try {
      // On a workspace extension host the document's fsPath is always a local
      // path, including vscode-remote files, so fs reads work for file results.
      lines = fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
    } catch {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
      } catch {
        lines = null;
      }
    }
    cache.set(key, lines);
  }
  return cache.get(key)?.[line];
}

function displayPath(ctx, uri) {
  if (uri.fsPath) {
    const rel = path.relative(ctx.realRoot, uri.fsPath);
    if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && rel !== '') return rel;
    return uri.fsPath;
  }
  return uri.toString();
}

async function formatLocations(vscode, ctx, results) {
  const total = results.length;
  const shown = results.slice(0, MAX_RESULTS);
  const cache = new Map();
  const lines = [];
  for (const result of shown) {
    const uri = result.targetUri ?? result.uri;
    const range = result.targetSelectionRange ?? result.range ?? result.targetRange;
    const line = range.start.line + 1;
    const text = (await readLineText(vscode, uri, range.start.line, cache))?.trim();
    lines.push(`${displayPath(ctx, uri)}:${line}${text ? `\t${text}` : ''}`);
  }
  const header = total > MAX_RESULTS
    ? `${total} results, truncated to the first ${MAX_RESULTS}:`
    : `${total} result${total === 1 ? '' : 's'}:`;
  return `${header}\n${lines.join('\n')}`;
}

function formatSymbols(symbols, relPath) {
  const lines = [];
  const walk = (list, depth) => {
    for (const symbol of list) {
      const range = symbol.range ?? symbol.location?.range;
      const kind = KIND_NAMES[symbol.kind] ?? `Kind${symbol.kind}`;
      const span = `${range.start.line + 1}-${range.end.line + 1}`;
      lines.push(`${'  '.repeat(depth)}${symbol.name} (${kind}, lines ${span})`);
      if (symbol.children?.length) walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return lines.length ? lines.join('\n') : `The language service returned no symbols for ${relPath}.`;
}

// --- tools -------------------------------------------------------------------

async function openWorkspaceDocument(vscode, ctx, filePath) {
  const { uri, relPath } = resolveFile(vscode, ctx, filePath);
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    throw new ToolError(`${relPath}: the file could not be opened as text (${err.message}).`);
  }
  await assertLanguageService(vscode, doc, relPath);
  return { doc, relPath };
}

async function overview(vscode, ctx, { file_path: filePath }) {
  const { doc, relPath } = await openWorkspaceDocument(vscode, ctx, filePath);
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
  return ok(formatSymbols(symbols ?? [], relPath));
}

async function navigate(vscode, ctx, name, { file_path: filePath, line, symbol }) {
  if (!Number.isInteger(line) || line < 1) throw new ToolError('line must be a one-based line number.');
  if (typeof symbol !== 'string' || !symbol) throw new ToolError('symbol must be a non-empty string.');
  const { doc, relPath } = await openWorkspaceDocument(vscode, ctx, filePath);
  if (line > doc.lineCount) {
    throw new ToolError(`${relPath}: line ${line} is out of range, the file has ${doc.lineCount} line${doc.lineCount === 1 ? '' : 's'}.`);
  }
  const text = doc.lineAt(line - 1).text;
  const columns = symbolColumns(vscode, doc, line - 1, text, symbol);
  if (!columns.length) {
    throw new ToolError(`${relPath}:${line} does not contain "${symbol}". Line text: ${text}`);
  }
  const command = COMMANDS[name];
  for (const character of columns) {
    const results = await vscode.commands.executeCommand(command, doc.uri, new vscode.Position(line - 1, character));
    if (results?.length) return ok(await formatLocations(vscode, ctx, results));
  }
  return ok(`The language service returned no results for "${symbol}" at ${relPath}:${line}.`);
}

const ok = text => ({ content: [{ type: 'text', text }] });
const fail = text => ({ content: [{ type: 'text', text }], isError: true });

// --- JSON-RPC ----------------------------------------------------------------

function createHandler(vscode, { rootUri, workspaceName }) {
  const ctx = {
    rootUri,
    realRoot: (() => { try { return fs.realpathSync(rootUri.fsPath); } catch { return rootUri.fsPath; } })(),
    workspaceName,
  };

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'byok-symbols', version: require('./package.json').version },
          instructions: INSTRUCTIONS,
        };
      case 'notifications/initialized':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = params?.name;
        const tool = TOOLS.find(candidate => candidate.name === name);
        if (!tool) return fail(`Unknown tool "${name}". Available: ${TOOLS.map(candidate => candidate.name).join(', ')}`);
        const args = params?.arguments ?? {};
        try {
          if (name === 'symbols_overview') return await overview(vscode, ctx, args);
          return await navigate(vscode, ctx, name, args);
        } catch (err) {
          if (err instanceof ToolError) return fail(err.message);
          throw err;
        }
      }
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  return async function handleMessage(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return undefined;
    const hasId = Object.hasOwn(message, 'id');
    try {
      const result = await dispatch(message.method, message.params);
      return hasId ? { jsonrpc: '2.0', id: message.id, result: result ?? null } : undefined;
    } catch (err) {
      if (!hasId) return undefined;
      return { jsonrpc: '2.0', id: message.id ?? null, error: { code: err.code ?? -32603, message: err.message } };
    }
  };
}

// Listens on socketPath and feeds each newline-delimited JSON-RPC message to
// handler. The socket grants full tool access to the workspace without
// credentials, so callers keep it inside an owner-only directory.
function startServer(socketPath, handler) {
  const server = net.createServer(connection => {
    let buffer = '';
    connection.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
          continue;
        }
        Promise.resolve(handler(message))
          .then(response => { if (response !== undefined) connection.write(`${JSON.stringify(response)}\n`); })
          .catch(() => {});
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { createHandler, startServer, TOOLS, INSTRUCTIONS, PROTOCOL_VERSION, MAX_RESULTS };
