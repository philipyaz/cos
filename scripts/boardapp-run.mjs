#!/usr/bin/env node
// scripts/boardapp-run.mjs — the build-then-start entry for the board under launchd
// (the `boardapp` service: an always-on hub runs the board as a PRODUCTION service,
// not a foreground `next dev` in a terminal). launchd KeepAlive supervises THIS
// process; it decides whether a build is needed, then execs `next start`.
//
// Safety rails, in order:
//   1. A spoke must never boot a board — refuse on COS_DEVICE_ROLE=spoke.
//   2. NEVER build while another board serves on the port: `next build` clobbers
//      the shared .next of a live `next dev` (the documented 500-until-restart
//      gotcha). If something is listening, exit non-zero and let launchd throttle.
//   3. Build only when the CHECKED-OUT COMMIT changed since the last successful
//      build (recorded in .next/COS_BUILT_COMMIT) — a timestamp is not enough:
//      a `git pull` can land a commit whose files predate the last build's mtime.
//   4. Don't hot-loop on a broken build: a failed `next build` records the failing
//      commit in .next/COS_BUILD_FAILED; a KeepAlive respawn on the SAME commit
//      exits 0 after a short sleep instead of rebuilding (until the commit moves).
//   5. Bind the production board to 127.0.0.1 (BOARD_BIND_HOST overrides) — the
//      board is exposed to other devices via `tailscale serve`, never by binding
//      the raw app to 0.0.0.0 (that would serve the unauthenticated API to the LAN).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_DIR = path.join(REPO_ROOT, "board");
const NEXT_DIR = path.join(BOARD_DIR, ".next");
const PORT = process.env.BOARD_PORT && /^\d+$/.test(process.env.BOARD_PORT) ? process.env.BOARD_PORT : "3000";
const HOST = process.env.BOARD_BIND_HOST || "127.0.0.1";
const BUILT_COMMIT_FILE = path.join(NEXT_DIR, "COS_BUILT_COMMIT");
const BUILD_FAILED_FILE = path.join(NEXT_DIR, "COS_BUILD_FAILED");

const log = (...a) => console.log(new Date().toISOString(), "[boardapp]", ...a);

// Run Next through its JS entrypoint on THIS node (not the .bin/next shim), so the
// service is cross-platform — the shim is a POSIX symlink that does not exist on
// Windows (mcp/CLAUDE.md's "wire both platforms in the same change").
function nextBin() {
  const entry = path.join(BOARD_DIR, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(entry)) {
    console.error(`[boardapp] ${entry} missing — run \`cd board && npm install\` first.`);
    process.exit(1);
  }
  return entry;
}

function headCommit() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null; // tarball checkout (no git) — treated as "always current build"
  }
}

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

if ((process.env.COS_DEVICE_ROLE || "hub") === "spoke") {
  console.error("[boardapp] this machine is a SPOKE — it runs no board. Refusing to start.");
  process.exit(1);
}
const NEXT_BIN = nextBin();

// Anything already listening on the board port means a board (usually `next dev`)
// is live — building now would clobber its .next. Exit and let launchd retry later.
const portBusy = await new Promise((resolve) => {
  const sock = net.connect({ port: Number(PORT), host: "127.0.0.1" });
  const done = (busy) => {
    sock.destroy();
    resolve(busy);
  };
  sock.once("connect", () => done(true));
  sock.once("error", () => done(false));
  sock.setTimeout(1000, () => done(false));
});
if (portBusy) {
  console.error(
    `[boardapp] something is already listening on :${PORT} (a dev board?) — refusing to build/start over it.`,
  );
  process.exit(1);
}

const head = headCommit();

// Build when there is no build, or the checkout moved to a different commit since
// the last SUCCESSFUL build. A missing git (no head) keeps the existing build.
let needBuild = !fs.existsSync(path.join(NEXT_DIR, "BUILD_ID"));
if (!needBuild && head !== null && read(BUILT_COMMIT_FILE) !== head) needBuild = true;

if (needBuild) {
  // Crashloop backstop: if the LAST build failed on THIS exact commit, don't rebuild
  // on every KeepAlive respawn — sleep and exit so launchd throttles until the commit
  // moves (a fix is pulled). Cleared implicitly when head changes (marker won't match).
  if (head !== null && read(BUILD_FAILED_FILE) === head) {
    log(`build previously FAILED on ${head.slice(0, 8)} — not retrying until the checkout moves. Sleeping 60s.`);
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(1);
  }
  log("building (next build)…");
  try {
    execFileSync(process.execPath, [NEXT_BIN, "build"], { cwd: BOARD_DIR, stdio: "inherit" });
    fs.mkdirSync(NEXT_DIR, { recursive: true });
    if (head !== null) fs.writeFileSync(BUILT_COMMIT_FILE, head + "\n");
    fs.rmSync(BUILD_FAILED_FILE, { force: true });
  } catch (e) {
    fs.mkdirSync(NEXT_DIR, { recursive: true });
    if (head !== null) fs.writeFileSync(BUILD_FAILED_FILE, head + "\n");
    console.error(`[boardapp] next build FAILED${head ? ` on ${head.slice(0, 8)}` : ""}:`, e.message?.split("\n")[0]);
    process.exit(1);
  }
}

log(`starting next start -H ${HOST} -p ${PORT}`);
const child = spawn(process.execPath, [NEXT_BIN, "start", "-H", HOST, "-p", PORT], { cwd: BOARD_DIR, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
