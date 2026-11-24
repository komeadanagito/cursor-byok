//! Bridges stdio MCP traffic to the workspace-symbols socket served by the extension host.
// Runs under `node` (spawned with ELECTRON_RUN_AS_NODE from the Cursor binary):
// MCP servers are plain stdio processes and cannot reach the vscode API, so the
// extension listens on a local socket and this process copies bytes between the
// agent's stdio and that socket. The path arrives via BYOK_SYMBOLS_SOCKET.
const net = require('node:net');

const socketPath = process.env.BYOK_SYMBOLS_SOCKET;
if (!socketPath) {
  console.error('byok-symbols relay: BYOK_SYMBOLS_SOCKET is not set; the extension passes the socket path through the MCP server environment.');
  process.exit(1);
}

const socket = net.connect(socketPath);
socket.once('error', err => {
  console.error(`byok-symbols relay: cannot connect to ${socketPath}: ${err.message}`);
  process.exit(1);
});
socket.once('connect', () => {
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
});
socket.once('close', () => process.exit(0));
process.stdin.once('end', () => socket.end());
