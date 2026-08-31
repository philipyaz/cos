// device-mirrors.test.ts — pins the SIX device/backup mirror sites that were
// previously held in step by a comment alone (cos-ops#45; #1 of 7,
// isPlaceholderSecret, is already pinned by secret-validation.test.ts — the
// template this file follows).
//
// WHY THIS TEST EXISTS
// ────────────────────
// board/ is a separate npm package (`allowJs: false`, `moduleResolution: bundler`)
// and cannot import a .mjs from above its own root (ADR 0014), so seven small
// pieces of logic the board and the CLI/backup tooling both need are
// RE-IMPLEMENTED on the board side rather than shared. Every site says so in a
// comment. One of the seven (isPlaceholderSecret) is held in step by a test; the
// other six were held only by the comment saying "keep these in lockstep" — and
// the pinned one is the one instance of this pattern that has already drifted
// once in this repo's history (see secret-validation.test.ts's HISTORY note).
// This file is what makes the remaining six duplications safe, the same way:
//
//   #2  board/lib/cos-env.ts machineValue      ↔ backup/config.mjs envOrCosEnv
//   #3  board/lib/cos-env.ts slugifyDeviceId   ↔ backup/config.mjs + mcp-kit (inline)
//   #4  board/lib/backup-status.ts readHubLease ↔ backup/lib/lease.mjs
//   #5  board/lib/backup-status.ts readManifest ↔ backup/lib/manifests.mjs
//   #6  board/lib/backup-status.ts KEYCHAIN_*   ↔ backup/config.mjs (module-private on
//       the board side — see the deviation note above mirror #6 below)
//   #7  board/lib/devices.ts buildJoinBlob      ↔ scripts/join-blob.mjs
//
// ADR 0014 already settled whether any of these could instead be deleted
// (loosening board/tsconfig.json for cross-boundary imports): rejected, for all
// of them — "mirrored and pinned by a test running both copies over one fixture
// table" is the prescribed shape, not a one-off. This file is that test for the
// six that didn't have it yet.
//
// One DELIBERATE deviation: mirror #6's board side (the Keychain service/account
// identity) is module-private, and its only consumer spawns the real `security`
// binary — importing both is impossible without a production edit (out of scope
// here). That mirror is pinned by anchored source-literal extraction instead,
// and the section below documents a REAL, LIVE divergence between the two sides
// on a whitespace-only account override (carried as a named follow-on, not
// fixed here — fixing it is a production change this test's own scope forbids).
//
// Nothing here touches the real Keychain, the real backup repo, or the
// machine's config/cos.env — every fixture is a throwaway tmpdir, and every
// process.env mutation is scoped and restored. Passes on a machine with no Cos
// configured at all.
//
// Run via the repo's unit harness: `node --test tests/unit/device-mirrors.test.ts`
// (and tests/run.sh [1]).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Statically importable: none of these read env or touch disk at import time.
import { LEASE_STALE_HOURS as MJS_LEASE_STALE_HOURS, coerceLease, readLease, leaseIsStale } from "../../backup/lib/lease.mjs";
import { readAllManifests } from "../../backup/lib/manifests.mjs";
import { parseCosEnv, slugifyDeviceId } from "../../board/lib/cos-env";
import { SCHEMA_VERSION } from "../../board/lib/types";
import { makeBoardApi } from "../../packages/mcp-kit/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COS_ROOT = path.resolve(HERE, "..", "..");
const TS_RESOLVE = path.join(HERE, "ts-resolve.mjs");
const DRIVER = path.join(HERE, "device-mirrors.driver.ts");
const CONFIG_MJS = path.join(COS_ROOT, "backup", "config.mjs");
const JOIN_BLOB = path.join(COS_ROOT, "scripts", "join-blob.mjs");
const NODE_TS_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "--import", TS_RESOLVE];

// Every key a fixture must own — deleted from the child env before a case's own
// values are added, spawn AND in-process, so this hub's real values (this
// machine IS a configured hub) can never leak into an assertion.
const POISON_KEYS = [
  "COS_DEVICE_ID",
  "COS_DEVICE_ROLE",
  "COS_BACKUP_KEYCHAIN_SERVICE",
  "COS_BACKUP_KEYCHAIN_ACCOUNT",
  "COS_HUB_PUBLIC_URL",
  "BACKUP_REPO_REF",
  "COS_BACKUP_REPO",
  "COS_BACKUP_REPO_ROOT",
];
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of POISON_KEYS) delete env[k];
  return { ...env, ...overrides };
}

