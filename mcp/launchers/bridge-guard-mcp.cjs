// Windows supergateway launcher for the Guard MCP bridge.
// Spawns supergateway wrapping guard-server/server.mjs,
// serving Streamable HTTP on GUARD_BRIDGE_PORT (default 8004).
// Sets COS_GUARD_URL so the MCP server can reach the sidecar.
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.GUARD_BRIDGE_PORT || "8004";
const SIDECAR_PORT = process.env.GUARD_SIDECAR_PORT || "8009";
const SERVER = path.join(REPO, "mcp", "guard-server", "server.mjs");

const SUPERGATEWAY = process.env.SUPERGATEWAY_BIN || "supergateway";

const env = {
  ...process.env,
  COS_GUARD_URL: process.env.COS_GUARD_URL || `http://127.0.0.1:${SIDECAR_PORT}`,
};

const args = [
  "--stdio", `node ${SERVER}`,
  "--outputTransport", "streamableHttp",
  "--port", PORT,
  "--streamableHttpPath", "/mcp",
  "--cors",
  "--logLevel", "info",
];

console.log(`[bridge-guard-mcp] launching supergateway on :${PORT}`);
console.log(`[bridge-guard-mcp] server: ${SERVER}`);
console.log(`[bridge-guard-mcp] COS_GUARD_URL: ${env.COS_GUARD_URL}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-guard-mcp] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-guard-mcp] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

// Forward SIGTERM/SIGINT to child for clean pm2 stop.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
