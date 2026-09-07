// cowork-entries.test.ts — pins the four irreversible behaviours of gen-cowork-config.mjs's pure
// decisions (cos-ops#84): atomic refusal, --print redaction, full-sync prune vs named-additive, and
// third-party preservation. Drives scripts/cowork-entries.mjs directly with in-memory fixtures — no
// machine config, no real Cowork config — per ADR 0029 (the module has zero imports of its own beyond
// config/secret-validation.mjs, which is itself import-free, so importing it reads no machine config;
// importing gen-cowork-config.mjs itself would execute it — it builds its entries at module-top-level
// on import).
//
// Tests 12-13 read scripts/gen-cowork-config.mjs as TEXT (never import it, for the reason above) to
// pin the two properties that live only in the wrapper: the refusal precedes the backup/write, and
// the merge replaces only the mcpServers key on the parsed config object (vault-options.test.ts's
// structural-lint idiom). Test 14 pins the module's own purity the same way, so the rule a review-time
// `^import` grep once missed (ops-84's Correction 2 — the old :60 filter read process.argv without
// ever appearing as an import) stays enforced by a gate instead of a grep.
//
// Run via the repo's unit harness: `node --test tests/unit/cowork-entries.test.ts` (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildEntries, redactEntries, mergeServers } from "../../scripts/cowork-entries.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = readFileSync(path.join(HERE, "..", "..", "scripts", "gen-cowork-config.mjs"), "utf8");
const MODULE_SRC = readFileSync(path.join(HERE, "..", "..", "scripts", "cowork-entries.mjs"), "utf8");

const REAL_KEY = "sk-ant-api03-kQ7bZm2Rt4Nx8vLpWc1JyH6sDfGa9UeTiOb3XnZq5MrYkVlA0PjEwSuCdIgFhN2t"; // secret-validation.test.ts:62's synthetic key
const PLACEHOLDER = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // the committed example filler (:38's EXAMPLE_PLACEHOLDER)
const VAULT = { name: "vault", stdio: ["node", "/fake/mcp/vault-server/server.mjs"], env: { COS_VAULT_DIR: "/fake/vault" }, secrets: ["ANTHROPIC_API_KEY"] };
const BOARD = { name: "board", stdio: ["node", "/fake/mcp/board-server/server.mjs"], env: { BOARD_URL: "http://localhost:3000" }, secrets: [] };

// ── buildEntries — happy path + behaviour 1 (atomic refusal) ─────────────────────────────
test("buildEntries: happy path — entries built, secret inlined, board untouched, no refusals or warnings", () => {
  const { entries, refusals, warnings } = buildEntries([VAULT, BOARD], { ANTHROPIC_API_KEY: REAL_KEY });
  assert.deepEqual(refusals, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(entries.vault, {
    command: "node",
    args: ["/fake/mcp/vault-server/server.mjs"],
    env: { COS_VAULT_DIR: "/fake/vault", ANTHROPIC_API_KEY: REAL_KEY },
  });
  assert.deepEqual(
    entries.board,
    { command: "node", args: ["/fake/mcp/board-server/server.mjs"], env: { BOARD_URL: "http://localhost:3000" } },
    "board carries no secrets, so its env is untouched",
  );
});

test("B1: a placeholder secret is refused and never inlined into the entry", () => {
  const { entries, refusals } = buildEntries([VAULT], { ANTHROPIC_API_KEY: PLACEHOLDER });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /ANTHROPIC_API_KEY/);
  assert.match(refusals[0], /TEMPLATE value/);
  assert.match(refusals[0], /vault/);
  assert.equal("ANTHROPIC_API_KEY" in entries.vault.env, false);
  assert.deepEqual(
    entries.vault.env,
    { COS_VAULT_DIR: "/fake/vault" },
    "the vault entry is still built with its non-secret env — only the write path stops the file write",
  );
});

test("B1: an absent secret gets the distinct 'missing' diagnosis, not the placeholder one", () => {
  const { refusals } = buildEntries([VAULT], {});
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /missing/);
  assert.doesNotMatch(refusals[0], /TEMPLATE/);
});

test("B1 contract: a pre-filtered named merge that excludes the secret-carrying server cannot refuse", () => {
  const { refusals } = buildEntries([BOARD], { ANTHROPIC_API_KEY: PLACEHOLDER });
  assert.deepEqual(
    refusals,
    [],
    "board carries no secrets, so a dead ANTHROPIC_API_KEY elsewhere never surfaces here — the caller's pre-filter is what makes this safe",
  );
});

test("Soft check stays soft: an off-shape key still warns, but is still inlined", () => {
  const offShape = "nope-not-a-key-but-long-enough-to-pass-length";
  const { entries, warnings, refusals } = buildEntries([VAULT], { ANTHROPIC_API_KEY: offShape });
  assert.deepEqual(refusals, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith("ANTHROPIC_API_KEY for 'vault' "), `expected the exact prefix, got: ${warnings[0]}`);
  assert.match(warnings[0], /does not start with/);
  assert.equal(entries.vault.env.ANTHROPIC_API_KEY, offShape, "ADR 0014: warn on what you don't control, never hard-gate it");
});

