// Unit tests for describeCaseChange — the helper that turns a case before/after
// an applyCaseUpdate into the activity `detail`, so the audit trail says WHAT a
// (manual) edit changed. Pure, in-memory — nothing reads board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/case-change.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCaseChange } from "../../board/lib/store.ts";
import type { CaseRecord } from "../../board/lib/types.ts";

function mk(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: "CASE-1",
    title: "T",
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
// Parse the trailing "field, field" segment of a detail into a sorted set.
function fields(detail: string | undefined): string[] {
  if (!detail) return [];
  const tail = detail.split("; ").filter((p) => !p.includes("→") && p !== "restored" && p !== "archived");
  return tail.join(", ").split(",").map((s) => s.trim()).filter(Boolean).sort();
}

test("describeCaseChange — no change is undefined", () => {
  assert.equal(describeCaseChange(mk(), mk()), undefined);
});

test("describeCaseChange — status transition", () => {
  assert.equal(describeCaseChange(mk({ status: "todo" }), mk({ status: "done" })), "todo→done");
});

test("describeCaseChange — restore (archivedAt cleared)", () => {
  const before = mk({ archivedAt: "2026-05-02T00:00:00.000Z" });
  const after = mk({ archivedAt: undefined });
  assert.equal(describeCaseChange(before, after), "restored");
});

test("describeCaseChange — scalar fields by name", () => {
  const d = describeCaseChange(mk(), mk({ priority: "P1", eta: "soon" }));
  assert.deepEqual(fields(d), ["eta", "priority"]);
});

test("describeCaseChange — array fields by name", () => {
  const d = describeCaseChange(mk({ labels: ["a"] }), mk({ labels: ["a", "b"] }));
  assert.deepEqual(fields(d), ["labels"]);
});

test("describeCaseChange — status + other field combined", () => {
  const d = describeCaseChange(mk({ status: "todo" }), mk({ status: "in_progress", priority: "P0" }));
  assert.ok(d!.startsWith("todo→in_progress"), `expected transition first, got "${d}"`);
  assert.deepEqual(fields(d), ["priority"]);
});
