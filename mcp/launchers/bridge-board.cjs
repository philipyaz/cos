// Windows supergateway launcher for the Board MCP bridge.
// Spawns supergateway wrapping board-server/server.mjs,
// serving Streamable HTTP on BOARD_BRIDGE_PORT (default 8001).
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.BOARD_BRIDGE_PORT || "8001";
const SERVER = path.join(REPO, "mcp", "board-server", "server.mjs");

const SUPERGATEWAY = process.env.SUPERGATEWAY_BIN || "supergateway";

const env = { ...process.env };

const args = [
  "--stdio", `node ${SERVER}`,
  "--outputTransport", "streamableHttp",
  "--port", PORT,
  "--streamableHttpPath", "/mcp",
  "--cors",
  "--logLevel", "info",
];

console.log(`[bridge-board] launching supergateway on :${PORT}`);
console.log(`[bridge-board] server: ${SERVER}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-board] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-board] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
