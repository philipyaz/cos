// Windows launcher for the Guard sidecar (FastAPI/uvicorn).
// Spawns: cd guard && uv run uvicorn sidecar:app --port 8009
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.GUARD_SIDECAR_PORT || "8009";
const GUARD_DIR = path.join(REPO, "guard");

const UV = process.env.UV_BIN || "uv";

const args = [
  "run", "uvicorn", "sidecar:app",
  "--host", "127.0.0.1",
  "--port", PORT,
];

console.log(`[bridge-guard-sidecar] launching uvicorn on :${PORT}`);
console.log(`[bridge-guard-sidecar] cwd: ${GUARD_DIR}`);

const child = spawn(UV, args, {
  cwd: GUARD_DIR,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-guard-sidecar] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-guard-sidecar] uvicorn exited with code ${code}`);
  process.exit(code ?? 1);
});

// Forward SIGTERM/SIGINT to child for clean pm2 stop.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
