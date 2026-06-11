// Regression tests for the store chokepoint hardening:
//  - applyCaseUpdate is the single un-validating caller (pending-commit path), so
//    it must ignore an out-of-enum status and an empty title rather than persist
//    them. (An invalid CaseStatus on disk is a board-lint violation.)
//  - addNote / nextNoteId mint ids by max existing -N<k> suffix so a future note
//    delete can't produce a collision (matching nextTaskId).

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCaseUpdate, addNote, nextNoteId } from "../../board/lib/store.ts";
import type { CaseRecord } from "../../board/lib/types.ts";

function freshCase(): CaseRecord {
  return {
    id: "CASE-1",
    title: "Original",
    summary: "",
    status: "todo",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

test("applyCaseUpdate ignores an out-of-enum status", () => {
  const c = freshCase();
  applyCaseUpdate(c, { status: "in-progress" }); // hyphen — not a CaseStatus
  assert.equal(c.status, "todo");
});

test("applyCaseUpdate accepts a valid status", () => {
  const c = freshCase();
  applyCaseUpdate(c, { status: "in_progress" });
  assert.equal(c.status, "in_progress");
});

test("applyCaseUpdate ignores an empty / non-string title", () => {
  const c = freshCase();
  applyCaseUpdate(c, { title: "   " });
  assert.equal(c.title, "Original");
  applyCaseUpdate(c, { title: 42 as never });
  assert.equal(c.title, "Original");
});

test("applyCaseUpdate trims and applies a real title", () => {
  const c = freshCase();
  applyCaseUpdate(c, { title: "  Renamed  " });
  assert.equal(c.title, "Renamed");
});

test("nextNoteId is collision-proof after a note delete", () => {
  const c = freshCase();
  const n1 = addNote(c, "human", "first");
  const n2 = addNote(c, "human", "second");
  assert.equal(n1.id, "CASE-1-N1");
  assert.equal(n2.id, "CASE-1-N2");
  // Simulate a delete of the FIRST note, then add again. length-based minting
  // would re-issue N2 (collision); suffix-based minting issues N3.
  c.notes = c.notes!.filter((n) => n.id !== "CASE-1-N1");
  assert.equal(nextNoteId(c), "CASE-1-N3");
  const n3 = addNote(c, "human", "third");
  assert.equal(n3.id, "CASE-1-N3");
});