// ── redactEntries — behaviour 2 (--print redaction) ───────────────────────────────────────
test("B2: redaction is byte-exact, scoped to secret keys, and does not mutate the input", () => {
  const { entries } = buildEntries([VAULT, BOARD], { ANTHROPIC_API_KEY: REAL_KEY });
  const redacted = redactEntries(entries, [VAULT, BOARD]);
  assert.equal(redacted.vault.env.ANTHROPIC_API_KEY, "«from config/secrets.env»");
  assert.equal(redacted.vault.env.COS_VAULT_DIR, "/fake/vault");
  assert.equal(redacted.board.env.BOARD_URL, "http://localhost:3000");
  assert.equal(
    entries.vault.env.ANTHROPIC_API_KEY,
    REAL_KEY,
    "redactEntries must deep-copy — the input object still carries the live key afterwards",
  );
});

test("B2: a manifest entry with no built entry is skipped, not thrown", () => {
  const { entries } = buildEntries([BOARD], { ANTHROPIC_API_KEY: REAL_KEY });
  const redacted = redactEntries(entries, [VAULT, BOARD]);
  assert.deepEqual(Object.keys(redacted), ["board"]);
});

// ── mergeServers — behaviours 3 (prune vs additive) and 4 (third-party preservation) ──────
const OLD = { command: "node", args: ["/old/path/server.mjs"], env: {} };
const NEW = { command: "node", args: ["/fake/mcp/vault-server/server.mjs"], env: { COS_VAULT_DIR: "/fake/vault" } };
const THIRD_PARTY = { command: "python3", args: ["/Users/someone/memex/server.py"], env: {} };

test("B3: full sync prunes exactly the previously-managed names the manifest dropped", () => {
  const current = { vault: OLD, whatsapp: OLD, memex: THIRD_PARTY };
  const merged = mergeServers(current, { vault: NEW }, { prior: ["vault", "whatsapp"], fullSync: true });
  assert.deepEqual(merged.vault, NEW);
  assert.equal("whatsapp" in merged, false, "whatsapp was previously managed and the manifest no longer defines it — pruned");
  assert.deepEqual(merged.memex, THIRD_PARTY, "a third-party entry, never cos-managed, survives a full sync");
});

test("B3: a named merge (fullSync: false) never prunes, even given a prior list", () => {
  const current = { vault: OLD, whatsapp: OLD, memex: THIRD_PARTY };
  const merged = mergeServers(current, { vault: NEW }, { prior: ["vault", "whatsapp"], fullSync: false });
  assert.deepEqual(merged.vault, NEW);
  assert.deepEqual(merged.whatsapp, OLD, "a named merge is additive only — whatsapp survives despite being in prior");
  assert.deepEqual(merged.memex, THIRD_PARTY);
});

test("B3: first run — an empty prior list prunes nothing (the hub's actual live state today)", () => {
  const current = { vault: OLD, whatsapp: OLD, memex: THIRD_PARTY };
  const merged = mergeServers(current, { vault: NEW }, { prior: [], fullSync: true });
  assert.deepEqual(Object.keys(merged).sort(), ["memex", "vault", "whatsapp"]);
});

test("B4: mergeServers never mutates its currentServers argument", () => {
  const current = { vault: OLD, whatsapp: OLD, memex: THIRD_PARTY };
  mergeServers(current, { vault: NEW }, { prior: ["vault", "whatsapp"], fullSync: true });
  assert.deepEqual(
    current,
    { vault: OLD, whatsapp: OLD, memex: THIRD_PARTY },
    "the input object must be untouched — mergeServers returns a new object (a spread copy)",
  );
});

// ── structural lint over source text — the properties an import cannot see ────────────────
test("Structural — B1's atomicity half: the refusal in the wrapper precedes the backup and the write", () => {
  const refusalAt = WRAPPER.indexOf("REFUSING TO WRITE");
  assert.ok(refusalAt > -1, "expected the REFUSING TO WRITE branch in gen-cowork-config.mjs");
  assert.ok(refusalAt < WRAPPER.indexOf("copyFileSync("), "the refusal must run before the backup");
  assert.ok(refusalAt < WRAPPER.indexOf("writeFileSync("), "the refusal must run before the write");
});

test("Structural — B4's sibling-key half: the wrapper assigns only current.mcpServers, and never rebinds current except from its own parsed JSON", () => {
  const dotted = [...WRAPPER.matchAll(/\bcurrent\.(\w+)\s*=(?!=)/g)].map((m) => m[1]);
  assert.deepEqual(dotted, ["mcpServers"], "current.<key> = is only ever done for mcpServers");
  const rebinds = [...WRAPPER.matchAll(/\bcurrent\s*=(?!=)/g)];
  assert.equal(rebinds.length, 2, "current is only ever rebound twice: its declaration default and the parsed file");
  assert.ok(WRAPPER.includes("let current = {}"), "expected the empty-object default");
  assert.ok(WRAPPER.includes("current = JSON.parse("), "expected current to be rebound only from the file's own parsed JSON");
});

test("Structural — module purity is a durable gate: no argv/env reads, no machine-config imports", () => {
  assert.ok(!/process\.(argv|env)/.test(MODULE_SRC), "cowork-entries.mjs must not read process.argv or process.env");
  assert.ok(!MODULE_SRC.includes("load-config"), "cowork-entries.mjs must not import config/load-config.mjs");
  assert.ok(!MODULE_SRC.includes("service-manifest"), "cowork-entries.mjs must not import mcp/service-manifest.mjs");
});
