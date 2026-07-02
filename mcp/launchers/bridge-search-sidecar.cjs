// Windows launcher for the Search sidecar (FastAPI/uvicorn).
// Spawns: cd search && uv run uvicorn sidecar:app --port 8008
//
// Used by ecosystem.config.cjs (pm2) instead of a launchd plist.
// A .cjs file avoids MSYS path mangling that breaks args when bash is
// in the spawn chain.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = process.env.SEARCH_SIDECAR_PORT || "8008";
const SEARCH_DIR = path.join(REPO, "search");

const UV = process.env.UV_BIN || "uv";

const args = [
  "run", "uvicorn", "sidecar:app",
  "--host", "127.0.0.1",
  "--port", PORT,
];

console.log(`[bridge-search-sidecar] launching uvicorn on :${PORT}`);
console.log(`[bridge-search-sidecar] cwd: ${SEARCH_DIR}`);

const child = spawn(UV, args, {
  cwd: SEARCH_DIR,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`[bridge-search-sidecar] spawn error: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[bridge-search-sidecar] uvicorn exited with code ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
