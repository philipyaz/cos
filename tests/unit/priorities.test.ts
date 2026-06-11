// Unit tests for the Priorities additions (v7): the PURE layer behind the two
// complementary mechanisms — STARRED nodes (a user-curated favorite flag on any
// case/workstream/initiative) and free-text PriorityNotes ("what matters most right
// now", lighter than a Reminder). Covers the selectors (sortPriorityNotes,
// starredCases) and the store coercion chokepoints (applyPriorityUpdate,
// applyCaseUpdate's `starred` handling). Pure / in-memory — nothing reads
// board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/priorities.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { sortPriorityNotes, starredCases } from "../../board/lib/selectors.ts";
import { applyPriorityUpdate, applyCaseUpdate } from "../../board/lib/store.ts";
import type { PriorityNote, CaseRecord } from "../../board/lib/types.ts";

// In-memory PriorityNote builder (no store reads). Defaults make a positionless
// note; `over` pins the fields a given test cares about. `createdAt` increments per
// call so the stable createdAt tiebreak in sortPriorityNotes is testable.
let seq = 0;
function note(over: Partial<PriorityNote> = {}): PriorityNote {
  seq += 1;
  return {
    id: `PRI-${seq}`,
    text: `priority ${seq}`,
    createdAt: `2026-05-01T00:00:0${seq % 10}.000Z`,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// In-memory CaseRecord builder (no store reads). Defaults make a non-archived,
// unstarred leaf Case; `over` pins what a test cares about (kind, starred,
// archivedAt, updatedAt).
let cseq = 0;
function rec(over: Partial<CaseRecord> = {}): CaseRecord {
  cseq += 1;
  return {
    id: `CASE-${cseq}`,
    title: `case ${cseq}`,
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: `2026-05-01T00:00:0${cseq % 10}.000Z`,
    ...over,
  };
}

// ── sortPriorityNotes ───────────────────────────────────────────────────────────
test("sortPriorityNotes — position ascending (smaller = higher priority), absent sorts LAST", () => {
  const notes = [
    note({ id: "PRI-NODUE", createdAt: "2026-05-01T00:00:00.000Z" }), // no position → last
    note({ id: "PRI-LATE", position: 5, createdAt: "2026-05-01T00:00:00.000Z" }),
    note({ id: "PRI-EARLY", position: 1, createdAt: "2026-05-01T00:00:00.000Z" }),
    note({ id: "PRI-MID", position: 3, createdAt: "2026-05-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortPriorityNotes(notes).map((p) => p.id), [
    "PRI-EARLY", // position 1
    "PRI-MID", // position 3
    "PRI-LATE", // position 5
    "PRI-NODUE", // absent position → Infinity → last
  ]);
});

test("sortPriorityNotes — equal position falls back to createdAt ascending (stable tiebreak)", () => {
  const notes = [
    note({ id: "PRI-B", position: 2, createdAt: "2026-05-02T00:00:00.000Z" }),
    note({ id: "PRI-A", position: 2, createdAt: "2026-05-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortPriorityNotes(notes).map((p) => p.id), ["PRI-A", "PRI-B"]);
});

test("sortPriorityNotes — both positionless fall back to createdAt ascending (oldest first)", () => {
  const notes = [
    note({ id: "PRI-NEW", createdAt: "2026-05-03T00:00:00.000Z" }),
    note({ id: "PRI-OLD", createdAt: "2026-05-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(sortPriorityNotes(notes).map((p) => p.id), ["PRI-OLD", "PRI-NEW"]);
});

test("sortPriorityNotes — returns a NEW array (does not mutate the input order)", () => {
  const notes = [note({ id: "PRI-2", position: 2 }), note({ id: "PRI-1", position: 1 })];
  const out = sortPriorityNotes(notes);
  assert.notEqual(out, notes); // a fresh array
  assert.deepEqual(notes.map((p) => p.id), ["PRI-2", "PRI-1"]); // input order untouched
});

// ── starredCases ────────────────────────────────────────────────────────────────
test("starredCases — excludes non-starred AND archived nodes", () => {
  const cases = [
    rec({ id: "CASE-STAR", starred: true }),
    rec({ id: "CASE-PLAIN" }), // not starred → excluded
    rec({ id: "CASE-ARCHIVED", starred: true, archivedAt: "2026-05-09T00:00:00.000Z" }), // starred but archived → excluded
  ];
  assert.deepEqual(starredCases(cases).map((c) => c.id), ["CASE-STAR"]);
});

test("starredCases — orders by tier rank (initiative < workstream < case), then updatedAt DESC", () => {
  const cases = [
    rec({ id: "CASE-LEAF", kind: "case", starred: true, updatedAt: "2026-05-05T00:00:00.000Z" }),
    rec({ id: "WS", kind: "workstream", starred: true, updatedAt: "2026-05-05T00:00:00.000Z" }),
    rec({ id: "INIT", kind: "initiative", starred: true, updatedAt: "2026-05-05T00:00:00.000Z" }),
  ];
  assert.deepEqual(starredCases(cases).map((c) => c.id), ["INIT", "WS", "CASE-LEAF"]);
});

test("starredCases — within a tier, most recently touched first (updatedAt DESC)", () => {
  const cases = [
    rec({ id: "CASE-OLD", kind: "case", starred: true, updatedAt: "2026-05-01T00:00:00.000Z" }),
    rec({ id: "CASE-NEW", kind: "case", starred: true, updatedAt: "2026-05-09T00:00:00.000Z" }),
    rec({ id: "CASE-MID", kind: "case", starred: true, updatedAt: "2026-05-05T00:00:00.000Z" }),
  ];
  assert.deepEqual(starredCases(cases).map((c) => c.id), ["CASE-NEW", "CASE-MID", "CASE-OLD"]);
});

// ── applyPriorityUpdate ─────────────────────────────────────────────────────────
test("applyPriorityUpdate — text is trimmed; an empty/blank/missing text is IGNORED (never blanked)", () => {
  const trimmed = applyPriorityUpdate(note({ text: "old" }), { text: "  fresh focus  " });
  assert.equal(trimmed.text, "fresh focus");

  const blank = applyPriorityUpdate(note({ text: "keep me" }), { text: "   " });
  assert.equal(blank.text, "keep me"); // blank ignored

  const absent = applyPriorityUpdate(note({ text: "keep me" }), { position: 1 });
  assert.equal(absent.text, "keep me"); // no `text` key → untouched
});

test("applyPriorityUpdate — position set to a number, cleared (undefined) on a non-number", () => {
  const set = applyPriorityUpdate(note(), { position: 4 });
  assert.equal(set.position, 4);

  // a non-number position clears the manual rank (mirrors applyCaseUpdate's position).
  const cleared = applyPriorityUpdate(note({ position: 4 }), { position: null });
  assert.equal(cleared.position, undefined);

  const clearedStr = applyPriorityUpdate(note({ position: 4 }), { position: "first" });
  assert.equal(clearedStr.position, undefined);

  // an absent `position` key leaves the existing rank untouched.
  const untouched = applyPriorityUpdate(note({ position: 4 }), { text: "x" });
  assert.equal(untouched.position, 4);
});

test("applyPriorityUpdate — always bumps updatedAt", () => {
  const before = note({ updatedAt: "2020-01-01T00:00:00.000Z" });
  const after = applyPriorityUpdate(before, { text: "moved" });
  assert.notEqual(after.updatedAt, "2020-01-01T00:00:00.000Z");
});

// ── applyCaseUpdate — `starred` coercion ─────────────────────────────────────────
test("applyCaseUpdate — a truthy starred stores `true`; a falsy starred clears to undefined (byte-clean)", () => {
  // truthy → true
  const on = applyCaseUpdate(rec(), { starred: true });
  assert.equal(on.starred, true);

  // falsy → undefined (absent === not starred everywhere downstream)
  const off = applyCaseUpdate(rec({ starred: true }), { starred: false });
  assert.equal(off.starred, undefined);

  // a non-`starred` patch leaves the existing flag untouched (no `starred` key).
  const untouched = applyCaseUpdate(rec({ starred: true }), { title: "x" });
  assert.equal(untouched.starred, true);
});
