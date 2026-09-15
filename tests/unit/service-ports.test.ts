// service-ports.test.ts — cos-ops#99: the board resolves every service port it calls
// through ONE resolver family (servicePort/serviceUrl, board/lib/cos-env.ts), instead
// of five sites each hardcoding (or dead-reckoning) their own copy of config/cos.env's
// port keys. Two halves:
//
//   (1) BEHAVIOURAL — runs the board-side resolvers against fixture repo roots this
//       file writes itself (never the live config/cos.env), via a spawned driver
//       (service-ports.driver.ts): machineValue's cos.env parse is cached per-PROCESS,
//       so observing "configured" and "absent" cos.envs in the same run needs fresh
//       child processes — the same pattern device-mirrors.test.ts uses for its own
//       mirrors #2/#3.
//   (2) SOURCE-SCAN — the gate. Subject: the six call sites the issue's own table
//       names. Corpus: every .ts/.tsx under board/app, board/lib, board/components
//       (walkTsx) — >=200 tracked files. NO exclusion list: the resolver composes
//       `${host}:${port}` from parts and holds no quoted host:port literal, so this
//       gate cannot go vacuously green on its own definition file (board/lib/cos-env.ts)
//       — if a future site DOES need an exclusion, use tsx-controls' walkTsxExcept
//       (once cos-ops#103 lands), never a hand-rolled filter.
//
// Import discipline: only walkTsx + stripComments are imported from ./tsx-controls.mjs
// — both byte-identical on either side of open PR cos#169 (verified 2026-09-15), which
// rewrites the two gate bodies (alert-consolidation.test.ts, drawer-shell.test.ts) this
// issue's own ACs cite as a shape to follow. Nothing is copied from either body — a
// port scan has no className to resolve, so none of the machinery that fold moves is
// wanted here.
//
// Per-service host rule (config/load-config.sh): http://127.0.0.1 for the two
// sidecars (guard, search — asserted behaviourally below, on serviceUrl's return);
// http://localhost for the three add-on bridges (asserted in the source-scan half, at
// the one probeBridge template literal all three share — servicePort returns a bare
// number by design, so the bridge host is only observable at that site). The VAULT
// bridge is the documented EXCEPTION: vault-status.ts's BRIDGE_URL keeps
// http://127.0.0.1 — changing it would be a live behaviour change outside every AC here.
//
// Known floor (ADR 0038's "still-capable-of-failing", stated rather than closed): the
// negative scan below bans the quoted host:digit SPELLING, not the property "resolves
// from cos.env". A `const PORT = 8009;` + a `` `http://127.0.0.1:${PORT}` `` template —
// the very shape vault-status.ts correctly uses for its own default — would evade it.
// A numeric-literal ban would false-positive on every defaultPort argument the
// resolver call sites carry by design, so this gap is accepted, not closable; the five
// positive pins below are what hold the known sites in place.
//
// Run: `node --test tests/unit/service-ports.test.ts` (also rides tests/run.sh's
// `tests/unit/*.test.ts` glob — no run.sh edit needed).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { walkTsx, stripComments } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const TS_RESOLVE = path.join(__dirname, "ts-resolve.mjs");
const DRIVER = path.join(__dirname, "service-ports.driver.ts");
const NODE_TS_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "--import", TS_RESOLVE];

// Every key a fixture must own — deleted from the child env before a case's own
// overrides are added, so this hub's real values (a sourced load-config.sh exports
// all five) can never leak into an assertion.
const POISON_KEYS = ["COS_GUARD_URL", "COS_SEARCH_URL", "GUARD_SIDECAR_PORT", "SEARCH_SIDECAR_PORT", "FITNESS_BRIDGE_PORT"];
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of POISON_KEYS) delete env[k];
  return { ...env, ...overrides };
}

