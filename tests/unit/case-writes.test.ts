// Unit tests for board/lib/case-writes.ts — the shared vocabulary + validated
// write cores the direct case routes AND the approval queue both commit
// through (cos-ops#119: the approval path must commit exactly what the direct
// verb would, by calling the same code). Pure/in-memory — nothing reads
// board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/case-writes.test.ts
//
// Every faithfulness assertion (groups D/E) drives through commitVerb — the
// approval path is the subject under test. The routes' own use of the same
// cores is pinned by TEXT (group F), since a route file isn't importable
// under the unit runner (the house idiom — see e.g. primary-action.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMIT_HANDLERS, commitVerb, resolvePendingTarget, assertCommittable } from "../../board/lib/case-writes.ts";
import { BadRequestError } from "../../board/lib/store.ts";
import type { CaseRecord, DBShape } from "../../board/lib/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function mk(over: Partial<CaseRecord> & { id: string }): CaseRecord {
  return {
    title: over.id,
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// I (initiative) > W1 (workstream) > C1 (leaf), C2 (leaf, status "done").
function tree(): CaseRecord[] {
  return [
    mk({ id: "I", kind: "initiative" }),
    mk({ id: "W1", kind: "workstream", parentId: "I" }),
    mk({ id: "C1", parentId: "W1" }),
    mk({ id: "C2", parentId: "W1", status: "done" }),
  ];
}

function mkDb(cases: CaseRecord[]): DBShape {
  return {
    schemaVersion: 3,
    version: 1,
    cases,
    messages: [],
    labels: [{ id: "known-label", title: "Known", description: "A known catalog label." }],
  };
}

// ── Group A — resolvePendingTarget ──────────────────────────────────────────
test("group A — payload.id is lifted into target when target is absent", () => {
  assert.equal(resolvePendingTarget(undefined, { id: "C1" }), "C1");
});

test("group A — target and an equal payload.id both present returns it", () => {
  assert.equal(resolvePendingTarget("C1", { id: "C1" }), "C1");
});

test("group A — target and a disagreeing payload.id throws BadRequestError", () => {
  assert.throws(() => resolvePendingTarget("C1", { id: "C2" }), BadRequestError);
});

test("group A — a non-string or empty-string payload.id is ignored", () => {
  assert.equal(resolvePendingTarget(undefined, { id: 123 }), undefined);
  assert.equal(resolvePendingTarget(undefined, { id: "" }), undefined);
  assert.equal(resolvePendingTarget(undefined, {}), undefined);
});

// ── Group B — assertCommittable dry-run isolation ───────────────────────────
test("group B — assertCommittable on a valid update_case leaves the db byte-unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assertCommittable(db, "update_case", "C1", { title: "Renamed" });
  assert.equal(JSON.stringify(db), before);
});

test("group B — assertCommittable on a valid create_case leaves the db byte-unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assertCommittable(db, "create_case", undefined, { title: "New Initiative", kind: "initiative" });
  assert.equal(JSON.stringify(db), before);
});

// ── Group C — door refusals ──────────────────────────────────────────────────
test("group C — a targeted verb with no target is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "update_case", undefined, { title: "x" }), /requires a 'target'/);
});

test("group C — move with a target but no valid status is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "move", "C1", {}), /move requires a valid status/);
});

test("group C — an unsupported verb's message enumerates the ten fixed verb literals", () => {
  const db = mkDb(tree());
  // Pinned as LITERALS, not Object.keys(COMMIT_HANDLERS) — a self-derived
  // expectation goes vacuously green when the map shrinks (ADR 0038).
  const TEN = [
    "update_case", "update", "move", "archive", "restore",
    "add_task", "complete_task", "add_note", "create", "create_case",
  ];
  assert.throws(
    () => commitVerb(db, "nope", "C1", {}),
    (err: unknown) => err instanceof Error && TEN.every((v) => err.message.includes(v)),
  );
});

test("group C — prototype-key verb names are refused, never dispatched", () => {
  const db = mkDb(tree());
  // A Record literal inherits Object.prototype: "toString" in map is true and
  // map["toString"] is a real function — Object.hasOwn is what stops the
  // dispatcher from calling it and returning garbage instead of refusing.
  assert.throws(() => commitVerb(db, "toString", "C1", {}), /Unsupported verb/);
  assert.throws(() => commitVerb(db, "hasOwnProperty", "C1", {}), /Unsupported verb/);
});

// ── Group D — faithful create (via commitVerb("create_case", …)) ────────────
test("group D — kind is honoured on the created record", () => {
  const db = mkDb(tree());
  const rec = commitVerb(db, "create_case", undefined, { title: "New Initiative", kind: "initiative" });
  assert.equal(rec.kind, "initiative");
});

