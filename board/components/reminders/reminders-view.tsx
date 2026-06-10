"use client";

// The Reminders surface — a lightweight list over db.reminders, the close twin of
// the Calendar surface. SSR seeds the reminders list and the board version into
// local state; a live SSE subscription (subscribeToBoard) refetches whenever the
// board version advances past what we last saw (mirrors calendar-view), so an agent
// or another tab adding/closing a reminder lands here without a reload.
//
// A reminder is a SIMPLE, LIGHTWEIGHT nudge — "a reminder to CHECK or to DO
// something" — deliberately lighter than a Case (no tasks, no lanes, no hierarchy).
// It may OPTIONALLY point at ONE board node (Initiative/Workstream/Case) via caseId.
//
// OPEN reminders are grouped by due bucket (Overdue · Today · Soon · Later · No
// date) via the dueStatus selector and ordered with sortReminders; finished ones
// drop into a dimmed "Done & dismissed" section. Every mutation routes through the
// ReminderDrawer or the row toggle (board-client create/update/complete/delete) and
// triggers a refetch.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Reminder, CaseRecord, LabelDef } from "@/lib/types";
import { LANES, caseKind, kindLabel } from "@/lib/types";
import { dueStatus, sortReminders, type DueStatus } from "@/lib/selectors";
import {
  fetchReminders,
  completeReminder,
  updateReminder,
} from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { dueLabel, dueClasses, domainLabel, domainClasses, tierAccent, labelChipClasses } from "@/lib/format";
import { IconPlus, IconDot, IconCheckCircle, IconCircle, IconChevronRight, IconChevronDown, IconWarning } from "@/components/icons";
import { ReminderDrawer } from "./reminder-drawer";

// What the drawer is doing: composing a new reminder, or editing an existing one.
type Compose = { mode: "create" } | { mode: "edit"; reminder: Reminder };

// The OPEN due buckets, in display order. "No date" (dueStatus "none") sorts last.
const BUCKETS: { key: DueStatus; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "soon", label: "Soon" },
  { key: "later", label: "Later" },
  { key: "none", label: "No date" },
];