// Spawn the board-side driver with a fixture cwd.
function runDriver(cwd, overrides = {}) {
  const out = execFileSync(process.execPath, [...NODE_TS_FLAGS, DRIVER], {
    cwd,
    env: cleanEnv(overrides),
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// ── Fixture repo roots ──────────────────────────────────────────────────────────
// <CONFIGURED>: cos.env sets all three ports to non-default values.
// <ABSENT>: no cos.env at all (the defaults path).
// <GARBAGE>: cos.env sets FITNESS_BRIDGE_PORT to a non-numeric value.
const FIXTURE_CONFIGURED = fs.mkdtempSync(path.join(os.tmpdir(), "cos-service-ports-configured-"));
fs.mkdirSync(path.join(FIXTURE_CONFIGURED, "config"), { recursive: true });
fs.mkdirSync(path.join(FIXTURE_CONFIGURED, "board"), { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_CONFIGURED, "config", "cos.env"),
  `GUARD_SIDECAR_PORT="18009"\nSEARCH_SIDECAR_PORT="18008"\nFITNESS_BRIDGE_PORT="18011"\n`,
);

const FIXTURE_ABSENT = fs.mkdtempSync(path.join(os.tmpdir(), "cos-service-ports-absent-"));
fs.mkdirSync(path.join(FIXTURE_ABSENT, "board"), { recursive: true });

const FIXTURE_GARBAGE = fs.mkdtempSync(path.join(os.tmpdir(), "cos-service-ports-garbage-"));
fs.mkdirSync(path.join(FIXTURE_GARBAGE, "config"), { recursive: true });
fs.mkdirSync(path.join(FIXTURE_GARBAGE, "board"), { recursive: true });
fs.writeFileSync(path.join(FIXTURE_GARBAGE, "config", "cos.env"), `FITNESS_BRIDGE_PORT="banana"\n`);

after(() => {
  fs.rmSync(FIXTURE_CONFIGURED, { recursive: true, force: true });
  fs.rmSync(FIXTURE_ABSENT, { recursive: true, force: true });
  fs.rmSync(FIXTURE_GARBAGE, { recursive: true, force: true });
});

// ── Behavioural half ─────────────────────────────────────────────────────────────
test("configured cos.env, no override: each resolver returns the CONFIGURED port, sidecar host is http://127.0.0.1", () => {
  const out = runDriver(path.join(FIXTURE_CONFIGURED, "board"));
  assert.deepEqual(
    out,
    { guard: "http://127.0.0.1:18009", search: "http://127.0.0.1:18008", fitness: 18011 },
    "configured cos.env values should win with no override (also pins the sidecar host prefix)",
  );
});

test("no cos.env at all: each resolver returns its documented DEFAULT (8009 / 8008 / 8011)", () => {
  const out = runDriver(path.join(FIXTURE_ABSENT, "board"));
  assert.deepEqual(
    out,
    { guard: "http://127.0.0.1:8009", search: "http://127.0.0.1:8008", fitness: 8011 },
    "no cos.env should fall back to the documented defaults",
  );
});

test("a full-URL process.env override beats BOTH configured cos.env and the default (tests/run.sh:410's contract), trailing slash stripped", () => {
  const out = runDriver(path.join(FIXTURE_CONFIGURED, "board"), {
    COS_GUARD_URL: "http://guard.test:19/",
    COS_SEARCH_URL: "http://search.test:29",
  });
  assert.deepEqual(
    out,
    { guard: "http://guard.test:19", search: "http://search.test:29", fitness: 18011 },
    "an override should win outright (ADR 0029) with its trailing slash stripped, matching backup/config.mjs + mcp-kit's baseUrl; the un-overridden fitness port should still come from cos.env",
  );
});

test("a garbage configured port degrades to the documented default — a NUMBER, never NaN", () => {
  const out = runDriver(path.join(FIXTURE_GARBAGE, "board"));
  assert.equal(
    out.fitness,
    8011,
    "a non-numeric FITNESS_BRIDGE_PORT should degrade to the default, not ship as NaN (which JSON turns into null)",
  );
});

// ── Source-scan half (the gate) ───────────────────────────────────────────────────
const ROOTS = [path.join(REPO_ROOT, "board/app"), path.join(REPO_ROOT, "board/lib"), path.join(REPO_ROOT, "board/components")];

// The six call sites cos-ops#99's own table names — a moved/renamed subject must fail
// this floor loudly, never silently shrink the corpus the two scans below walk.
const SUBJECT_FILES = [
  "board/lib/cos-env.ts",
  "board/lib/guard.ts",
  "board/app/api/search/route.ts",
  "board/app/api/addons/route.ts",
  "board/app/addons/page.tsx",
  "board/app/api/vault/status/route.ts",
];

test("gate floor: walks >=200 .ts/.tsx files and includes every subject file", () => {
  const files = walkTsx(ROOTS);
  assert.ok(
    files.length >= 200,
    `expected to walk >=200 .tsx/.ts files under board/{app,lib,components}, got ${files.length}`,
  );
  for (const rel of SUBJECT_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    assert.ok(files.includes(abs), `subject file moved or missing from the walk: ${rel} — update service-ports.test.ts`);
  }
});

test("gate negative scan: no quoted host:digit URL literal anywhere in the corpus", () => {
  const files = walkTsx(ROOTS);
  const HOST_PORT_RE = /https?:\/\/(127\.0\.0\.1|localhost):\d/g;
  const violations = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of src.matchAll(HOST_PORT_RE)) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(`${path.relative(REPO_ROOT, file)}:${line}`);
    }
  }
  if (violations.length) {
    assert.fail(`${violations.length} hardcoded host:port URL literal(s):\n${violations.join("\n")}`);
  }
});

