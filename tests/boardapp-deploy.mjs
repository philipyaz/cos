#!/usr/bin/env node
// tests/boardapp-deploy.mjs — scripts/boardapp-deploy.mjs is the PURE decision behind
// boardapp-run.mjs's rails 6-8 (build only `main`; exit for a supervised respawn when
// `main` moves while serving; `npm ci` first when the lockfile moved); pin its table so
// a refactor can't silently change what a launchd respawn does to the live board. Plus
// structural pins on boardapp-run.mjs itself — the table is worthless if the wrapper
// stops consuming it. Hermetic: no board, no launchd, no git, no env, no live data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideLaunch, decideServing, hashLock } from "../scripts/boardapp-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
let failed = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failed++;
};

const HEAD = "a7d971f0000000000000000000000000000000";
const MAIN = "509da8b0000000000000000000000000000000";
const OTHER = "580ec3f0000000000000000000000000000000";
const short = (c) => c.slice(0, 8);

console.log("boardapp-deploy · decideLaunch");

// L1 — no git, an existing build: keep serving it, never build.
check(
  decideLaunch({ head: null, main: null, built: null, failed: null, hasBuild: true, builtLock: null, currentLock: null }).action === "serve",
  "L1: no git + existing build → serve",
);

// L2 — no git, no build (first boot off a tarball): build once. installFirst follows
// the same lock rule as L9 (a null builtLock means "unknown" → install).
{
  const d = decideLaunch({ head: null, main: null, built: null, failed: null, hasBuild: false, builtLock: null, currentLock: "abc" });
  check(d.action === "build", "L2: no git + no build → build");
  check(d.installFirst === true, "L2: installFirst follows the L9 lock rule (null builtLock → install)");
}

// L3/L4 — git works but refs/heads/main does not resolve: refuse, never build an
// arbitrary HEAD. hasBuild decides refuse-serve (something to fall back to) vs
// refuse-exit (nothing to serve).
{
  const d3 = decideLaunch({ head: HEAD, main: null, built: MAIN, failed: null, hasBuild: true, builtLock: null, currentLock: null });
  check(d3.action === "refuse-serve", "L3: HEAD resolves, main doesn't, a build exists → refuse-serve");
  check(/refs\/heads\/main/.test(d3.reason), "L3: reason names the unresolvable deploy ref");
  const d4 = decideLaunch({ head: HEAD, main: null, built: null, failed: null, hasBuild: false, builtLock: null, currentLock: null });
  check(d4.action === "refuse-exit", "L4: same, but no build exists → refuse-exit");
  check(/refs\/heads\/main/.test(d4.reason), "L4: reason also names the unresolvable ref");
}

// L5/L6 — HEAD is on a branch other than main. Never build it; the reason names BOTH
// commits (this is the log line AC 1 asks for).
{
  const d5 = decideLaunch({ head: HEAD, main: MAIN, built: OTHER, failed: null, hasBuild: true, builtLock: null, currentLock: null });
  check(d5.action === "refuse-serve", "L5: HEAD off main, a build exists → refuse-serve (keeps serving it)");
  check(d5.reason.includes(short(HEAD)) && d5.reason.includes(short(MAIN)), "L5: reason names both short commits");
  const d6 = decideLaunch({ head: HEAD, main: MAIN, built: null, failed: null, hasBuild: false, builtLock: null, currentLock: null });
  check(d6.action === "refuse-exit", "L6: HEAD off main, no build exists → refuse-exit");
  check(d6.reason.includes(short(HEAD)) && d6.reason.includes(short(MAIN)), "L6: reason also names both commits");
}

// L7 — HEAD is main and the current build already IS main: serve, and locks are never
// consulted for this decision (a lock drift alone never triggers a rebuild — out of
// scope per the plan; only "install before build" is rail 8's job).
{
  const d = decideLaunch({ head: MAIN, main: MAIN, built: MAIN, failed: null, hasBuild: true, builtLock: "aaa", currentLock: "bbb" });
  check(d.action === "serve", "L7: HEAD == main == built → serve, even with differing lock hashes");
}

// L8 — a build is needed but the LAST build already failed on this exact commit:
// throttle (rail 4, verbatim, unchanged).
{
  const d = decideLaunch({ head: MAIN, main: MAIN, built: OTHER, failed: MAIN, hasBuild: true, builtLock: null, currentLock: null });
  check(d.action === "throttle", "L8: build needed, already FAILED on this commit → throttle, not retried");
}

// L9 — a build is needed, not previously failed here: build. installFirst is false
// ONLY when both lock hashes are known and equal; a missing hash on either side, or a
// mismatch, means install (a missing COS_BUILT_LOCK — day one on every machine —
// must heal itself on the very next deploy).
{
  const needsBuild = { head: MAIN, main: MAIN, built: OTHER, failed: null, hasBuild: true };
  check(decideLaunch({ ...needsBuild, builtLock: "x", currentLock: "x" }).action === "build", "L9: build needed, not failed-here → build");
  check(decideLaunch({ ...needsBuild, builtLock: "x", currentLock: "x" }).installFirst === false, "L9: installFirst=false — both hashes known and equal");
  check(decideLaunch({ ...needsBuild, builtLock: null, currentLock: "x" }).installFirst === true, "L9: installFirst=true — builtLock unknown (day-one heal)");
  check(decideLaunch({ ...needsBuild, builtLock: "x", currentLock: null }).installFirst === true, "L9: installFirst=true — currentLock unreadable");
  check(decideLaunch({ ...needsBuild, builtLock: "x", currentLock: "y" }).installFirst === true, "L9: installFirst=true — hashes differ");
  check(decideLaunch({ ...needsBuild, hasBuild: false, builtLock: "x", currentLock: "x" }).action === "build", "L9: also reached via !hasBuild (no BUILD_ID yet)");
}