test("group D — a workstream with no parent is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "create_case", undefined, { title: "x", kind: "workstream" }));
});

test("group D — a parentId naming a leaf is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "create_case", undefined, { title: "x", parentId: "C1" }));
});

test("group D — a parentId naming a missing case is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "create_case", undefined, { title: "x", parentId: "NOPE" }));
});

test("group D — an invalid status is refused, not coerced to todo", () => {
  const db = mkDb(tree());
  assert.throws(
    () => commitVerb(db, "create_case", undefined, { title: "x", status: "in-progress" }),
    /'status' must be one of:/,
  );
});

test("group D — a missing title is refused", () => {
  const db = mkDb(tree());
  assert.throws(() => commitVerb(db, "create_case", undefined, {}), /Field 'title' is required\./);
});

test("group D — a valid catalog label lands on the record", () => {
  const db = mkDb(tree());
  const rec = commitVerb(db, "create_case", undefined, { title: "x", labels: ["known-label"] });
  assert.deepEqual(rec.labels, ["known-label"]);
});

// ── Group E — faithful update (via commitVerb("update_case", …)) ────────────
test("group E — a parentId naming a leaf is refused, db unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assert.throws(() => commitVerb(db, "update_case", "C2", { parentId: "C1" }));
  assert.equal(JSON.stringify(db), before);
});

test("group E — an unknown label id is refused with the catalog message, db unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assert.throws(
    () => commitVerb(db, "update_case", "C1", { labels: ["unknown-id"] }),
    /Unknown label id\(s\)/,
  );
  assert.equal(JSON.stringify(db), before);
});

test("group E — an invalid domain is refused (the old path silently ignored it), db unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assert.throws(
    () => commitVerb(db, "update_case", "C1", { domain: "bogus" }),
    /'domain' must be one of:/,
  );
  assert.equal(JSON.stringify(db), before);
});

test("group E — demoting a container that still has children is refused, db unchanged", () => {
  const db = mkDb(tree());
  const before = JSON.stringify(db);
  assert.throws(() => commitVerb(db, "update_case", "W1", { kind: "case" }));
  assert.equal(JSON.stringify(db), before);
});

test("group E — accept direction: a status patch on a done case logs 'moved' with the transition detail", () => {
  const db = mkDb(tree());
  const rec = commitVerb(db, "update_case", "C2", { status: "waiting_for_input" });
  assert.equal(rec.status, "waiting_for_input");
  const last = rec.activity?.[rec.activity.length - 1];
  assert.equal(last?.verb, "moved");
  assert.equal(last?.detail, "done→waiting_for_input");
});

// ── Group F — delegation text pins ───────────────────────────────────────────
// Route files aren't importable under the unit runner (Next's app-router
// modules aren't plain ESM), so delegation is pinned by reading the source —
// the house idiom (primary-action.test.ts, device-mirrors.test.ts, …).
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("group F — pending/route.ts delegates to the shared core, no COMMITTABLE_VERBS", () => {
  const src = read("board/app/api/pending/route.ts");
  assert.ok(src.includes("assertCommittable"), "must call assertCommittable");
  assert.ok(src.includes("resolvePendingTarget"), "must call resolvePendingTarget");
  assert.match(src, /from ["']@\/lib\/case-writes["']/);
  assert.equal(src.includes("COMMITTABLE_VERBS"), false, "must not reference COMMITTABLE_VERBS");
});

test("group F — pending/[id]/route.ts delegates commitVerb, no local switch dispatcher", () => {
  const src = read("board/app/api/pending/[id]/route.ts");
  assert.match(src, /from ["']@\/lib\/case-writes["']/, "must import commitVerb from @/lib/case-writes");
  assert.equal(/case "create_case"/.test(src), false, "must not keep a local create_case arm");
  assert.equal(/switch \(verb/.test(src), false, "must not keep a local verb switch");
});

test("group F — cases/route.ts delegates to the shared core and no longer asserts hierarchy directly", () => {
  const src = read("board/app/api/cases/route.ts");
  assert.match(src, /from ["']@\/lib\/case-writes["']/, "must import from @/lib/case-writes");
  assert.equal(src.includes("assertHierarchy"), false, "must not mention assertHierarchy — moved into the core");
});

test("group F — cases/[id]/route.ts delegates to the shared core and no longer asserts hierarchy directly", () => {
  const src = read("board/app/api/cases/[id]/route.ts");
  assert.match(src, /from ["']@\/lib\/case-writes["']/, "must import from @/lib/case-writes");
  assert.equal(src.includes("assertHierarchy"), false, "must not mention assertHierarchy — moved into the core");
});
