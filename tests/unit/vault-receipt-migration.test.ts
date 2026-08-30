// Unit tests for the v14 → v15 migration that adds the per-case vault-ingest RECEIPT
// (CaseRecord.vaultIngestedAt). v15 is PURELY ADDITIVE — migrateCase spreads the raw case
// through verbatim, so an old v14 file reads unchanged with vaultIngestedAt staying absent
// (never defaulted to a value) until POST /api/cases/vault-receipt sets it. Also demonstrates
// tests/board-lint.mjs's accept/reject contract for the new field (the ISO-field loop) via a
// spawned subprocess — the criterion's own demonstration, so the on-disk shape has a hard gate.
//
// Scope: the DISK read path (readDB → parseAndMigrate / migrate) plus a write + re-read round
// trip. Drives an ISOLATED throwaway COS_DATA_DIR (os.mkdtemp) exactly like
// nutrition-weight-migration.test.ts — the real board/data file is never read or written.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/vault-receipt-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const BOARD_LINT = nodePath.join(HERE, "..", "board-lint.mjs");

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import time.
// Point it at a throwaway dir BEFORE the dynamic import so DATA_FILE lands inside the
// sandbox (the real board/data is never touched). The cache-busting `?vrmig` query forces a
// fresh module instance whose DATA_DIR re-reads the env; the ts-resolve hook leaves the
// specifier alone (its pathname still ends in .ts → type-stripping applies).
const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-vault-receipt-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?vrmig");
const DATA_FILE = store.DATA_FILE as string;

// Seed cases.json (and clear any .bak) so each case starts clean.
async function seed(raw: string): Promise<void> {
  await fsp.mkdir(DISK_DIR, { recursive: true });
  await fsp.writeFile(DATA_FILE, raw, "utf8");
  await fsp.rm(`${DATA_FILE}.bak`, { force: true });
}

// A v14 store carrying vaultLinks on one case (no receipts) plus a populated spread of
// other collections — the realistic "old file" a v15 binary will read.
const V14_FIXTURE = {
  schemaVersion: 14,
  version: 55,
  cases: [
    {
      id: "CASE-1",
      title: "Acme renewal",
      summary: "Renewal paperwork",
      status: "waiting_for_input",
      domain: "work",
      tasks: [],
      messageIds: ["M-1"],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
      vaultLinks: ["Acme Corp"],
    },
    {
      id: "CASE-2",
      title: "No vault link here",
      summary: "",
      status: "todo",
      domain: "life",
      tasks: [],
      messageIds: [],
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "M-1",
      source: "gmail",
      from: "jane@acme.example",
      subject: "Re: renewal",
      preview: "Sending the signed agreement...",
      body: "Sending the signed agreement over.",
      receivedAt: "2026-06-05T00:00:00.000Z",
      read: true,
      caseId: "CASE-1",
    },
  ],
  events: [],
  reminders: [],
  priorities: [],
  weights: [
    {
      id: "WEIGHT-1",
      date: "2026-06-01",
      weightKg: 80,
      createdAt: "2026-06-01T07:00:00.000Z",
      updatedAt: "2026-06-01T07:00:00.000Z",
    },
  ],
  settings: { autoSync: false, addons: { nutrition: { enabled: true, installedAt: "2026-06-01T00:00:00.000Z" } } },
};

test("migration: a v14 fixture reads clean as v15 — vaultIngestedAt stays absent (not defaulted), everything else intact", async () => {
  await seed(JSON.stringify(V14_FIXTURE, null, 2));

  const db = await store.readDB();

  assert.equal(db.schemaVersion, SCHEMA_VERSION, "schemaVersion stamped to v15 on read");
  assert.equal(db.version, 55, "the monotonic version is preserved through migration");
  assert.equal(db.cases[0]?.vaultIngestedAt, undefined, "the v14 case's vaultIngestedAt stays absent, not defaulted");
  assert.equal(db.cases[1]?.vaultIngestedAt, undefined, "the unlinked case also stays absent");
  assert.deepEqual(db.cases[0]?.vaultLinks, ["Acme Corp"], "vaultLinks itself rides through untouched");

  // The pre-existing v14 state rides through untouched (the additive guarantee).
  assert.equal(db.messages.length, 1, "the linked message survives the v15 read");
  assert.equal(db.messages[0]?.id, "M-1");
  assert.equal(db.weights?.length, 1, "the weights series rides through");
  assert.equal(db.weights?.[0]?.id, "WEIGHT-1");
  assert.equal(db.settings?.addons?.nutrition?.enabled, true, "settings.addons rides through untouched");

  // Next write stamps the CURRENT SCHEMA_VERSION on disk (not just in the in-memory return) —
  // imported, never a literal: a later schema bump (e.g. cos-ops#41's v16) must not break this
  // v14→v15 fixture's own assertion about what "the next write" stamps.
  await store.writeDB(db);
  const rawAfter = JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
  assert.equal(rawAfter.schemaVersion, SCHEMA_VERSION, "the store stamps the current SCHEMA_VERSION on the next write");
});

test("migration: a v15 fixture with a receipt round-trips verbatim through readDB → writeDB → readDB", async () => {
  const V15_FIXTURE = {
    schemaVersion: 15,
    version: 60,
    cases: [
      {
        id: "CASE-1",
        title: "Acme renewal",
        summary: "Renewal paperwork",
        status: "done",
        domain: "work",
        tasks: [],
        messageIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        vaultLinks: ["Acme Corp"],
        vaultIngestedAt: "2026-06-10T00:00:00.000Z",
      },
    ],
    messages: [],
  };
  await seed(JSON.stringify(V15_FIXTURE, null, 2));

  const db = await store.readDB();
  assert.equal(db.cases[0]?.vaultIngestedAt, "2026-06-10T00:00:00.000Z", "the receipt survives the initial read");

  await store.writeDB(db);
  const db2 = await store.readDB();
  assert.equal(
    db2.cases[0]?.vaultIngestedAt,
    "2026-06-10T00:00:00.000Z",
    "the receipt survives a write + re-read round trip",
  );
});

// A minimal, otherwise-fully-valid DBShape + case — only `vaultIngestedAt` varies between
// the accept and reject fixtures below, so a failure can only come from that field.
function minimalDb(vaultIngestedAt: unknown): unknown {
  return {
    schemaVersion: 15,
    version: 1,
    cases: [
      {
        id: "CASE-1",
        title: "Fixture case",
        summary: "",
        status: "todo",
        domain: "work",
        tasks: [],
        messageIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        vaultIngestedAt,
      },
    ],
    messages: [],
  };
}

test("board-lint: accepts a case with a valid ISO vaultIngestedAt", async () => {
  const tmp = nodePath.join(DISK_DIR, "board-lint-accept.json");
  await fsp.writeFile(tmp, JSON.stringify(minimalDb("2026-06-01T00:00:00.000Z"), null, 2), "utf8");

  const result = spawnSync(process.execPath, [BOARD_LINT, tmp], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `board-lint exits 0 on a valid receipt (stdout: ${result.stdout}\nstderr: ${result.stderr})`,
  );
});

test("board-lint: rejects a malformed vaultIngestedAt, naming the field", async () => {
  const tmp = nodePath.join(DISK_DIR, "board-lint-reject.json");
  await fsp.writeFile(tmp, JSON.stringify(minimalDb("not-a-date"), null, 2), "utf8");

  const result = spawnSync(process.execPath, [BOARD_LINT, tmp], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "board-lint exits non-zero on a malformed receipt");
  assert.match(result.stdout + result.stderr, /vaultIngestedAt/, "the failure names the field");
});
