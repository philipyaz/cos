#!/usr/bin/env node
// scripts/boardapp-deploy.mjs — the pure deploy DECISION behind boardapp-run.mjs's rails
// 6-8: given resolved commits/markers, decide whether to build, serve, refuse, or
// throttle, and whether an already-serving board should exit for a supervised respawn.
// No fs, no git, no env reads — every input is a value the wrapper already resolved, so
// this is testable with no launchd, no git repo and no port (ADR 0014; the effects-seam
// precedent is mcp/vault-server/jobs-runner.mjs's processOne(store, {pid, fake}) + its
// unit test).
//
// The "lockfile moved -> install" predicate also lives in scripts/upgrade-check.mjs:233
// (a git-diff-based step, human-attended, `npm install`) — this is the SAME predicate
// keyed on a content hash instead of a diff, using `npm ci` because nobody is watching.
// Change one, check the other.
import { createHash } from "node:crypto";

const short = (c) => (c ? c.slice(0, 8) : c);

// Both hashes must be KNOWN and equal for "no install needed" — a missing hash on
// either side (day one on every machine, before this ships a build with the marker) is
// "unknown what the build was compiled against", which means install.
const sameLock = (builtLock, currentLock) => builtLock !== null && currentLock !== null && builtLock === currentLock;

// decideLaunch — called once, before (re)building/starting.
//   { head, main, built, failed, hasBuild, builtLock, currentLock } → all `string|null`
//   except hasBuild: boolean.
//   → { action: "build"|"serve"|"refuse-serve"|"refuse-exit"|"throttle",
//       installFirst?: boolean, reason: string }
export function decideLaunch({ head, main, built, failed, hasBuild, builtLock, currentLock }) {
  // L1/L2 — no git (a tarball checkout). Keep today's behaviour: an existing build
  // keeps serving; with nothing built yet, build once (nothing to refuse against).
  if (head === null) {
    if (hasBuild) return { action: "serve", reason: "no git in this checkout — keeping the existing build" };
    return {
      action: "build",
      installFirst: !sameLock(builtLock, currentLock),
      reason: "no git and no existing build — building once",
    };
  }

  // L3/L4 — git works, but refs/heads/main does not resolve (e.g. a clone holding only
  // a feature branch). Rail 6's invariant is "build main or nothing" — never an
  // arbitrary HEAD — so this refuses exactly like HEAD being off main (L5/L6), just
  // for a different reason.
  if (main === null) {
    const reason = "cannot resolve refs/heads/main in this checkout — refusing to build or serve anything but main";
    return hasBuild ? { action: "refuse-serve", reason } : { action: "refuse-exit", reason };
  }

  // L5/L6 — HEAD is on a branch other than main: never build it. Serve the existing
  // build if there is one; otherwise there is nothing to do but refuse and wait.
  if (head !== main) {
    const reason = `HEAD ${short(head)} is not main (main is ${short(main)}) — refusing to build; deploys only main`;
    return hasBuild ? { action: "refuse-serve", reason } : { action: "refuse-exit", reason };
  }

  // From here head === main.

  // L7 — already built at main: serve. Lock hashes are NOT consulted for this
  // decision — a lock drift alone never triggers a rebuild (out of scope; rail 8 only
  // installs BEFORE a build this table already decided to do).
  if (hasBuild && built === head) {
    return { action: "serve", reason: `already built at ${short(head)} — serving` };
  }

  // L8 — a build is needed, but the last attempt already failed on this exact commit:
  // throttle (rail 4, unchanged) instead of hot-looping under KeepAlive.
  if (failed === head) {
    return {
      action: "throttle",
      reason: `build previously FAILED on ${short(head)} — not retrying until the checkout moves`,
    };
  }

  // L9 — a build is needed and this commit hasn't failed before: build. Install first
  // unless both lock hashes are known and equal.
  return {
    action: "build",
    installFirst: !sameLock(builtLock, currentLock),
    reason: `building main at ${short(head)}`,
  };
}

// decideServing — polled on an interval while a build is already up (rail 7,
// supervised only).
//   { head, main, built } → all `string|null`.
//   → { action: "exit-for-respawn"|"keep", reason: string|null }
// A null reason means "nothing worth a log line" — the wrapper logs non-null reasons
// on transition only, so a parked hub prints at most one line per poll (AC 3).
export function decideServing({ head, main, built }) {
  // S1 — no frame to compare against yet.
  if (main === null || built === null) return { action: "keep", reason: null };

  // S2 — already serving what main points at.
  if (main === built) return { action: "keep", reason: null };

  // S3 — main moved past the served build, and HEAD is on main: exit for a respawn,
  // which rebuilds through the launch decision above.
  if (head === main) {
    return {
      action: "exit-for-respawn",
      reason: `deploy ref moved ${short(built)} → ${short(main)} — exiting for a supervised respawn`,
    };
  }

  // S4 — main moved, but HEAD is parked off main (or gitless): the non-droppable
  // anti-crashloop guard. There is nothing this process would build, so never exit.
  return {
    action: "keep",
    reason: `main moved past the served build, but HEAD (${head === null ? "no git" : short(head)}) is not main — staying up, not building`,
  };
}

// hashLock — sha256 over the lockfile's raw bytes (or null when there's nothing to
// hash: a missing file, or a build recorded before this marker existed).
export function hashLock(bufOrNull) {
  if (bufOrNull === null || bufOrNull === undefined) return null;
  return createHash("sha256").update(bufOrNull).digest("hex");
}
