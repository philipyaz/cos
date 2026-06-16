// Windows supergateway launcher for the Nutrition MCP bridge.
// Spawns supergateway wrapping nutrition-server/server.mjs,
// serving Streamable HTTP on NUTRITION_BRIDGE_PORT (default 8007).
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.NUTRITION_BRIDGE_PORT || "8007";
const SERVER = path.join(REPO, "mcp", "nutrition-server", "server.mjs");

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

console.log(`[bridge-nutrition] launching supergateway on :${PORT}`);
console.log(`[bridge-nutrition] server: ${SERVER}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-nutrition] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-nutrition] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
