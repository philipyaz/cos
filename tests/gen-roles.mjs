#!/usr/bin/env node
// gen-roles.mjs — hermetic contract test for the device-role plumbing in the
// service manifest + generators (multi-device PR 3). NO board, NO network, NO
// launchd: it drives the manifest CLI and gen-launchd's inspection modes, plus
// the loopback preload's actual bind behavior via a throwaway node http server.
//
// Asserts:
//   • the probe-list carries the roles + label columns; boardapp/backup exist,
//     hub-only; the board-facing wrappers declare hub+spoke;
//   • gen-launchd renders bridges through `node --require loopback-bind.cjs`
//     (supergateway has no bind-host option) and renders the backup job as a
//     SCHEDULED plist (StartCalendarInterval, no KeepAlive) under its historical
//     label com.chiefofstaff.backup;
//   • role scoping: a SPOKE's default install set is only the spoke-capable core
//     bridges; explicitly naming a hub-only service on a spoke is a LOUD error;
//   • the loader hard-fails on spoke + localhost BOARD_URL (the one misconfig
//     that would silently mint a second state machine) and on an invalid role;
//   • the loopback preload pins a host-less listen() to 127.0.0.1 and leaves an
//     explicit host untouched.
//
// Run directly (node tests/gen-roles.mjs) or via tests/run.sh step [13f].
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COS_ROOT = path.resolve(HERE, "..");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Run a node script; capture {code, out} (stdout+stderr merged).
function run(cmd, args, extraEnv = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", cwd: COS_ROOT, env: { ...process.env, ...extraEnv } });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A hub URL that satisfies the loader's spoke misconfig guard in spoke-role runs.
const HUB_URL = { BOARD_URL: "http://hub.example.ts.net:3000" };

async function main() {
  console.log("gen-roles · manifest + generator role contract");

  // ── [1] probe-list: roles + label columns ─────────────────────────────────
  let r = run("node", ["mcp/service-manifest.mjs", "--probe-list"]);
  check(r.code === 0, `probe-list resolves (exit ${r.code})`);
  const rows = Object.fromEntries(
    r.out.trim().split("\n").map((l) => {
      const [name, port, kind, probe, gate, roles, autostart, label] = l.split("\t");
      return [name, { port, kind, probe, gate, roles, autostart, label }];
    }),
  );
  check(rows.board?.roles === "hub,spoke", `board wrapper is hub+spoke (got ${rows.board?.roles})`);
  check(rows.calendar?.roles === "hub,spoke" && rows.nutrition?.roles === "hub,spoke", "calendar + nutrition wrappers are hub+spoke");
  check(rows.vault?.roles === "hub" && rows.guard?.roles === "hub", "vault + guard are hub-only");
  check(rows.boardapp?.roles === "hub" && rows.boardapp?.kind === "sidecar", "boardapp exists, hub-only sidecar");
  check(rows.boardapp?.autostart === "0", "boardapp is autostart=0 (never launched by the predev nudge)");
  check(rows.board?.autostart === "1", "the board bridge is autostart=1");
  check(rows.backup?.roles === "hub" && rows.backup?.probe === "scheduled", "backup exists, hub-only, scheduled probe");
  check(rows.backup?.label === "com.chiefofstaff.backup", `backup keeps its historical label (got ${rows.backup?.label})`);

  // ── [2] gen-launchd rendering: loopback preload + scheduled plist ─────────
  r = run("node", ["scripts/gen-launchd.mjs", "--print", "board"]);
  check(r.code === 0 && /--require/.test(r.out) && /loopback-bind\.cjs/.test(r.out), "bridge plists spawn supergateway through the loopback preload");
  r = run("node", ["scripts/gen-launchd.mjs", "--print", "backup"]);
  check(r.code === 0 && /StartCalendarInterval/.test(r.out) && /<integer>3<\/integer>/.test(r.out), "backup plist is StartCalendarInterval 03:30");
  check(!/KeepAlive/.test(r.out), "a scheduled job has no KeepAlive (it would loop)");
  check(/com\.chiefofstaff\.backup</.test(r.out), "backup plist uses the historical label");
  r = run("node", ["scripts/gen-launchd.mjs", "--print", "boardapp"]);
  check(r.code === 0 && /boardapp-run\.mjs/.test(r.out) && /KeepAlive/.test(r.out), "boardapp plist runs the build-then-start entry under KeepAlive");
  // Generation must NOT require supergateway to be installed HERE (it's a pure text step;
  // the plist resolves the path at launchd-load time on the target machine, and CI has no
  // supergateway). Force the resolver to miss and assert it still renders the conventional
  // dist path — this is the exact condition that only shows up when supergateway is ABSENT.
  r = run("node", ["scripts/gen-launchd.mjs", "--print", "board"], { SUPERGATEWAY_BIN: "/nonexistent/supergateway" });
  check(
    r.code === 0 && /supergateway\/dist\/index\.js/.test(r.out),
    "a bridge plist still renders when supergateway is NOT installed (generation never requires the binary)",
  );

  // ── [3] role scoping in gen-launchd ────────────────────────────────────────
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-gen-roles-"));
  r = run("node", ["scripts/gen-launchd.mjs", "--out", outDir], { COS_DEVICE_ROLE: "spoke", ...HUB_URL });
  const written = fs.readdirSync(outDir).sort();
  check(
    r.code === 0 && written.join(",") === "com.chiefofstaff.mcp-board.plist,com.chiefofstaff.mcp-calendar.plist",
    `a spoke's default install set is exactly the spoke-capable core bridges (got ${written.join(",") || "none"})`,
  );
  r = run("node", ["scripts/gen-launchd.mjs", "--out", outDir, "vault"], { COS_DEVICE_ROLE: "spoke", ...HUB_URL });
  check(r.code !== 0 && /does not run on a spoke/.test(r.out), "explicitly naming a hub-only service on a spoke is a loud error");
  fs.rmSync(outDir, { recursive: true, force: true });

  // ── [4] the loader's role guards ──────────────────────────────────────────
  r = run("sh", ["-c", ". config/load-config.sh && echo OK"], { COS_DEVICE_ROLE: "spoke" });
  check(r.code !== 0 && /localhost default/.test(r.out), "loader hard-fails on spoke + localhost BOARD_URL");
  r = run("sh", ["-c", ". config/load-config.sh && echo OK"], { COS_DEVICE_ROLE: "spoke", ...HUB_URL });
  check(r.code === 0 && /OK/.test(r.out), "loader accepts spoke + a real hub BOARD_URL");
  r = run("sh", ["-c", ". config/load-config.sh && echo OK"], { COS_DEVICE_ROLE: "gateway" });
  check(r.code !== 0 && /invalid/.test(r.out), "loader hard-fails on an unknown role");
  // The Node keystone must PROPAGATE the loader's hard-fail (not swallow it into a partial env).
  r = run("node", ["-e", "import('./config/load-config.mjs').then(m=>{try{m.loadConfig();process.exit(0)}catch{process.exit(7)}})"], { COS_DEVICE_ROLE: "gateway" });
  check(r.code === 7, "load-config.mjs throws (does not swallow) on the loader's role refusal");

  // ── [5] the loopback preload's actual bind behavior ───────────────────────
  const probe = (code) =>
    run("node", ["--require", path.join(COS_ROOT, "scripts", "loopback-bind.cjs"), "-e", code]);
  r = probe(
    "const s=require('http').createServer(()=>{});s.listen(0,()=>{console.log(s.address().address);s.close()})",
  );
  check(r.code === 0 && r.out.trim() === "127.0.0.1", `host-less listen() pinned to 127.0.0.1 (got ${r.out.trim()})`);
  r = probe(
    "const s=require('http').createServer(()=>{});s.listen(0,'0.0.0.0',()=>{console.log(s.address().address);s.close()})",
  );
  check(r.code === 0 && r.out.trim() === "0.0.0.0", "an EXPLICIT host passes through untouched");

  if (failures > 0) {
    console.error(`gen-roles: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("gen-roles: all checks passed");
}

main().catch((e) => {
  console.error("gen-roles: fatal", e);
  process.exit(1);
});
