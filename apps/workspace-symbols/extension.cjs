//! Registers workspace-local semantic search and language-server MCP entry points.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHandler, startServer } = require('./navigation.cjs');

function activate(context, vscode = require('vscode')) {
  const { workspace } = vscode;
  if (!workspace.isTrusted) return;
  context.subscriptions.push(vscode.commands.registerCommand('byok.checkInferenceRoute', () => {
    if (!vscode.env.remoteName) return vscode.window.showInformationMessage('Local workspace: remoteInferenceRoute does not apply.');
    const scope = vscode.window.activeTextEditor?.document.uri ?? workspace.workspaceFolders?.[0]?.uri;
    const route = workspace.getConfiguration('cursorAgentHost', scope).get('remoteInferenceRoute');
    if (route !== 'always') {
      return vscode.window.showWarningMessage(`Remote window: cursorAgentHost.remoteInferenceRoute = ${route ?? 'not available'}. For local BYOK set it to always in Remote Settings and reload this window. If unavailable, check your Cursor version.`);
    }
    return vscode.window.showInformationMessage('Remote window configured for local inference (always). Reload this window after changes. Private-inference policy can override this setting.');
  }));
  const mcp = vscode.cursor?.mcp;
  if (!mcp?.registerServer || !mcp.unregisterServer) {
    throw new Error('BYOK Workspace Symbols requires Cursor’s MCP registration API.');
  }

  const semanticBinary = resolveSemanticBinary(context, vscode);

  // MCP servers are plain stdio processes and cannot call the vscode API, so each
  // workspace root gets a socket the extension host answers on; the registered
  // command is a tiny relay that pipes stdio to that socket. ELECTRON_RUN_AS_NODE
  // makes process.execPath (the Cursor binary on the workspace host) behave like
  // plain node. The socket lives in a private mkdtemp directory: globalStorage
  // paths routinely exceed the 104-byte sun_path limit on macOS, and the 0700
  // directory is what restricts access.
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-'));
  context.subscriptions.push({ dispose() { fs.rmSync(socketDir, { recursive: true, force: true }); } });
  const registered = new Map();
  const pending = [];
  function add(folder) {
    const uri = folder.uri.toString();
    if (registered.has(uri)) return;
    const slug = folder.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
    const id = createHash('sha256').update(uri).digest('hex').slice(0, 10);
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\byok-symbols-${id}`
      : path.join(socketDir, `s-${id}.sock`);
    const entry = { names: [`symbols-${slug}-${id}`, `semantic-${slug}-${id}`], socketPath, server: null };
    entry.ready = startServer(socketPath, createHandler(vscode, { rootUri: folder.uri, workspaceName: folder.name }))
      .then(server => { entry.server = server; })
      .catch(err => console.error(`byok-symbols: cannot listen on ${socketPath}: ${err.message}`));
    pending.push(entry.ready);
    registered.set(uri, entry);
    mcp.registerServer({ name: entry.names[0], server: {
      command: process.execPath,
      args: [context.asAbsolutePath('relay.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', BYOK_SYMBOLS_SOCKET: socketPath },
    } });
    if (semanticBinary) {
      mcp.registerServer({ name: entry.names[1], server: {
        command: semanticBinary,
        args: [folder.uri.fsPath],
        env: {},
      } });
    }
  }
  function remove(uri) {
    const entry = registered.get(uri);
    if (entry === undefined) return;
    for (const name of entry.names) mcp.unregisterServer(name);
    registered.delete(uri);
    const close = () => {
      entry.server?.close();
      // Windows named pipes leave no file behind.
      if (process.platform !== 'win32') fs.rmSync(entry.socketPath, { force: true });
    };
    if (entry.server) close();
    else entry.ready.then(close, close);
  }
  context.subscriptions.push({ dispose() { for (const uri of registered.keys()) remove(uri); } });
  for (const folder of workspace.workspaceFolders ?? []) add(folder);
  context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
    for (const folder of removed) remove(folder.uri.toString());
    for (const folder of added) add(folder);
  }));
  // The host ignores activate's return value; tests await ready for the sockets.
  return { ready: Promise.all(pending) };
}

// The VSIX bundles one byok-semantic per supported platform under bin/. VS Code
// extension extraction does not restore the Unix executable bit, so an
// unpacked binary needs its mode repaired before it can be spawned.
function resolveSemanticBinary(context, vscode) {
  const file = process.platform === 'win32' ? 'byok-semantic.exe' : 'byok-semantic';
  const binary = context.asAbsolutePath(path.join('bin', `${process.platform}-${process.arch}`, file));
  try {
    if (process.platform !== 'win32' && !(fs.statSync(binary).mode & 0o111)) {
      fs.chmodSync(binary, 0o755);
    }
    return binary;
  } catch (err) {
    const why = err?.code === 'ENOENT' ? 'is missing' : `cannot be marked executable (${err.message})`;
    vscode.window?.showErrorMessage(
      `BYOK Workspace Symbols: the bundled byok-semantic for ${process.platform}-${process.arch} ${why} at ${binary}; semantic code search is unavailable. Reinstall the extension to repair it.`,
    );
    return null;
  }
}
module.exports = { activate };
