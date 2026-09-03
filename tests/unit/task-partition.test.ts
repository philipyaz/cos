// Regression tests for the case-drawer Tasks partition (ops#52): a completed task
// collapses behind a disclosure instead of sitting in the default checklist, and
// open tasks sort by due date instead of raw array order. Pins the pure helper's
// rules so a future edit can't silently drop, duplicate, or misorder a task — see
// board/lib/task-partition.ts for the "why no clock" rationale.
//
// Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/task-partition.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionTasks } from "../../board/lib/task-partition.ts";
import type { Task, TaskStatus } from "../../board/lib/types.ts";

let seq = 0;
function mk(id: string, status: TaskStatus, opts: { dueAt?: string; completedAt?: string } = {}): Task {
  seq += 1;
  return {
    id,
    title: id,
    status,
    createdAt: `2026-01-01T00:00:00.${String(seq).padStart(3, "0")}Z`,
    ...opts,
  };
}

const tOver = mk("t-over", "open", { dueAt: "2026-01-05T00:00:00.000Z" });
const tSoon = mk("t-soon", "in_progress", { dueAt: "2026-03-01T00:00:00.000Z" });
const tLater = mk("t-later", "blocked", { dueAt: "2026-06-01T00:00:00.000Z" });
const tUnd1 = mk("t-und1", "open");
const tUnd2 = mk("t-und2", "open");
const dOld = mk("d-old", "done", { completedAt: "2026-02-01T00:00:00.000Z" });
const dNew = mk("d-new", "done", { completedAt: "2026-04-01T00:00:00.000Z" });
const dNone = mk("d-none", "done");

// Deliberately scrambled input order — the helper must not depend on it, and the
// undated ties (t-und1/t-und2) must resolve by THIS input order, not array position.
const input: Task[] = [dNew, tUnd1, tLater, dNone, tSoon, dOld, tOver, tUnd2];
const idsBefore = input.map((t) => t.id);

test("open tasks sort overdue-first, then dueAt ascending, undated last in input order", () => {
  const { open } = partitionTasks(input);
  assert.deepEqual(open.map((t) => t.id), ["t-over", "t-soon", "t-later", "t-und1", "t-und2"]);
});

test("completed tasks sort by completedAt ascending, undated completion tolerated and last", () => {
  const { completed } = partitionTasks(input);
  assert.deepEqual(completed.map((t) => t.id), ["d-old", "d-new", "d-none"]);
});

test("in_progress and blocked land in open — partition is status === 'done', not status === 'open'", () => {
  const { open } = partitionTasks(input);
  const ids = open.map((t) => t.id);
  assert.ok(ids.includes("t-soon"), "in_progress task missing from open");
  assert.ok(ids.includes("t-later"), "blocked task missing from open");
});

test("the input array is not mutated", () => {
  partitionTasks(input);
  assert.deepEqual(input.map((t) => t.id), idsBefore);
});

test("nothing is dropped or duplicated", () => {
  const { open, completed } = partitionTasks(input);
  assert.equal(open.length + completed.length, input.length);
});