export function RemindersView({
  now,
  reminders: initialReminders,
  cases,
  labels = [],
  version,
}: {
  now: string;
  reminders: Reminder[];
  cases: CaseRecord[];
  // The label catalog (db.labels), threaded from the page so rows can resolve a
  // reminder's label ids to title/colour chips without each fetching it.
  labels?: LabelDef[];
  version?: number;
}) {
  // Live reminders list, seeded from SSR. The board version we last reconciled to —
  // a ref so the SSE callback always compares against the freshest value.
  const [reminders, setReminders] = useState<Reminder[]>(initialReminders);
  const lastVersion = useRef<number>(version ?? 0);
  // The "Done & dismissed" pile is collapsed by default (it only grows) — click the
  // header to expand it.
  const [showFinished, setShowFinished] = useState(false);

  // id → LabelDef map for resolving a reminder's label ids on the rows.
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives dueStatus bucketing +
  // the rows' due classification/label. Never `new Date()` during render, so SSR and
  // the first client render classify against the same instant (no hydration drift).
  const clock = useMemo(() => new Date(now), [now]);

  // Drawer state — null when closed.
  const [compose, setCompose] = useState<Compose | null>(null);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the full reminder list and replace state, advancing lastVersion.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchReminders();
      setReminders(res.reminders);
      lastVersion.current = res.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known reminders in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // ── Deep-link (?reminder=<id>) ──────────────────────────────────────────────
  // Opened from the Activity feed (and anywhere else): if the URL names a reminder,
  // open it in the drawer in edit mode. A one-time entry condition resolved against
  // the SSR-seeded `reminders` (fully populated on mount), NOT a live binding; an id
  // that matches nothing is silent. We do not rewrite the URL afterwards.
  const searchParams = useSearchParams();
  useEffect(() => {
    const id = searchParams.get("reminder");
    if (!id) return;
    const r = reminders.find((x) => x.id === id);
    if (r) setCompose({ mode: "edit", reminder: r });
    // run once on mount; deep-link is an entry condition, not a live binding
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Partition: open reminders bucketed by due status; finished ones in their own pile.
  const open = reminders.filter((r) => r.status === "open");
  const finished = sortReminders(reminders.filter((r) => r.status !== "open"));
  const openBuckets = BUCKETS.map((b) => ({
    ...b,
    items: sortReminders(open.filter((r) => dueStatus(r.dueAt, clock) === b.key)),
  })).filter((b) => b.items.length > 0);

  const hasAny = reminders.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left, New reminder on the right. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Reminders</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {open.length} open
        </span>
        <button
          onClick={() => setCompose({ mode: "create" })}
          className="ml-auto inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
        >
          <IconPlus className="w-3.5 h-3.5" />
          New reminder
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {!hasAny ? (
            <EmptyState onCompose={() => setCompose({ mode: "create" })} />
          ) : (
            <>
              {/* OPEN reminders, grouped by due bucket. */}
              {openBuckets.length === 0 ? (
                <div className="text-[12.5px] text-ink-400 text-center py-8">
                  Nothing open — every reminder is done or dismissed.
                </div>
              ) : (
                openBuckets.map((bucket) => (
                  <section key={bucket.key}>
                    <div className="flex items-center gap-2 mb-1.5 px-1">
                      <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                        {bucket.label}
                      </h2>
                      <span className="text-[11px] text-ink-300 tabular-nums">
                        {bucket.items.length}
                      </span>
                    </div>
                    <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                      {bucket.items.map((r) => (
                        <ReminderRow
                          key={r.id}
                          reminder={r}
                          cases={cases}
                          labelById={labelById}
                          clock={clock}
                          onOpen={() => setCompose({ mode: "edit", reminder: r })}
                          onMutated={refetch}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}

              {/* Done & dismissed — a muted, visually-separated pile, COLLAPSED by
                  default (it only accrues over time). Click the header to expand. */}
              {finished.length > 0 && (
                <section className="pt-2 border-t border-ink-100">
                  <button
                    type="button"
                    onClick={() => setShowFinished((v) => !v)}
                    aria-expanded={showFinished}
                    className="w-full flex items-center gap-1.5 mb-1.5 px-1 text-ink-300 hover:text-ink-500 transition"
                  >
                    {showFinished ? (
                      <IconChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <IconChevronRight className="w-3.5 h-3.5" />
                    )}
                    <h2 className="text-[11px] uppercase tracking-wide font-medium">
                      Done &amp; dismissed
                    </h2>
                    <span className="text-[11px] tabular-nums">{finished.length}</span>
                  </button>
                  {showFinished && (
                    <div className="rounded-lg border border-ink-100 bg-ink-50/40 divide-y divide-ink-100/60 overflow-hidden opacity-80">
                      {finished.map((r) => (
                        <ReminderRow
                          key={r.id}
                          reminder={r}
                          cases={cases}
                          labelById={labelById}
                          clock={clock}
                          onOpen={() => setCompose({ mode: "edit", reminder: r })}
                          onMutated={refetch}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {compose && (
        <ReminderDrawer
          reminder={compose.mode === "edit" ? compose.reminder : null}
          cases={cases}
          onSaved={refetch}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

// The friendly empty state — shown when there are no reminders at all.
function EmptyState({ onCompose }: { onCompose: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <p className="text-[13px] text-ink-700 font-medium mb-1">No reminders yet</p>
      <p className="text-[12.5px] text-ink-500 max-w-[420px] mx-auto mb-4">
        Capture a quick check or to-do, optionally linked to a case/initiative/workstream.
      </p>
      <button
        onClick={onCompose}
        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
      >
        <IconPlus className="w-3.5 h-3.5" />
        New reminder
      </button>
    </div>
  );
}

// One reminder row: a round complete toggle on the left, then the title (struck
// through + muted when done/dismissed), an optional node chip (id + tier badge for
// containers + lane dot + truncated title), resolved label chips, a task-progress
// chip (done/total when tasks exist), a due chip, and an optional domain chip.
// Clicking the row (not the toggle) opens the editor; the toggle flips status and
// refetches. The toggle stops propagation so it never opens the drawer.
function ReminderRow({
  reminder,
  cases,
  labelById,
  clock,
  onOpen,
  onMutated,
}: {
  reminder: Reminder;
  cases: CaseRecord[];
  labelById: Map<string, LabelDef>;
  // The fixed, SSR-minted clock threaded from RemindersView — the row never builds
  // its own, so due classification/label match the server render (no hydration drift).
  clock: Date;
  onOpen: () => void;
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Row-level toggle error — mirrors the drawer's error banner so a failed
  // done/open flip surfaces instead of silently no-op-ing. Cleared on the next try.
  const [error, setError] = useState<string | null>(null);
  const isOpen = reminder.status === "open";
  const linked = reminder.caseId ? cases.find((c) => c.id === reminder.caseId) ?? null : null;
  const lane = linked ? LANES.find((l) => l.key === linked.status) ?? null : null;
  const status = dueStatus(reminder.dueAt, clock);
  const labelIds = reminder.labels ?? [];
  const tasks = reminder.tasks ?? [];
  const tasksDone = tasks.filter((t) => t.done).length;

  // Toggle: an open reminder completes; a done/dismissed one re-opens. onMutated()
  // runs in `finally` so BOTH success and failure trigger the reconciling refetch —
  // on failure the row snaps back to server truth (no optimistic state to desync),
  // and we surface the error inline (mirroring the drawer) so it never silently no-ops.
  const onToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (isOpen) {
        await completeReminder(reminder.id);
      } else {
        await updateReminder(reminder.id, { status: "open" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the reminder.");
    } finally {
      setBusy(false);
      onMutated();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer hover:bg-ink-50/60 transition"
    >
      {/* Complete toggle */}
      <button
        onClick={onToggle}
        disabled={busy}
        aria-label={isOpen ? "Mark done" : "Re-open"}
        title={isOpen ? "Mark done" : "Re-open"}
        className="shrink-0 text-ink-300 hover:text-lane-done transition disabled:opacity-50"
      >
        {isOpen ? (
          <IconCircle className="w-4 h-4" />
        ) : (
          <IconCheckCircle className="w-4 h-4 text-lane-done" />
        )}
      </button>

      {/* Title */}
      <span
        className={`flex-1 min-w-0 truncate text-[13px] ${
          isOpen ? "text-ink-900" : "text-ink-400 line-through"
        }`}
      >
        {reminder.title}
      </span>

      {/* Toggle error — a brief inline signal (rose, mirroring the drawer's banner)
          so a failed done/open flip never silently no-ops. Click to dismiss; stop
          propagation so it doesn't open the drawer. */}
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

      {/* Node chip — id + tier badge (containers) + lane dot + truncated title. */}
      {linked && (
        <span
          className="shrink-0 inline-flex items-center gap-1.5 max-w-[220px] px-1.5 py-0.5 rounded-md border border-ink-100 bg-ink-50/60 text-[11px]"
          title={`${linked.id} · ${linked.title}`}
        >
          <span className="tabular-nums text-ink-500 font-medium shrink-0">{linked.id}</span>
          {caseKind(linked) !== "case" && (
            <span
              className={`shrink-0 text-[9.5px] px-1 py-px rounded-full font-medium ${tierAccent(
                caseKind(linked),
              )}`}
            >
              {kindLabel(caseKind(linked))}
            </span>
          )}
          {lane && (
            <IconDot className={`w-2 h-2 shrink-0 ${lane.dotClass.replace("bg-", "text-")}`} />
          )}
          <span className="text-ink-600 truncate">{linked.title}</span>
        </span>
      )}

      {/* Label chips — resolved against the catalog (muted when an id is unknown). */}
      {labelIds.length > 0 && (
        <span className="shrink-0 inline-flex items-center gap-1">
          {labelIds.map((id) => {
            const def = labelById.get(id);
            return (
              <span
                key={id}
                title={def?.description ?? `Unknown label: ${id}`}
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${labelChipClasses(def?.color)} ${
                  def ? "" : "opacity-60 italic"
                }`}
              >
                {def?.title ?? id}
              </span>
            );
          })}
        </span>
      )}

      {/* Task-progress chip — done/total, shown only when the reminder has tasks. */}
      {tasks.length > 0 && (
        <span
          className="shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-600"
          title="Checklist progress"
        >
          {tasksDone}/{tasks.length}
        </span>
      )}

      {/* Due chip */}
      {reminder.dueAt && (
        <span
          className={`shrink-0 text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ${dueClasses(
            status,
          )}`}
        >
          {dueLabel(reminder.dueAt, clock)}
        </span>
      )}

      {/* Domain chip — optional/advisory. */}
      {reminder.domain && (
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${domainClasses(
            reminder.domain,
          )}`}
        >
          {domainLabel(reminder.domain)}
        </span>
      )}
    </div>
  );
}
