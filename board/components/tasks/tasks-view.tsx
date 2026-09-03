"use client";

// The Tasks surface — the board's plain open-task enumeration (cos-ops#51). Every
// task, from every case, that add_task/update_task/complete_task/delete_task can
// touch but nothing could previously LIST. SSR seeds both the open list (default
// scope: live, every status except done) and the completed list (status: done,
// scope: all — a completion history follows a task past its case closing); a live
// SSE subscription (subscribeToBoard via useLiveBoard) refetches both whenever the
// board version advances past what we last saw, so a completion from another tab
// or an agent lands here without a reload.
//
// Open tab (default): sections in TASK_BUCKETS order — Overdue / Today / This week
// / Later / Undated (a first-class bucket, never dropped — most open tasks on this
// board carry no date at all). The checkbox is the ONLY tap target that mutates —
// it calls the existing complete_task path (board-client's completeTask) and
// refetches; there is no optimistic state (mirrors reminders-view's row toggle:
// "on failure the row snaps back to server truth") — the row simply falls out of
// the fresh default query once its task is done.
//
// Completed tab: grouped by completion DAY (todayISO(completedAt), the same
// UTC-day frame every other day-relative read on this board uses), newest day
// first — a cross-case HISTORY FEED reads newest-first (the activity-feed
// convention), unlike the case drawer's checklist tail (task-partition.ts sorts a
// single case's completed tasks ascending, oldest-first, for a chronological
// read of ONE case). A missing/unparseable completedAt is never dropped or
// "fixed" — it lands in a trailing "No completion date" group.
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { TaskListRow, TaskBucket } from "@/lib/selectors";
import { TASK_BUCKETS, dueStatus, todayISO } from "@/lib/selectors";
import { fetchTasks, completeTask } from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { dueLabel, dueClasses, caseHref } from "@/lib/format";
import { IconCircle, IconCheckCircle, IconWarning } from "@/components/icons";

const BUCKET_LABEL: Record<TaskBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  undated: "Undated",
};

type Tab = "open" | "completed";

