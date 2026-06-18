// Windows supergateway launcher for the Jobs MCP bridge.
// Spawns supergateway wrapping jobs-server/server.mjs,
// serving Streamable HTTP on JOBS_BRIDGE_PORT (default 8012).
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.JOBS_BRIDGE_PORT || "8012";
const SERVER = path.join(REPO, "mcp", "jobs-server", "server.mjs");

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

console.log(`[bridge-jobs] launching supergateway on :${PORT}`);
console.log(`[bridge-jobs] server: ${SERVER}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-jobs] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-jobs] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