test("gate positive pins: the six call sites resolve through the shared resolver family", () => {
  const read = (rel) => stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));

  const guardSrc = read("board/lib/guard.ts");
  assert.match(
    guardSrc,
    /serviceUrl\(\s*"COS_GUARD_URL"\s*,\s*"GUARD_SIDECAR_PORT"\s*,\s*8009\s*,\s*"http:\/\/127\.0\.0\.1"\s*\)/,
    "guard.ts's serviceUrl(...) call moved — update service-ports.test.ts",
  );

  const searchSrc = read("board/app/api/search/route.ts");
  assert.match(
    searchSrc,
    /serviceUrl\(\s*"COS_SEARCH_URL"\s*,\s*"SEARCH_SIDECAR_PORT"\s*,\s*8008\s*,\s*"http:\/\/127\.0\.0\.1"\s*\)/,
    "search/route.ts's serviceUrl(...) call moved — update service-ports.test.ts",
  );

  const addonsRouteSrc = read("board/app/api/addons/route.ts");
  assert.match(
    addonsRouteSrc,
    /servicePort\(a\.mcp\.bridgePortVar,\s*a\.mcp\.defaultPort\)/,
    "addons/route.ts's servicePort(a.mcp.bridgePortVar, a.mcp.defaultPort) call moved — update service-ports.test.ts",
  );
  assert.match(
    addonsRouteSrc,
    /`http:\/\/localhost:\$\{port\}\/mcp`/,
    "addons/route.ts's shared bridge-host probe site (all three bridges) moved — update service-ports.test.ts",
  );

  const addonsPageSrc = read("board/app/addons/page.tsx");
  assert.match(
    addonsPageSrc,
    /servicePort\(a\.mcp\.bridgePortVar,\s*a\.mcp\.defaultPort\)/,
    "addons/page.tsx's servicePort(a.mcp.bridgePortVar, a.mcp.defaultPort) call moved — update service-ports.test.ts",
  );

  const vaultRouteSrc = read("board/app/api/vault/status/route.ts");
  assert.match(vaultRouteSrc, /port:\s*BRIDGE_PORT/, "vault/status/route.ts's port: BRIDGE_PORT moved — update service-ports.test.ts");
  assert.match(vaultRouteSrc, /url:\s*BRIDGE_URL/, "vault/status/route.ts's url: BRIDGE_URL moved — update service-ports.test.ts");
  assert.ok(!/port:\s*8005/.test(vaultRouteSrc), "vault/status/route.ts reintroduced a bare port: 8005 literal");
  assert.ok(!/127\.0\.0\.1:8005/.test(vaultRouteSrc), "vault/status/route.ts reintroduced a bare 127.0.0.1:8005 literal");
});
