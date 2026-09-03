// Unit tests for the open-task list engine — board/lib/selectors.ts's selectTasks
// (cos-ops#51: the task is the only first-class entity with full CRUD and no list
// verb). Every time-relative assertion is fed a fixed `now` so the suite is
// deterministic regardless of wall clock or TZ. Fixtures are tiny in-memory object
// literals — nothing reads board/data (mirrors selectors.test.ts's mkCase idiom).
// Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/tasks-selector.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTasks } from "../../board/lib/selectors.ts";
import type { CaseRecord, Task } from "../../board/lib/types.ts";

// Mirrors selectors.test.ts's NOW: mid-day UTC keeps date-only (UTC-midnight) dues
// unambiguous relative to it, and matches the due-status west-of-UTC fixture dates.
const NOW = new Date("2026-05-31T12:00:00.000Z");

let taskSeq = 0;
function mkTask(over: Partial<Task> = {}): Task {
  taskSeq += 1;
  return {
    id: over.id ?? `T${taskSeq}`,
    title: over.title ?? "Untitled task",
    status: over.status ?? "open",
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// Minimal valid CaseRecord; override only what a test cares about.
function mkCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: over.id ?? "CASE-1",
    title: over.title ?? "Untitled case",
    summary: over.summary ?? "",
    status: over.status ?? "todo",
    domain: over.domain ?? "work",
    tasks: over.tasks ?? [],
    messageIds: over.messageIds ?? [],
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// ── Bucketing table (each task carries its OWN dueAt) ───────────────────────
test("bucketing", async (t) => {
  const withDue = (dueAt?: string): CaseRecord[] => [mkCase({ tasks: [mkTask({ dueAt })] })];

  await t.test("yesterday → overdue", () => {
    assert.equal(selectTasks(withDue("2026-05-30T00:00:00.000Z"), NOW).tasks[0].bucket, "overdue");
  });
  await t.test("date-only today (the due-status west-of-UTC case) → today", () => {
    assert.equal(selectTasks(withDue("2026-05-31T00:00:00.000Z"), NOW).tasks[0].bucket, "today");
  });
  await t.test("+2d (inside dueStatus's soon range) → week", () => {
    assert.equal(selectTasks(withDue("2026-06-02T00:00:00.000Z"), NOW).tasks[0].bucket, "week");
  });
  await t.test("+5d (beyond soon, inside 7) → week", () => {
    assert.equal(selectTasks(withDue("2026-06-05T00:00:00.000Z"), NOW).tasks[0].bucket, "week");
  });
  await t.test("+7d exactly (the inclusive far edge) → week", () => {
    assert.equal(selectTasks(withDue("2026-06-07T00:00:00.000Z"), NOW).tasks[0].bucket, "week");
  });
  await t.test("+8d → later", () => {
    assert.equal(selectTasks(withDue("2026-06-08T00:00:00.000Z"), NOW).tasks[0].bucket, "later");
  });
  await t.test("absent → undated", () => {
    assert.equal(selectTasks(withDue(undefined), NOW).tasks[0].bucket, "undated");
  });
  await t.test("unparseable → undated", () => {
    assert.equal(selectTasks(withDue("not a date"), NOW).tasks[0].bucket, "undated");
  });
});

// ── Inheritance ──────────────────────────────────────────────────────────────
test("inheritance", async (t) => {
  await t.test("task with no dueAt in a case with one → the case's bucket, marked inherited", () => {
    const c = mkCase({ dueAt: "2026-06-02T00:00:00.000Z", tasks: [mkTask({ dueAt: undefined })] });
    const row = selectTasks([c], NOW).tasks[0];
    assert.equal(row.due, "2026-06-02T00:00:00.000Z");
    assert.equal(row.dueInherited, true);
    assert.equal(row.bucket, "week");
  });

  await t.test("task's own dueAt wins over a different case dueAt — no inherited mark", () => {
    const c = mkCase({
      dueAt: "2026-06-02T00:00:00.000Z",
      tasks: [mkTask({ dueAt: "2026-05-30T00:00:00.000Z" })],
    });
    const row = selectTasks([c], NOW).tasks[0];
    assert.equal(row.due, "2026-05-30T00:00:00.000Z");
    assert.equal(row.dueInherited, undefined);
    assert.equal(row.bucket, "overdue");
  });
});

// ── Scope ──────────────────────────────────────────────────────────────────
test("scope", async (t) => {
  await t.test("open task in a done case: absent by default, present under scope:all with caseStatus done", () => {
    const c = mkCase({ status: "done", tasks: [mkTask()] });
    assert.equal(selectTasks([c], NOW).tasks.length, 0);
    const all = selectTasks([c], NOW, { scope: "all" }).tasks;
    assert.equal(all.length, 1);
    assert.equal(all[0].caseStatus, "done");
  });

  await t.test("open task in an archived case: absent under BOTH scopes", () => {
    const c = mkCase({ archivedAt: "2026-05-15T00:00:00.000Z", tasks: [mkTask()] });
    assert.equal(selectTasks([c], NOW).tasks.length, 0);
    assert.equal(selectTasks([c], NOW, { scope: "all" }).tasks.length, 0);
  });

  await t.test("future-snoozed case's task: absent under live, present under all", () => {
    const c = mkCase({ snoozeUntil: "2026-06-15T00:00:00.000Z", tasks: [mkTask()] });
    assert.equal(selectTasks([c], NOW).tasks.length, 0);
    assert.equal(selectTasks([c], NOW, { scope: "all" }).tasks.length, 1);
  });
});

// ── Status ───────────────────────────────────────────────────────────────────
test("status", async (t) => {
  const c = mkCase({
    tasks: [
      mkTask({ id: "T-open", status: "open" }),
      mkTask({ id: "T-prog", status: "in_progress" }),
      mkTask({ id: "T-blocked", status: "blocked" }),
      mkTask({ id: "T-done", status: "done", dueAt: "2026-06-02T00:00:00.000Z" }),
    ],
  });

  await t.test("open/in_progress/blocked present by default, done absent", () => {
    const ids = selectTasks([c], NOW).tasks.map((r) => r.task.id).sort();
    assert.deepEqual(ids, ["T-blocked", "T-open", "T-prog"]);
  });

  await t.test("status:['done'] returns only done rows, still bucketed", () => {
    const rows = selectTasks([c], NOW, { status: ["done"] }).tasks;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task.id, "T-done");
    assert.equal(rows[0].bucket, "week");
  });
});

// ── Filters ──────────────────────────────────────────────────────────────────
test("filters", async (t) => {
  const cases = [
    mkCase({
      id: "CASE-1",
      tasks: [
        mkTask({ id: "T-a", dueAt: "2026-05-30T00:00:00.000Z", owner: "Philip" }),
        mkTask({ id: "T-b", owner: "Alex" }),
      ],
    }),
    mkCase({ id: "CASE-2", tasks: [mkTask({ id: "T-c", owner: "Philip" })] }),
  ];

  await t.test("due narrows to the given buckets", () => {
    const rows = selectTasks(cases, NOW, { due: ["overdue"] }).tasks;
    assert.deepEqual(rows.map((r) => r.task.id), ["T-a"]);
  });

  await t.test("caseId narrows to one case", () => {
    const rows = selectTasks(cases, NOW, { caseId: "CASE-2" }).tasks;
    assert.deepEqual(rows.map((r) => r.task.id), ["T-c"]);
  });

  await t.test("owner narrows by trimmed equality", () => {
    const rows = selectTasks(cases, NOW, { owner: "Philip" }).tasks;
    assert.deepEqual(rows.map((r) => r.task.id).sort(), ["T-a", "T-c"]);
  });
});

// ── Ordering ─────────────────────────────────────────────────────────────────
test("ordering: bucket, then due ascending, then createdAt ascending", () => {
  const c = mkCase({
    tasks: [
      mkTask({ id: "T-later", dueAt: "2026-06-10T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z" }),
      mkTask({ id: "T-undated-old", createdAt: "2026-05-01T00:00:00.000Z" }),
      mkTask({ id: "T-undated-new", createdAt: "2026-05-20T00:00:00.000Z" }),
      mkTask({ id: "T-overdue", dueAt: "2026-05-30T00:00:00.000Z", createdAt: "2026-05-10T00:00:00.000Z" }),
      mkTask({ id: "T-today", dueAt: "2026-05-31T00:00:00.000Z", createdAt: "2026-05-10T00:00:00.000Z" }),
    ],
  });
  const ids = selectTasks([c], NOW).tasks.map((r) => r.task.id);
  assert.deepEqual(ids, ["T-overdue", "T-today", "T-later", "T-undated-old", "T-undated-new"]);
});

// ── Projection ───────────────────────────────────────────────────────────────
test("projection carries caseId/caseTitle/caseStatus/domain + the task record", () => {
  const c = mkCase({
    id: "CASE-9",
    title: "Acme onboarding",
    status: "in_progress",
    domain: "work",
    tasks: [mkTask({ id: "T-x", title: "Chase the notary" })],
  });
  const row = selectTasks([c], NOW).tasks[0];
  assert.equal(row.caseId, "CASE-9");
  assert.equal(row.caseTitle, "Acme onboarding");
  assert.equal(row.caseStatus, "in_progress");
  assert.equal(row.domain, "work");
  assert.equal(row.task.id, "T-x");
  assert.equal(row.task.title, "Chase the notary");
});
