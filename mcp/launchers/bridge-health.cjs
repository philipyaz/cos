// Windows supergateway launcher for the health MCP bridge.
// Spawns supergateway as a child process wrapping the health stdio server,
// serving Streamable HTTP on HEALTH_BRIDGE_PORT (default 8011).
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.HEALTH_BRIDGE_PORT || "8011";
const SERVER = path.join(REPO, "mcp", "health-server", "server.mjs");

// Resolve supergateway: prefer the env var, fall back to global install.
const SUPERGATEWAY = process.env.SUPERGATEWAY_BIN || "supergateway";

// Load secrets (HEALTH_PUSH_TOKEN may live in cos.env or secrets.env).
const env = { ...process.env };

const args = [
  "--stdio", `node ${SERVER}`,
  "--outputTransport", "streamableHttp",
  "--port", PORT,
  "--streamableHttpPath", "/mcp",
  "--cors",
  "--logLevel", "info",
];

console.log(`[bridge-health] launching supergateway on :${PORT}`);
console.log(`[bridge-health] server: ${SERVER}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-health] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-health] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

// Forward SIGTERM/SIGINT to child for clean pm2 stop.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
