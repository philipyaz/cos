// launchd-load.test.ts — pins the honest-install reporting contract of gen-launchd.mjs's load
// step (ops#54 Fix 1): a success line prints only for a launchctl verb whose exit status was
// actually checked. Drives scripts/launchd-load.mjs through an injected fake runner — never real
// `launchctl` — per ADR 0029 (the module has zero imports of its own, so importing it reads no
// machine config; importing gen-launchd.mjs itself would, via its module-top-level loadConfig()).
//
// Run via the repo's unit harness: `node --test tests/unit/launchd-load.test.ts` (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadServices, installedButUnselected } from "../../scripts/launchd-load.mjs";

const UID = 501;

// Records every `launchctl <cmd>` the code under test issues; throws the execSync error shape
// (`.stderr` string, `.status` number) for any command matching `failPattern`.
function makeRunner(failPattern, { stderr = "boom\n", status = 1 } = {}) {
  const commands = [];
  const run = (cmd) => {
    commands.push(cmd);
    if (failPattern && failPattern.test(cmd)) {
      throw Object.assign(new Error(`launchctl ${cmd} failed`), { stderr, status });
    }
  };
  return { commands, run };
}

function makeCapture() {
  const outLines = [];
  const errLines = [];
  return { outLines, errLines, out: (s) => outLines.push(s), errOut: (s) => errLines.push(s) };
}

const itemA = { label: "com.test.a", schedule: null, plistPath: "/fake/com.test.a.plist" };
const itemB = { label: "com.test.b", schedule: null, plistPath: "/fake/com.test.b.plist" };
const itemC = { label: "com.test.c", schedule: null, plistPath: "/fake/com.test.c.plist" };
const itemScheduled = {
  label: "com.test.scheduled",
  schedule: { hour: 3, minute: 30 },
  plistPath: "/fake/com.test.scheduled.plist",
};

test("loadServices: happy path — every item loads, in order, scheduled items are never kickstarted", () => {
  const { commands, run } = makeRunner(null);
  const { outLines, errLines, out, errOut } = makeCapture();

  const failed = loadServices([itemA, itemB, itemC, itemScheduled], { uid: UID, run, out, errOut });

  assert.deepEqual(failed, []);
  assert.deepEqual(errLines, []);
  assert.equal(outLines.length, 4, "one loaded line per item");
  assert.equal(outLines[0], "[gen-launchd] loaded com.test.a (launchctl)\n");
  assert.equal(outLines[1], "[gen-launchd] loaded com.test.b (launchctl)\n");
  assert.equal(outLines[2], "[gen-launchd] loaded com.test.c (launchctl)\n");
  assert.equal(
    outLines[3],
    "[gen-launchd] loaded com.test.scheduled (launchctl, scheduled — not fired now)\n",
    "the scheduled suffix is byte-identical to gen-launchd.mjs's own copy (em dash, not a hyphen)",
  );
  assert.deepEqual(
    commands,
    [
      "bootout gui/501/com.test.a",
      'bootstrap gui/501 "/fake/com.test.a.plist"',
      "kickstart -k gui/501/com.test.a",
      "bootout gui/501/com.test.b",
      'bootstrap gui/501 "/fake/com.test.b.plist"',
      "kickstart -k gui/501/com.test.b",
      "bootout gui/501/com.test.c",
      'bootstrap gui/501 "/fake/com.test.c.plist"',
      "kickstart -k gui/501/com.test.c",
      "bootout gui/501/com.test.scheduled",
      'bootstrap gui/501 "/fake/com.test.scheduled.plist"',
    ],
    "each non-scheduled item runs bootout→bootstrap→kickstart; the scheduled item gets no kickstart at all",
  );
});

test("loadServices: a failing bootout alone does not block the install — first-install path unchanged", () => {
  const { commands, run } = makeRunner(/^bootout/);
  const { outLines, errLines, out, errOut } = makeCapture();

  const failed = loadServices([itemA, itemB], { uid: UID, run, out, errOut });

  assert.deepEqual(failed, []);
  assert.deepEqual(errLines, []);
  assert.equal(outLines.length, 2, "both still report loaded");
  assert.ok(commands.includes("bootout gui/501/com.test.a"), "bootout was still attempted, not skipped");
});

test("loadServices: a mid-list bootstrap failure still attempts the rest, and reports only that one", () => {
  const failPattern = /^bootstrap .*com\.test\.b\.plist/;
  const { commands, run } = makeRunner(failPattern, { stderr: "Bootstrap failed: 5: Input/output error\n" });
  const { outLines, errLines, out, errOut } = makeCapture();

  const failed = loadServices([itemA, itemB, itemC], { uid: UID, run, out, errOut });

  assert.deepEqual(failed, ["com.test.b"]);
  assert.equal(outLines.length, 2, "a and c still load");
  assert.equal(outLines[0], "[gen-launchd] loaded com.test.a (launchctl)\n");
  assert.equal(outLines[1], "[gen-launchd] loaded com.test.c (launchctl)\n");
  assert.equal(errLines.length, 1);
  assert.equal(
    errLines[0],
    "[gen-launchd] FAILED to load com.test.b: bootstrap: Bootstrap failed: 5: Input/output error\n",
  );
  assert.ok(
    commands.includes('bootstrap gui/501 "/fake/com.test.c.plist"'),
    "c's bootstrap still ran — the list was not aborted on b's failure",
  );
  assert.ok(
    !commands.includes("kickstart -k gui/501/com.test.b"),
    "no kickstart after a failed bootstrap — it would be guaranteed noise",
  );
});

test("loadServices: a kickstart failure is reported as a restart failure, not a load failure", () => {
  const failPattern = /^kickstart -k gui\/501\/com\.test\.a$/;
  const { run } = makeRunner(failPattern, { stderr: "Could not find service\n" });
  const { outLines, errLines, out, errOut } = makeCapture();

  const failed = loadServices([itemA], { uid: UID, run, out, errOut });

  assert.deepEqual(failed, ["com.test.a"]);
  assert.equal(outLines.length, 0, "no loaded line for a service whose forced restart was unconfirmed");
  assert.equal(errLines.length, 1);
  assert.equal(
    errLines[0],
    "[gen-launchd] FAILED to restart com.test.a (bootstrapped, but kickstart -k failed): Could not find service\n",
    "the job WAS bootstrapped (and is running under RunAtLoad+KeepAlive) — 'FAILED to load' would overclaim",
  );
});

test("loadServices: an empty-stderr failure falls back to the exit status", () => {
  const failPattern = /^bootstrap/;
  const { run } = makeRunner(failPattern, { stderr: "", status: 7 });
  const { errLines, out, errOut } = makeCapture();

  loadServices([itemA], { uid: UID, run, out, errOut });

  assert.equal(errLines[0], "[gen-launchd] FAILED to load com.test.a: bootstrap: launchctl exited 7\n");
});

test("installedButUnselected: only an unpicked, actually-installed, Cos-manifest plist is named", () => {
  const manifest = [
    { name: "svc-a", label: "com.test.a" },
    { name: "svc-b", label: "com.test.b" },
    { name: "svc-c", label: "com.test.c" },
  ];
  const picked = [manifest[0]]; // only a was selected
  const dirFiles = ["com.test.b.plist", "com.test.a.plist", "com.apple.something.plist"];

  assert.deepEqual(
    installedButUnselected(manifest, picked, dirFiles),
    ["svc-b"],
    "a picked entry is excluded even though its plist is on disk; c is excluded (never installed); the non-Cos plist is never named",
  );
});
