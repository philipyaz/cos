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
//   6. The deploy ref is `main`, named, never implied: build ONLY when the checked-
//      out commit equals refs/heads/main. A parked feature branch never builds — it
//      keeps serving whatever was last built (or refuses, if nothing was).
//   7. While SERVING under a supervisor (COS_SUPERVISED=1 — set only by the launchd
//      plist; boardapp is deliberately excluded from the Windows manager and a
//      hand-run wrapper has no supervisor either), poll refs/heads/main; when it
//      moves past the built commit and HEAD is still on main, exit 0 so KeepAlive
//      respawns into a fresh build. Unsupervised runs never poll — same
//      serve-forever behaviour as before this rail existed.
//   8. Install before building when the lockfile moved: `npm ci` (reproduce the
//      lockfile — nobody is watching) when board/package-lock.json hashes
//      differently than the commit that produced the current build. An install
//      failure is a build failure — rail 4 already covers it. (The same "lockfile
//      moved -> install" predicate also lives in scripts/upgrade-check.mjs:233, the
//      human-attended `npm install` path — change one, check the other.)
//
// Rails 6-8 are decided by the pure functions in scripts/boardapp-deploy.mjs (see
// tests/boardapp-deploy.mjs) — this file only resolves inputs and acts on the result.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decideLaunch, decideServing, hashLock } from "./boardapp-deploy.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_DIR = path.join(REPO_ROOT, "board");
const NEXT_DIR = path.join(BOARD_DIR, ".next");
const PORT = process.env.BOARD_PORT && /^\d+$/.test(process.env.BOARD_PORT) ? process.env.BOARD_PORT : "3000";
const HOST = process.env.BOARD_BIND_HOST || "127.0.0.1";
const BUILT_COMMIT_FILE = path.join(NEXT_DIR, "COS_BUILT_COMMIT");
const BUILD_FAILED_FILE = path.join(NEXT_DIR, "COS_BUILD_FAILED");
const BUILT_LOCK_FILE = path.join(NEXT_DIR, "COS_BUILT_LOCK");
const LOCK_FILE = path.join(BOARD_DIR, "package-lock.json");
const DEPLOY_REF = "refs/heads/main"; // the one constant a fork would change
const POLL_MS = 60_000;

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

function mainCommit() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", DEPLOY_REF], { encoding: "utf8" }).trim();
  } catch {
    return null; // no local main (e.g. a clone holding only a feature branch)
  }
}

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

// Raw-bytes sibling of read() — a lockfile hash must cover the exact bytes, not a
// trimmed string.
const readRaw = (p) => {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
};

if ((process.env.COS_DEVICE_ROLE || "hub") === "spoke") {
  console.error("[boardapp] this machine is a SPOKE — it runs no board. Refusing to start.");
  process.exit(1);
}

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
const main = mainCommit();
const currentLock = hashLock(readRaw(LOCK_FILE));

// Rails 6/8: the whole "build / serve / refuse / throttle" decision is one pure call
// — see scripts/boardapp-deploy.mjs. This wrapper only resolves inputs and acts.
const decision = decideLaunch({
  head,
  main,
  built: read(BUILT_COMMIT_FILE),
  failed: read(BUILD_FAILED_FILE),
  hasBuild: fs.existsSync(path.join(NEXT_DIR, "BUILD_ID")),
  builtLock: read(BUILT_LOCK_FILE),
  currentLock,
});

// Resolved lazily, AFTER any install rail 8 runs (npm ci deletes node_modules before
// reinstalling — resolving this any earlier would crashloop on the missing entry for
// up to POLL_MS/wrapper-throttle purposes, bypassing rail 4 entirely).
let NEXT_BIN = null;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

switch (decision.action) {
  case "throttle":
  case "refuse-exit":
    log(`${decision.reason}. Sleeping 60s.`);
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(1);
    break;
  case "refuse-serve":
    // Never build a non-main HEAD — fall through and serve whatever was last built.
    log(decision.reason);
    break;
  case "build": {
    if (decision.installFirst) {
      log("installing (npm ci — lockfile changed since last build)…");
      try {
        execFileSync(npmCmd, ["ci"], { cwd: BOARD_DIR, stdio: "inherit", shell: process.platform === "win32" });
      } catch (e) {
        fs.mkdirSync(NEXT_DIR, { recursive: true });
        if (head !== null) fs.writeFileSync(BUILD_FAILED_FILE, head + "\n");
        console.error(`[boardapp] npm ci FAILED${head ? ` on ${head.slice(0, 8)}` : ""}:`, e.message?.split("\n")[0]);
        process.exit(1);
      }
    }
    NEXT_BIN = nextBin();
    log("building (next build)…");
    try {
      execFileSync(process.execPath, [NEXT_BIN, "build"], { cwd: BOARD_DIR, stdio: "inherit" });
      fs.mkdirSync(NEXT_DIR, { recursive: true });
      if (head !== null) fs.writeFileSync(BUILT_COMMIT_FILE, head + "\n");
      fs.rmSync(BUILD_FAILED_FILE, { force: true });
      // currentLock is what we hashed BEFORE this build ran (npm ci never rewrites
      // the lockfile) — stamp the marker from that same value, per rail 8.
      if (currentLock === null) fs.rmSync(BUILT_LOCK_FILE, { force: true });
      else fs.writeFileSync(BUILT_LOCK_FILE, currentLock + "\n");
    } catch (e) {
      fs.mkdirSync(NEXT_DIR, { recursive: true });
      if (head !== null) fs.writeFileSync(BUILD_FAILED_FILE, head + "\n");
      console.error(`[boardapp] next build FAILED${head ? ` on ${head.slice(0, 8)}` : ""}:`, e.message?.split("\n")[0]);
      process.exit(1);
    }
    break;
  }
  case "serve":
  default:
    break; // nothing to do — the existing build is current
}

if (NEXT_BIN === null) NEXT_BIN = nextBin();
log(`starting next start -H ${HOST} -p ${PORT}`);
const child = spawn(process.execPath, [NEXT_BIN, "start", "-H", HOST, "-p", PORT], { cwd: BOARD_DIR, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => child.kill(sig));
}

// deployExit distinguishes rail 7's deliberate respawn (exit 0, so KeepAlive treats
// it as healthy) from a real crash (today's signal/code passthrough, unchanged).
let deployExit = false;
child.on("exit", (code, signal) => process.exit(deployExit ? 0 : signal ? 1 : (code ?? 1)));

// Rail 7 — while serving under a supervisor, keep deciding. Gated on COS_SUPERVISED
// (set only by the launchd plist — board/boardapp.service.json) AND a resolvable
// main at startup; an unsupervised or gitless run never polls and keeps today's
// serve-forever behaviour (rails 6/8 still applied at launch, above).
if (process.env.COS_SUPERVISED === "1" && main !== null) {
  let lastLoggedReason = null;
  setInterval(() => {
    const serving = decideServing({ head: headCommit(), main: mainCommit(), built: read(BUILT_COMMIT_FILE) });
    if (serving.action === "exit-for-respawn") {
      log(serving.reason);
      deployExit = true;
      child.kill("SIGTERM"); // the exit handler above exits 0 once the child is actually gone
    } else if (serving.reason !== null && serving.reason !== lastLoggedReason) {
      log(serving.reason); // transition logging only — AC 3's "at most one line per poll"
      lastLoggedReason = serving.reason;
    }
  }, POLL_MS);
}
