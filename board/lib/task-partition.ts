import type { Task } from "./types";

// The open/completed split behind the case drawer's Tasks disclosure (ops#52): a
// completed task collapses out of the default checklist instead of sitting in it
// forever, and the open list orders by due date instead of raw array order. PURE
// given `tasks` — no clock, no React, no I/O — this is a plain comparator over a
// prop array (board/components/case-detail-drawer.tsx's TasksSection wraps it in
// useMemo). "Overdue first, then dueAt ascending, then undated" is exactly what
// ascending-by-date-with-undated-last produces (a past date is a smaller number
// than a future one), so this deliberately takes no `now` and never calls
// dueStatus() — pulling in the date-only-UTC-midnight timezone frame that
// tests/unit/due-status.test.ts exists to police would buy nothing here. Do not
// "improve" this with a clock later.
export interface TaskPartition {
  open: Task[]; // status !== "done" — dueAt ascending, undated last, stable
  completed: Task[]; // status === "done" — completedAt ascending, undated last, stable
}

// Epoch ms for a date field; absent or unparseable sorts last (+Infinity). Mirrors
// sortReminders' `due()` helper (selectors.ts) one record-type over.
function ts(iso?: string): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : t;
}

// Partitions on `status === "done"` only — never on `completedAt` presence, since
// store.ts clears completedAt when a task un-completes, making status the
// authoritative signal. `Array.prototype.filter` already returns a fresh array,
// so sorting its result never mutates the `tasks` prop passed in; JS sort is
// stable (ES2019+), so undated rows keep their relative input order.
export function partitionTasks(tasks: Task[]): TaskPartition {
  const open = tasks.filter((t) => t.status !== "done").sort((a, b) => ts(a.dueAt) - ts(b.dueAt));
  const completed = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => ts(a.completedAt) - ts(b.completedAt));
  return { open, completed };
}
