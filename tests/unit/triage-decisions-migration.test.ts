// Unit tests for the v16 → v17 migration that adds the mail-triage editorial-drop decision
// record: db.triageDecisions (TriageDecision[]) — cos-ops#41. v17 is PURELY ADDITIVE — an old
// v15 file reads unchanged, with NO triageDecisions key synthesized (no backfill: unlike v14's
// nutritionGoal→bodyProfile/bodyObjective transform, this migration is a bare carry-forward,
// exactly like db.pantryItems/db.nutritionTargets — there is nothing to backfill, since no drop
// was ever recorded before this version).
//
// Scope: migrate() called DIRECTLY (a pure function — no disk I/O). COS_DATA_DIR still points
// at a throwaway dir before import, matching the sibling migration tests' safety discipline even
// though this file never reads/writes it.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/triage-decisions-migration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { SCHEMA_VERSION } from "../../board/lib/types.ts";

// store.ts resolves its module-level DATA_DIR from COS_DATA_DIR ONCE, at import time. migrate()
// is pure (no disk I/O), but point DATA_DIR at a throwaway dir anyway, matching the sibling
// migration tests — the real board/data is never at risk. The cache-busting `?triagemig` query
// forces a fresh module instance; the ts-resolve hook leaves the specifier alone (its pathname
// still ends in .ts → type-stripping applies).
const DISK_DIR = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "cos-triage-mig-"));
process.env.COS_DATA_DIR = DISK_DIR;
const store = await import("../../board/lib/store.ts?triagemig");

// A v16 store carrying pre-v17 state but WITHOUT db.triageDecisions — the realistic "old file"
// a v17 binary reads.
const V15_FIXTURE = {
  schemaVersion: 16,
  version: 3176,
  cases: [{ id: "CASE-1", title: "Pre-v17 case", status: "todo", domain: "work", tasks: [], messageIds: [] }],
  messages: [
    {
      id: "M-1",
      source: "gmail",
      from: "jane@example.com",
      subject: "Renewal",
      preview: "…",
      body: "…",
      receivedAt: "2026-06-05T00:00:00.000Z",
      read: true,
    },
  ],
  events: [],
  reminders: [],
  priorities: [],
  settings: { autoSync: false },
};

test("migrate(): a v16 object without triageDecisions reads clean as v17 — NO key synthesized (no backfill)", () => {
  const db = store.migrate(V15_FIXTURE);

  assert.equal(db.schemaVersion, SCHEMA_VERSION, "schemaVersion stamped to the current SCHEMA_VERSION");
  assert.equal(db.version, 3176, "the monotonic version is preserved through migration");
  assert.equal(db.triageDecisions, undefined, "no triageDecisions key is synthesized — absent stays absent");
  // The pre-existing v15 state rides through untouched (the additive guarantee).
  assert.equal(db.messages.length, 1, "the v16 message survives the v17 read");
  assert.equal(db.messages[0]?.id, "M-1");
  assert.equal(db.cases[0]?.id, "CASE-1", "the pre-v17 case survives");
});

test("migrate(): an object WITH triageDecisions carries the array forward verbatim", () => {
  const withRows = {
    ...V15_FIXTURE,
    triageDecisions: [
      {
        id: "TD-1",
        sender: "newsletter@example.com",
        source: "gmail",
        reason: "notification",
        count: 12,
        firstSeen: "2026-07-01T09:00:00.000Z",
        lastSeen: "2026-08-05T09:00:00.000Z",
        status: "active",
      },
      {
        id: "TD-2",
        sender: "old-vendor@example.com",
        source: "gmail",
        reason: "want_courtesy",
        count: 3,
        firstSeen: "2026-06-01T09:00:00.000Z",
        lastSeen: "2026-06-20T09:00:00.000Z",
        status: "reversed",
        reviewedAt: "2026-06-21T09:00:00.000Z",
      },
    ],
  };

  const db = store.migrate(withRows);

  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.triageDecisions?.length, 2, "both triage-decision rows survive the migration");
  assert.equal(db.triageDecisions?.[0]?.id, "TD-1");
  assert.equal(db.triageDecisions?.[0]?.count, 12, "count rides through verbatim");
  assert.equal(db.triageDecisions?.[0]?.status, "active");
  assert.equal(db.triageDecisions?.[1]?.id, "TD-2");
  assert.equal(db.triageDecisions?.[1]?.status, "reversed", "a reversed row rides through as reversed");
  assert.equal(
    db.triageDecisions?.[1]?.reviewedAt,
    "2026-06-21T09:00:00.000Z",
    "a pre-set reviewedAt rides through verbatim — migrate() never stamps",
  );
});