export function TasksView({
  now,
  open: initialOpen,
  completed: initialCompleted,
  version,
}: {
  now: string;
  open: TaskListRow[];
  completed: TaskListRow[];
  version?: number;
}) {
  const [open, setOpen] = useState<TaskListRow[]>(initialOpen);
  const [completed, setCompleted] = useState<TaskListRow[]>(initialCompleted);
  const lastVersion = useRef<number>(version ?? 0);
  const [tab, setTab] = useState<Tab>("open");

  // Fixed clock, parsed ONCE from the SSR `now` prop — never `new Date()` during
  // render, so SSR and the first client render classify due chips identically
  // (mirrors reminders-view's clock).
  const clock = useMemo(() => new Date(now), [now]);

  // Refetch BOTH lists and advance lastVersion — mirrors the page's own two
  // selectTasks calls so a completion (here or elsewhere) is reflected in both
  // tabs without a reload.
  const refetch = async (): Promise<void> => {
    try {
      const [openRes, completedRes] = await Promise.all([
        fetchTasks(),
        fetchTasks({ status: ["done"], scope: "all" }),
      ]);
      setOpen(openRes.tasks);
      setCompleted(completedRes.tasks);
      lastVersion.current = Math.max(openRes.version, completedRes.version);
    } catch {
      // Non-critical: a failed refetch just leaves the last-known lists in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  const openBuckets = TASK_BUCKETS.map((b) => ({
    key: b,
    label: BUCKET_LABEL[b],
    items: open.filter((r) => r.bucket === b),
  })).filter((b) => b.items.length > 0);

  const completedGroups = useMemo(() => groupCompleted(completed), [completed]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — tabs on the left, counts on the right. */}
      <div className="h-12 px-5 flex items-center gap-1 border-b border-ink-100 bg-white shrink-0">
        <div role="tablist" className="flex items-center gap-1">
          <TabButton active={tab === "open"} onClick={() => setTab("open")}>
            Open
          </TabButton>
          <TabButton active={tab === "completed"} onClick={() => setTab("completed")}>
            Completed
          </TabButton>
        </div>
        <span className="ml-auto text-[12px] text-ink-400 tabular-nums">
          {tab === "open" ? `${open.length} open` : `${completed.length} completed`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {tab === "open" ? (
            openBuckets.length === 0 ? (
              <EmptyState message="Nothing open — every task is done." />
            ) : (
              openBuckets.map((bucket) => (
                <section key={bucket.key}>
                  <SectionHeading label={bucket.label} count={bucket.items.length} />
                  <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                    {bucket.items.map((row) => (
                      <OpenTaskRow key={row.task.id} row={row} clock={clock} onMutated={refetch} />
                    ))}
                  </div>
                </section>
              ))
            )
          ) : completedGroups.days.length === 0 && completedGroups.noDate.length === 0 ? (
            <EmptyState message="Nothing completed yet." />
          ) : (
            <>
              {completedGroups.days.map(({ day, items }) => (
                <section key={day}>
                  <SectionHeading label={day} count={items.length} />
                  <div className="rounded-lg border border-ink-100 bg-ink-50/40 divide-y divide-ink-100/60 overflow-hidden">
                    {items.map((row) => (
                      <CompletedTaskRow key={row.task.id} row={row} />
                    ))}
                  </div>
                </section>
              ))}
              {completedGroups.noDate.length > 0 && (
                <section key="no-date">
                  <SectionHeading label="No completion date" count={completedGroups.noDate.length} />
                  <div className="rounded-lg border border-ink-100 bg-ink-50/40 divide-y divide-ink-100/60 overflow-hidden">
                    {completedGroups.noDate.map((row) => (
                      <CompletedTaskRow key={row.task.id} row={row} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={active}
      className={`text-[12.5px] px-2.5 py-1 rounded-md font-medium transition ${
        active ? "bg-ink-900 text-white" : "text-ink-500 hover:bg-ink-100"
      }`}
    >
      {children}
    </button>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-1.5 px-1">
      <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">{label}</h2>
      <span className="text-[11px] text-ink-300 tabular-nums">{count}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <p className="text-[13px] text-ink-500">{message}</p>
    </div>
  );
}

// Group completed rows by completion DAY (todayISO), newest day first. A
// missing/unparseable completedAt is never dropped — it lands in `noDate`.
function groupCompleted(rows: TaskListRow[]): { days: { day: string; items: TaskListRow[] }[]; noDate: TaskListRow[] } {
  const byDay = new Map<string, TaskListRow[]>();
  const noDate: TaskListRow[] = [];
  for (const row of rows) {
    const completedAt = row.task.completedAt;
    const parsed = completedAt ? new Date(completedAt) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      noDate.push(row);
      continue;
    }
    const day = todayISO(parsed);
    const items = byDay.get(day) ?? [];
    items.push(row);
    byDay.set(day, items);
  }
  const days = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // newest first
    .map(([day, items]) => ({ day, items }));
  return { days, noDate };
}

// The case chip every row carries — id + title, deep-linking to /my-issues?case=
// (caseHref, board-view.tsx's own deep-link consumer; the board's ROOT `/` just
// redirects to /my-issues without forwarding query params, so that would silently
// never open the drawer).
function CaseChip({ caseId, caseTitle }: { caseId: string; caseTitle: string }) {
  return (
    <Link
      href={caseHref(caseId)}
      onClick={(e) => e.stopPropagation()}
      title={`${caseId} · ${caseTitle}`}
      className="shrink-0 inline-flex items-center gap-1.5 max-w-[220px] px-1.5 py-0.5 rounded-md border border-ink-100 bg-ink-50/60 text-[11px] text-ink-600 hover:bg-ink-100/60 transition"
    >
      <span className="tabular-nums text-ink-500 font-medium shrink-0">{caseId}</span>
      <span className="truncate">{caseTitle}</span>
    </Link>
  );
}

// One open task: a round complete toggle (the ONLY tap target that mutates) on
// the left, the title, an optional due chip, then the case chip. No optimistic
// state — onMutated() runs in `finally` so both success and failure trigger the
// reconciling refetch (a failed complete simply leaves the row in place).
function OpenTaskRow({
  row,
  clock,
  onMutated,
}: {
  row: TaskListRow;
  clock: Date;
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { task } = row;

  const onComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await completeTask(row.caseId, task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete the task.");
    } finally {
      setBusy(false);
      onMutated();
    }
  };

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <button
        onClick={onComplete}
        disabled={busy}
        aria-label="Mark done"
        title="Mark done"
        className="shrink-0 text-ink-300 hover:text-lane-done transition disabled:opacity-50"
      >
        <IconCircle className="w-4 h-4" />
      </button>

      <span className="flex-1 min-w-0 truncate text-[13px] text-ink-900">{task.title}</span>

      {error && (
        <span
          role="alert"
          onClick={(e) => {
            e.stopPropagation();
            setError(null);
          }}
          title={`${error} · click to dismiss`}
          className="shrink-0 inline-flex items-center gap-1 max-w-[200px] text-[10.5px] px-1.5 py-0.5 rounded-full font-medium bg-rose-50 text-rose-700 cursor-pointer"
        >
          <IconWarning className="w-3 h-3 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      )}

      {row.due && (
        <span
          className={`shrink-0 text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ${dueClasses(
            dueStatus(row.due, clock),
          )}`}
        >
          {dueLabel(row.due, clock)}
          {row.dueInherited ? " · from case" : ""}
        </span>
      )}

      <CaseChip caseId={row.caseId} caseTitle={row.caseTitle} />
    </div>
  );
}

// One completed task: read-only — a filled check, the (struck-through) title, the
// case chip. No toggle back to open here; re-opening a task is not this surface's
// job (use the case drawer / update_task).
function CompletedTaskRow({ row }: { row: TaskListRow }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 opacity-80">
      <IconCheckCircle className="w-4 h-4 shrink-0 text-lane-done" />
      <span className="flex-1 min-w-0 truncate text-[13px] text-ink-400 line-through">
        {row.task.title}
      </span>
      <CaseChip caseId={row.caseId} caseTitle={row.caseTitle} />
    </div>
  );
}