// Spawn the board-side driver (mirrors #2/#3) with a fixture cwd.
function runDriver(cwd, overrides = {}) {
  const out = execFileSync(process.execPath, [...NODE_TS_FLAGS, DRIVER], {
    cwd,
    env: cleanEnv(overrides),
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// Spawn a fresh node importing backup/config.mjs (mirrors #2/#3/#6) — config.mjs
// is spawn-only in this test (never imported in-process: it bakes its whole env
// at import time, which would poison this test process's own module graph).
function runConfigMjs(overrides = {}) {
  const code = `import(${JSON.stringify(CONFIG_MJS)}).then(m=>console.log(JSON.stringify({id:m.DEVICE_ID,role:m.DEVICE_ROLE,ks:m.KEYCHAIN_SERVICE,ka:m.KEYCHAIN_ACCOUNT})))`;
  const out = execFileSync(process.execPath, ["-e", code], { env: cleanEnv(overrides), encoding: "utf8" });
  return JSON.parse(out);
}

// ── Fixture skeletons for mirrors #2 + #3 ──────────────────────────────────────
// <A>: a cos.env with adversarial-but-realistic values — quoted, an inner
// apostrophe, padding, both quote styles — pins the two private parsers' quote
// semantics, not just the value chain. <B>: no cos.env at all (the defaults path).
const FIXTURE_A = fs.mkdtempSync(path.join(os.tmpdir(), "cos-device-mirrors-a-"));
fs.mkdirSync(path.join(FIXTURE_A, "config"), { recursive: true });
fs.mkdirSync(path.join(FIXTURE_A, "board"), { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_A, "config", "cos.env"),
  `COS_DEVICE_ID="Philip's Mini #2"\nCOS_DEVICE_ROLE='  spoke  '\n`,
);

const FIXTURE_B = fs.mkdtempSync(path.join(os.tmpdir(), "cos-device-mirrors-b-"));
fs.mkdirSync(path.join(FIXTURE_B, "board"), { recursive: true });

// ── Fixture backup repo for mirrors #4 + #5 ─────────────────────────────────────
// Set COS_BACKUP_REPO BEFORE the dynamic imports below: board/lib/backup-status.ts
// binds its BACKUP_REPO constant from that env var ONCE, at module load. Importing
// first would silently bind it to ~/.cos-backups (the REAL archive on this hub) —
// exactly what "no assertion depends on the machine's config/cos.env" forbids.
// Restored immediately after import; nothing later depends on it staying set.
const FIXTURE_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "cos-device-mirrors-repo-"));
fs.mkdirSync(path.join(FIXTURE_REPO, "manifests"), { recursive: true });

// The tripwire for the import-order trap above: a HUB.json only the FIXTURE repo
// would return. Read as the FIRST assertion in the mirror #4 test below — if the
// import order ever regresses, that assertion sees the real lease (or null)
// instead, loudly, rather than this silently passing against fixture-shaped luck.
const TRIPWIRE_LEASE = { deviceId: "tripwire-device", host: "tripwire-host", epoch: 9, renewedAt: new Date().toISOString() };
fs.writeFileSync(path.join(FIXTURE_REPO, "HUB.json"), JSON.stringify(TRIPWIRE_LEASE));

const _prevBackupRepoEnv = process.env.COS_BACKUP_REPO;
process.env.COS_BACKUP_REPO = FIXTURE_REPO;
const { readHubLease, LEASE_STALE_HOURS: BOARD_LEASE_STALE_HOURS, readManifest } = await import("../../board/lib/backup-status");
const { buildJoinBlob } = await import("../../board/lib/devices");
if (_prevBackupRepoEnv === undefined) delete process.env.COS_BACKUP_REPO;
else process.env.COS_BACKUP_REPO = _prevBackupRepoEnv;

after(() => {
  fs.rmSync(FIXTURE_A, { recursive: true, force: true });
  fs.rmSync(FIXTURE_B, { recursive: true, force: true });
  fs.rmSync(FIXTURE_REPO, { recursive: true, force: true });
});

// ── Mirror #2 — device id/role chain: env > cos.env > default ──────────────────
test("mirror #2 — device id/role chain: env > cos.env > default (board cos-env.ts vs backup/config.mjs)", () => {
  // (i) the cos.env-alone layer.
  const boardA = runDriver(path.join(FIXTURE_A, "board"));
  const mjsA = runConfigMjs({ COS_BACKUP_REPO_ROOT: FIXTURE_A });
  assert.deepEqual(boardA, { id: "Philip-s-Mini--2", role: "spoke" }, "board cos.env-alone chain");
  assert.deepEqual(
    boardA,
    { id: mjsA.id, role: mjsA.role },
    "IMPLEMENTATIONS DRIFTED (cos.env layer) — edit BOTH board/lib/cos-env.ts and backup/config.mjs",
  );

  // (ii) env beats file — same fixture, an env override on top.
  const envOverride = { COS_DEVICE_ID: "Env Wins!", COS_DEVICE_ROLE: "hub" };
  const boardEnv = runDriver(path.join(FIXTURE_A, "board"), envOverride);
  const mjsEnv = runConfigMjs({ COS_BACKUP_REPO_ROOT: FIXTURE_A, ...envOverride });
  assert.deepEqual(boardEnv, { id: "Env-Wins-", role: "hub" }, "board env-beats-file chain");
  assert.deepEqual(
    boardEnv,
    { id: mjsEnv.id, role: mjsEnv.role },
    "IMPLEMENTATIONS DRIFTED (env beats cos.env) — edit BOTH board/lib/cos-env.ts and backup/config.mjs",
  );

  // (iii) no cos.env anywhere — both fall back to THIS machine's hostname.
  // Compared to each other, never hardcoded, so this runs on any machine.
  const boardB = runDriver(path.join(FIXTURE_B, "board"));
  const mjsB = runConfigMjs({ COS_BACKUP_REPO_ROOT: FIXTURE_B });
  assert.equal(boardB.role, "hub", "board default role is hub");
  assert.deepEqual(
    boardB,
    { id: mjsB.id, role: mjsB.role },
    "IMPLEMENTATIONS DRIFTED (hostname default) — edit BOTH board/lib/cos-env.ts and backup/config.mjs",
  );

  // parseCosEnv itself — quote/padding semantics, pinned directly (no subprocess:
  // parseCosEnv takes an explicit repoRoot and never touches the machineEnv() cache).
  assert.deepEqual(
    parseCosEnv(FIXTURE_A),
    { COS_DEVICE_ID: "Philip's Mini #2", COS_DEVICE_ROLE: "  spoke  " },
    "board parseCosEnv strips one layer of quotes, keeping inner punctuation and padding",
  );
});

// ── Mirror #3 — the device-id slug shape (three copies) ────────────────────────
test("mirror #3 — device-id slug: board slugifyDeviceId vs mcp-kit x-device header vs backup/config.mjs", async () => {
  const SLUG_FIXTURES = [
    // raw #1 is the same value as mirror #2's fixture-A cos.env row, so the
    // .mjs side is already pinned for it there (mjsA.id above) — not repeated.
    ["Philip's Mini #2", "Philip-s-Mini--2"],
    ["über mini", "-ber-mini"],
    ["a.b_c-d", "a.b_c-d"], // already all allowed chars — unchanged
    ["x".repeat(80), "x".repeat(64)], // pins the slice(0,64) cap
  ];

  let capturedHeader;
  const server = http.createServer((req, res) => {
    capturedHeader = req.headers["x-device"];
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = makeBoardApi("board", `http://127.0.0.1:${server.address().port}`);

  const prevId = process.env.COS_DEVICE_ID;
  try {
    for (const [raw, expected] of SLUG_FIXTURES) {
      const boardSlug = slugifyDeviceId(raw);
      assert.equal(boardSlug, expected, `board slugifyDeviceId disagreed for ${JSON.stringify(raw)}`);

      process.env.COS_DEVICE_ID = raw;
      capturedHeader = undefined;
      const { errorResult } = await api("GET", "/probe");
      assert.equal(errorResult, undefined, "the loopback probe never errors");
      assert.equal(
        capturedHeader,
        boardSlug,
        `IMPLEMENTATIONS DRIFTED for ${JSON.stringify(raw)} — edit BOTH board/lib/cos-env.ts and packages/mcp-kit/index.mjs`,
      );
    }

    // Absent COS_DEVICE_ID → mcp-kit omits x-device entirely. Not drift: the
    // board's hostname fallback + re-slugify happens server-side only.
    delete process.env.COS_DEVICE_ID;
    capturedHeader = undefined;
    await api("GET", "/probe");
    assert.equal(capturedHeader, undefined, "mcp-kit omits x-device when COS_DEVICE_ID is unset (not drift — see above)");
  } finally {
    if (prevId === undefined) delete process.env.COS_DEVICE_ID;
    else process.env.COS_DEVICE_ID = prevId;
    await new Promise((resolve) => server.close(resolve));
  }

  // config.mjs: one extra spawn pins the slice(0,64) cap cross-side (do not spawn
  // per row — the in-process pair above already covers the full table).
  const mjsCapped = runConfigMjs({ COS_BACKUP_REPO_ROOT: FIXTURE_B, COS_DEVICE_ID: "x".repeat(80) });
  assert.equal(
    mjsCapped.id,
    "x".repeat(64),
    "IMPLEMENTATIONS DRIFTED (slice(0,64) cap) — edit BOTH board/lib/cos-env.ts and backup/config.mjs",
  );
});

// ── Mirror #4 — the HUB.json lease: LEASE_STALE_HOURS + field coercion + staleness ─
test("mirror #4 — HUB.json lease: LEASE_STALE_HOURS + field coercion + staleness (board backup-status.ts vs backup/lib/lease.mjs)", () => {
  // TRIPWIRE — see the fixture setup above. Must be the first assertion here.
  assert.deepEqual(
    readHubLease(),
    { ...TRIPWIRE_LEASE, stale: false },
    "readHubLease() did not see the fixture repo — the dynamic import likely ran before COS_BACKUP_REPO was set",
  );

  assert.equal(
    BOARD_LEASE_STALE_HOURS,
    MJS_LEASE_STALE_HOURS,
    "IMPLEMENTATIONS DRIFTED (LEASE_STALE_HOURS) — edit BOTH board/lib/backup-status.ts and backup/lib/lease.mjs",
  );

  const hubJsonPath = path.join(FIXTURE_REPO, "HUB.json");
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const rows = [
    { deviceId: "dev-x", host: "host-x", epoch: 1, renewedAt: hoursAgo(25) }, // fresh (< 26h)
    { deviceId: "dev-x", host: "host-x", epoch: 1, renewedAt: hoursAgo(27) }, // stale (> 26h)
    { deviceId: "dev-x", host: "host-x", epoch: 1 }, // renewedAt missing — both → null
    { deviceId: "dev-y", epoch: "3", renewedAt: hoursAgo(1) }, // string epoch + missing host — both coerce
    { deviceId: "dev-z", host: "host-z", epoch: 1, renewedAt: "not-a-date" }, // unparsable — both → stale
  ];
  for (const [i, raw] of rows.entries()) {
    fs.writeFileSync(hubJsonPath, JSON.stringify(raw));
    const boardLease = readHubLease();
    const mjsLease = coerceLease(JSON.parse(fs.readFileSync(hubJsonPath, "utf8")));
    if (mjsLease === null) {
      assert.equal(boardLease, null, `row ${i}: both sides read a missing/garbage lease as null`);
      continue;
    }
    assert.deepEqual(
      { deviceId: boardLease.deviceId, host: boardLease.host, epoch: boardLease.epoch, renewedAt: boardLease.renewedAt },
      mjsLease,
      `IMPLEMENTATIONS DRIFTED (field coercion, row ${i}) — edit BOTH board/lib/backup-status.ts and backup/lib/lease.mjs`,
    );
    assert.equal(
      boardLease.stale,
      leaseIsStale(readLease(FIXTURE_REPO)),
      `IMPLEMENTATIONS DRIFTED (staleness, row ${i}) — edit BOTH board/lib/backup-status.ts and backup/lib/lease.mjs`,
    );
  }
});

// ── Mirror #5 — the manifest union: count, order, shared identifying fields ────
test("mirror #5 — manifest union: readAllManifests (backup/lib/manifests.mjs) vs readManifest() (board backup-status.ts)", () => {
  const dir = path.join(FIXTURE_REPO, "manifests");
  fs.writeFileSync(
    path.join(dir, "dev-a.json"),
    JSON.stringify({
      backups: [
        { file: "a2.enc", createdAt: "2026-08-20T00:00:00.000Z", deviceId: "dev-a", host: "host-a" },
        { file: "a1.enc", createdAt: "2026-08-10T00:00:00.000Z", deviceId: "dev-a", host: "host-a" },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "dev-b.json"),
    JSON.stringify({
      backups: [
        { file: "b1.enc", createdAt: "2026-08-15T00:00:00.000Z", deviceId: "dev-b", host: "host-b" },
        { file: "b0.enc", deviceId: "dev-b", host: "host-b" }, // no createdAt — pins the shared `?? ""` ordering key
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  fs.writeFileSync(path.join(dir, "README.txt"), "not a manifest — must be ignored\n");
  fs.writeFileSync(
    path.join(FIXTURE_REPO, "MANIFEST.json"),
    JSON.stringify({
      backups: [{ file: "legacy1.enc", createdAt: "2026-08-05T00:00:00.000Z", host: "host-legacy" }], // no deviceId — pre-split
    }),
  );

  const mjsRows = readAllManifests(FIXTURE_REPO);
  const boardRows = readManifest();

  assert.equal(boardRows.length, 5, "the garbage row and the README never contribute an entry");
  assert.equal(boardRows.length, mjsRows.length, `both sides agree on count (board ${boardRows.length}, .mjs ${mjsRows.length})`);

  // Identifying fields only — NOT deep equality: the board side hard-defaults
  // every field by design (its SSR-safety layer, coerceSummary), which is an
  // intentional asymmetry documented at readManifest(), not drift to "fix" here.
  const identifying = (r) => ({ file: r.file, createdAt: r.createdAt ?? "", deviceId: r.deviceId ?? null, host: r.host });
  assert.deepEqual(
    boardRows.map(identifying),
    mjsRows.map(identifying),
    "IMPLEMENTATIONS DRIFTED (count/order/identifying fields) — edit BOTH board/lib/backup-status.ts and backup/lib/manifests.mjs",
  );
  assert.deepEqual(
    boardRows.map((r) => r.file),
    ["a2.enc", "b1.enc", "a1.enc", "legacy1.enc", "b0.enc"],
    "newest-first order, with the no-createdAt row sorting last",
  );
});

// ── Mirror #6 — Keychain identity: the one designed deviation ──────────────────
// The board side (backup-status.ts KEYCHAIN_SERVICE/KEYCHAIN_ACCOUNT) is
// module-private, and its only consumer spawns the real `security` binary —
// import-both is impossible without a production edit (out of scope here; see
// "Considered and rejected" in the plan this test implements). Pinned instead by
// anchored source-literal extraction: loud (assert.fail) if the block ever
// moves, never a silent pass. Touches neither the real Keychain nor
// backup/lib/key.mjs's resolveKey — identity resolution only.
test("mirror #6 — Keychain identity: backup/config.mjs (behavioural) vs board backup-status.ts (anchored source)", () => {
  const mjsDefault = runConfigMjs({ COS_BACKUP_REPO_ROOT: FIXTURE_B });
  assert.equal(mjsDefault.ks, "cos-backup-key", "backup/config.mjs default Keychain service");
  assert.equal(mjsDefault.ka, os.userInfo().username, "backup/config.mjs default Keychain account (current user)");
  const mjsOverride = runConfigMjs({
    COS_BACKUP_REPO_ROOT: FIXTURE_B,
    COS_BACKUP_KEYCHAIN_SERVICE: "svc-x",
    COS_BACKUP_KEYCHAIN_ACCOUNT: "acct-y",
  });
  assert.equal(mjsOverride.ks, "svc-x", "backup/config.mjs honours COS_BACKUP_KEYCHAIN_SERVICE");
  assert.equal(mjsOverride.ka, "acct-y", "backup/config.mjs honours COS_BACKUP_KEYCHAIN_ACCOUNT");

  const src = fs.readFileSync(path.join(COS_ROOT, "board", "lib", "backup-status.ts"), "utf8");

  const serviceMatch = src.match(/KEYCHAIN_SERVICE\s*=\s*process\.env\.COS_BACKUP_KEYCHAIN_SERVICE\s*\|\|\s*"([^"]+)"/);
  if (!serviceMatch) assert.fail("the board-side keychain identity block moved — update device-mirrors.test.ts");
  assert.equal(
    serviceMatch[1],
    mjsDefault.ks,
    "IMPLEMENTATIONS DRIFTED (Keychain service literal) — edit BOTH board/lib/backup-status.ts and backup/config.mjs",
  );

  // Pin the board's CURRENT (stricter) account-resolution shape — it does NOT
  // agree with backup/config.mjs's raw `||` on a whitespace-only override; that
  // live divergence is named in the test-file header above and carried as a
  // named follow-on in the PR, not silently equalized or silently skipped.
  const accountBlockIdx = src.indexOf("KEYCHAIN_ACCOUNT = ((): string =>");
  assert.notEqual(accountBlockIdx, -1, "the board-side keychain account block moved — update device-mirrors.test.ts");
  const accountBlock = src.slice(accountBlockIdx, accountBlockIdx + 400);
  assert.match(accountBlock, /COS_BACKUP_KEYCHAIN_ACCOUNT/, "account block still reads COS_BACKUP_KEYCHAIN_ACCOUNT");
  assert.match(accountBlock, /\.trim\(\)/, "account block still trims");
  assert.match(accountBlock, /os\.userInfo\(\)\.username/, "account block still falls back to the current user");

  const fnIdx = src.indexOf("function recoveryKeyPresent");
  assert.notEqual(fnIdx, -1, "recoveryKeyPresent moved — update device-mirrors.test.ts");
  assert.match(
    src.slice(fnIdx, fnIdx + 400),
    /if\s*\(KEYCHAIN_ACCOUNT\)\s*args\.push\("-a", KEYCHAIN_ACCOUNT\)/,
    "recoveryKeyPresent still omits -a entirely when the account resolves empty",
  );
});

// ── Mirror #7 — the cos-join:// grammar ─────────────────────────────────────────
test("mirror #7 — cos-join:// grammar: board buildJoinBlob() vs scripts/join-blob.mjs CLI (exact string equality)", () => {
  const prevHub = process.env.COS_HUB_PUBLIC_URL;
  const prevRef = process.env.BACKUP_REPO_REF;
  try {
    // Trailing slash on purpose — both sides must strip it identically. Both
    // inputs explicit + non-empty: the CLI's cos.env is anchored to the REAL
    // repo, so an unset input would silently pull this hub's live values and
    // make the comparison machine-dependent (see the no-backup case below).
    process.env.COS_HUB_PUBLIC_URL = "https://mini.example.ts.net/";
    process.env.BACKUP_REPO_REF = "philipyaz/cos-backups-fixture";

    const boardBlob = buildJoinBlob();
    const cliOut = execFileSync(process.execPath, [JOIN_BLOB], {
      env: cleanEnv({
        COS_HUB_PUBLIC_URL: process.env.COS_HUB_PUBLIC_URL,
        BACKUP_REPO_REF: process.env.BACKUP_REPO_REF,
      }),
      encoding: "utf8",
    }).trim();

    assert.equal(
      cliOut,
      boardBlob,
      "IMPLEMENTATIONS DRIFTED (cos-join:// grammar) — edit BOTH board/lib/devices.ts and scripts/join-blob.mjs",
    );
    const parsed = new URLSearchParams(boardBlob.split("?")[1]);
    assert.equal(parsed.get("hub"), "https://mini.example.ts.net", "trailing slash stripped");
    assert.equal(parsed.get("schema"), String(SCHEMA_VERSION), "schema carries board/lib/types.ts's SCHEMA_VERSION");
    assert.equal(parsed.get("backup"), "philipyaz/cos-backups-fixture");

    // The no-backup-ref case: board-side only. The CLI cannot join this case
    // hermetically — its cos.env is unpointable (scripts/join-blob.mjs:6-8), so
    // an unset BACKUP_REPO_REF there falls through to THIS hub's real cos.env,
    // not a documented "unset" the way COS_HUB_PUBLIC_URL now is (cos-ops#33).
    delete process.env.BACKUP_REPO_REF;
    const noBackupBlob = buildJoinBlob();
    assert.ok(!/backup=/.test(noBackupBlob), "no BACKUP_REPO_REF ⇒ no backup= key in the blob");
    assert.ok(noBackupBlob.startsWith("cos-join://v1?hub="), "the blob still carries hub + schema");
  } finally {
    if (prevHub === undefined) delete process.env.COS_HUB_PUBLIC_URL;
    else process.env.COS_HUB_PUBLIC_URL = prevHub;
    if (prevRef === undefined) delete process.env.BACKUP_REPO_REF;
    else process.env.BACKUP_REPO_REF = prevRef;
  }
});
