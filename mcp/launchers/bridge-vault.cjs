// Windows supergateway launcher for the Vault MCP bridge.
// Spawns supergateway wrapping vault-server/server.mjs,
// serving Streamable HTTP on VAULT_BRIDGE_PORT (default 8005).
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const fs = require("fs");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.VAULT_BRIDGE_PORT || "8005";
const SERVER = path.join(REPO, "mcp", "vault-server", "server.mjs");

const SUPERGATEWAY = process.env.SUPERGATEWAY_BIN || "supergateway";

// Parse a KEY=VALUE env file (ignoring comments and blank lines).
// Handles optional single/double quotes around values.
function parseEnvFile(filePath) {
  const vars = {};
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (!m) continue;
      let val = m[2];
      if (val.length >= 2 &&
          ((val.startsWith('"') && val.endsWith('"')) ||
           (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      vars[m[1]] = val;
    }
  } catch { /* missing file → empty */ }
  return vars;
}

const cosEnv = parseEnvFile(path.join(REPO, "config", "cos.env"));
const secretsEnv = parseEnvFile(path.join(REPO, "config", "secrets.env"));

// Derive COS_VAULT_DIR from VAULT_NAME (mirrors config/load-config.sh)
const vaultName = cosEnv.VAULT_NAME || "example-vault";
const vaultDir = path.join(REPO, "vault", vaultName);

const env = {
  ...process.env,
  COS_VAULT_DIR: vaultDir,
  ANTHROPIC_API_KEY: secretsEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "",
};

const args = [
  "--stdio", `node ${SERVER}`,
  "--outputTransport", "streamableHttp",
  "--port", PORT,
  "--streamableHttpPath", "/mcp",
  "--cors",
  "--logLevel", "info",
];

console.log(`[bridge-vault] launching supergateway on :${PORT}`);
console.log(`[bridge-vault] server: ${SERVER}`);
console.log(`[bridge-vault] COS_VAULT_DIR: ${vaultDir}`);
console.log(`[bridge-vault] ANTHROPIC_API_KEY: ${env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`);

const child = spawn(SUPERGATEWAY, args, {
  env,
  cwd: REPO,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-vault] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-vault] supergateway exited with code ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