console.log("boardapp-deploy · decideServing");

// S1 — nothing to compare against (no local main, or nothing built yet): stay quiet.
check(
  JSON.stringify(decideServing({ head: MAIN, main: null, built: MAIN })) === JSON.stringify({ action: "keep", reason: null }),
  "S1: main unresolvable → keep, no frame (reason null)",
);
check(
  JSON.stringify(decideServing({ head: MAIN, main: MAIN, built: null })) === JSON.stringify({ action: "keep", reason: null }),
  "S1: nothing built yet → keep, no frame (reason null)",
);

// S2 — already serving what main points at: quiet.
check(
  JSON.stringify(decideServing({ head: MAIN, main: MAIN, built: MAIN })) === JSON.stringify({ action: "keep", reason: null }),
  "S2: main == built → keep, quiet (reason null)",
);

// S3 — main moved past the served build, and HEAD is on main (checked out on the main
// BRANCH, so HEAD tracks main's new tip exactly): exit for a respawn. The reason names
// both commits (built -> main) for the transition log line.
{
  const d = decideServing({ head: OTHER, main: OTHER, built: MAIN });
  check(d.action === "exit-for-respawn", "S3: main moved, HEAD is main → exit-for-respawn");
  check(d.reason !== null && d.reason.includes(short(MAIN)) && d.reason.includes(short(OTHER)), "S3: reason names built and the new main");
}

// S4 — main moved, but HEAD is parked off main (or gitless): the anti-crashloop guard.
// Never exit here — there is nothing this process could build anyway.
{
  const d = decideServing({ head: HEAD, main: OTHER, built: MAIN });
  check(d.action === "keep", "S4: main moved, HEAD off main → keep (never exit for a build we won't do)");
  check(d.reason !== null, "S4: reason is non-null (the wrapper's transition log needs text)");
  const dGitless = decideServing({ head: null, main: OTHER, built: MAIN });
  check(dGitless.action === "keep", "S4: also covers the gitless case (head === null)");
}

console.log("boardapp-deploy · hashLock");
check(hashLock(null) === null, "hashLock(null) → null");
check(hashLock(undefined) === null, "hashLock(undefined) → null");
{
  const a = Buffer.from("next 16.3.0\n");
  const aAgain = Buffer.from("next 16.3.0\n");
  const b = Buffer.from("next 16.2.10\n");
  check(typeof hashLock(a) === "string" && hashLock(a).length === 64, "hashLock: returns a hex sha256 (64 chars) for a buffer");
  check(hashLock(a) === hashLock(aAgain), "hashLock: identical bytes → identical hash");
  check(hashLock(a) !== hashLock(b), "hashLock: different bytes → different hash");
}

console.log("boardapp-deploy · structural pins on the wrapper + descriptor");
const runnerSrc = fs.readFileSync(path.join(REPO, "scripts", "boardapp-run.mjs"), "utf8");
check(runnerSrc.includes('from "./boardapp-deploy.mjs"'), "boardapp-run.mjs imports the decision module");
check(runnerSrc.includes("decideLaunch("), "boardapp-run.mjs calls decideLaunch(...)");
check(runnerSrc.includes("decideServing("), "boardapp-run.mjs calls decideServing(...)");
check(runnerSrc.includes("refs/heads/main"), "boardapp-run.mjs pins the deploy ref as refs/heads/main (rail 6's named constant)");
check(runnerSrc.includes('["ci"]'), 'boardapp-run.mjs runs `npm ci` (rail 8 — a lockfile-triggered install, not `npm install`)');
check(runnerSrc.includes("setInterval("), "boardapp-run.mjs polls while serving (rail 7)");
check(runnerSrc.includes("COS_SUPERVISED"), "boardapp-run.mjs gates the self-exit on COS_SUPERVISED (supervised platforms only)");

const serviceJson = JSON.parse(fs.readFileSync(path.join(REPO, "board", "boardapp.service.json"), "utf8"));
check(serviceJson.env?.COS_SUPERVISED === "1", "board/boardapp.service.json names its supervisor: env.COS_SUPERVISED = \"1\"");

const deploySrc = fs.readFileSync(path.join(REPO, "scripts", "boardapp-deploy.mjs"), "utf8");
check(
  !deploySrc.includes("readFileSync") && !deploySrc.includes("execFileSync") && !deploySrc.includes("process.env"),
  "scripts/boardapp-deploy.mjs stays pure — no fs reads, no exec, no env (the effects seam can't silently re-absorb effects)",
);

console.log(failed ? `\nFAIL — ${failed} boardapp-deploy check(s) failed.` : "\nPASS — boardapp-deploy: decideLaunch + decideServing + hashLock + wrapper wiring.");
process.exit(failed ? 1 : 0);
