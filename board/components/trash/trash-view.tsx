"use client";

// The Trash surface — every soft-deleted item in one place, newest-deletion first,
// with one-click Restore. Two kinds land here:
//  • CASES — deleting a case on the board sets archivedAt; it leaves the board and
//    appears here until the lazy retention sweep purges it after `retentionDays`.
//  • REMINDERS — a done/dismissed reminder is auto-soft-deleted ~7 days after it
//    finished (store.sweepExpiredReminders), then purged on the SAME retention
//    window as cases. (Open reminders are never auto-deleted.)
// Each row shows when it was deleted and roughly when it will be purged.
//
// SSR seeds the deleted sets + the full case set (so an opened case drawer can
// resolve lineage) + the board version; a live SSE subscription refetches whenever
// the board version advances (mirrors priorities/reminders views). Restore is
// OPTIMISTIC with revert-on-error.

import { useMemo, useRef, useState } from "react";
import type { CaseRecord, Reminder } from "@/lib/types";
import { LANES, caseKind, kindLabel, laneLabel, laneDot } from "@/lib/types";
import { relativeTime, tierAccent } from "@/lib/format";
import {
  fetchCases,
  fetchReminders,
  restoreCase,
  restoreReminder,
} from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconTrash, IconRefresh, IconDot, IconBell } from "@/components/icons";
import { CaseDetailDrawer } from "@/components/case-detail-drawer";

const DAY_MS = 86_400_000;

// Newest-deletion-first. A bad/absent archivedAt (NaN) deterministically sinks to
// the bottom rather than landing in an engine-dependent spot among valid rows.
function byArchivedDesc(a: { archivedAt?: string }, b: { archivedAt?: string }): number {
  const ta = Date.parse(a.archivedAt ?? "");
  const tb = Date.parse(b.archivedAt ?? "");
  return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
}

export function TrashView({
  now,
  deletedCases: initialCases,
  deletedReminders: initialReminders,
  cases,
  version,
  retentionDays,
}: {
  now: string;
  deletedCases: CaseRecord[];
  deletedReminders: Reminder[];
  // The full case set, so the opened case drawer can resolve hierarchy/lineage.
  cases: CaseRecord[];
  version?: number;
  // The retention window (days); <= 0 means auto-purge is disabled, so we hide the
  // "purges in …" hint.
  retentionDays: number;
}) {
  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives relativeTime + the
  // purge countdown. Never `new Date()` during render (no SSR/hydration drift).
  const clock = useMemo(() => new Date(now), [now]);
  const [deletedCases, setDeletedCases] = useState<CaseRecord[]>(initialCases);
  const [deletedReminders, setDeletedReminders] = useState<Reminder[]>(initialReminders);
  const [liveCases, setLiveCases] = useState<CaseRecord[]>(cases);
  const lastVersion = useRef<number>(version ?? 0);
  const [error, setError] = useState<string | null>(null);

  // Open a deleted case's drawer in place (the Activity/Priorities precedent).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedCase = selectedId ? liveCases.find((c) => c.id === selectedId) ?? null : null;

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch both deleted sets (incl. archived) + the live case set for the drawer.
  const refetch = async (): Promise<void> => {
    try {
      const [cs, rs] = await Promise.all([
        fetchCases({ includeArchived: true }),
        fetchReminders({ includeArchived: true }),
      ]);
      lastVersion.current = Math.max(cs.version, rs.version);
      setLiveCases(cs.cases);
      setDeletedCases(cs.cases.filter((c) => c.archivedAt).sort(byArchivedDesc));
      setDeletedReminders(rs.reminders.filter((r) => r.archivedAt).sort(byArchivedDesc));
    } catch {
      // Non-critical: a failed refetch just leaves the last-known state in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // ── Restore (clear archivedAt) ──────────────────────────────────────────────
  const onRestoreCase = async (id: string): Promise<void> => {
    const before = deletedCases;
    setError(null);
    setDeletedCases((cur) => cur.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
    try {
      const res = await restoreCase(id);
      if (typeof res.version === "number") lastVersion.current = res.version;
      setLiveCases((cur) => cur.map((c) => (c.id === id ? { ...c, archivedAt: undefined } : c)));
    } catch (e) {
      setDeletedCases(before); // revert
      setError(e instanceof Error ? e.message : "Couldn't restore that case.");
      void refetch();
    }
  };

  const onRestoreReminder = async (id: string): Promise<void> => {
    const before = deletedReminders;
    setError(null);
    setDeletedReminders((cur) => cur.filter((r) => r.id !== id));
    try {
      const res = await restoreReminder(id);
      if (typeof res.version === "number") lastVersion.current = res.version;
    } catch (e) {
      setDeletedReminders(before); // revert
      setError(e instanceof Error ? e.message : "Couldn't restore that reminder.");
      void refetch();
    }
  };

  const total = deletedCases.length + deletedReminders.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Trash</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {total} deleted item{total === 1 ? "" : "s"}
        </span>
        {retentionDays > 0 && (
          <span className="ml-auto text-[11px] text-ink-400">
            Auto-purged {retentionDays} days after deletion
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2"
        >
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-rose-500 hover:text-rose-700 px-1"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {total === 0 ? (
            <TrashEmpty />
          ) : (
            <>
              {/* ── Cases ─────────────────────────────────────────────────── */}
              {deletedCases.length > 0 && (
                <TrashSection title="Cases" count={deletedCases.length}>
                  {deletedCases.map((c) => (
                    <CaseRow
                      key={c.id}
                      caseRec={c}
                      retentionDays={retentionDays}
                      clock={clock}
                      onOpen={() => setSelectedId(c.id)}
                      onRestore={() => onRestoreCase(c.id)}
                    />
                  ))}
                </TrashSection>
              )}

              {/* ── Reminders ─────────────────────────────────────────────── */}
              {deletedReminders.length > 0 && (
                <TrashSection title="Reminders" count={deletedReminders.length}>
                  {deletedReminders.map((r) => (
                    <ReminderRow
                      key={r.id}
                      reminder={r}
                      retentionDays={retentionDays}
                      clock={clock}
                      onRestore={() => onRestoreReminder(r.id)}
                    />
                  ))}
                </TrashSection>
              )}
            </>
          )}
        </div>
      </div>

      {/* In-place case drawer — gated on the resolved record so a restored/vanished
          case can never render a stale drawer. onChanged refetches so the lists +
          drawer stay live (e.g. restoring from inside the drawer drops the row). */}
      {selectedCase && (
        <CaseDetailDrawer
          caseRec={selectedCase}
          messages={[]}
          allCases={liveCases}
          onClose={() => setSelectedId(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}

// A titled, bordered group (Cases / Reminders), matching the Priorities sections.
function TrashSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">{title}</h2>
        <span className="text-[11px] text-ink-300 tabular-nums">{count}</span>
      </div>
      <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
        {children}
      </div>
    </section>
  );
}

// One deleted-case row: Restore, id, optional tier badge, title, last lane, when it
// was deleted, and a muted "purges in N days" countdown. Clicking the row (not
// Restore) opens the case drawer in place.
function CaseRow({
  caseRec,
  retentionDays,
  clock,
  onOpen,
  onRestore,
}: {
  caseRec: CaseRecord;
  retentionDays: number;
  clock: Date;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const kind = caseKind(caseRec);
  const lane = LANES.find((l) => l.key === caseRec.status) ?? null;
  const purgeLabel = purgeCountdown(caseRec.archivedAt, retentionDays, clock);

  const onRestoreClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onRestore();
    } finally {
      setBusy(false);
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
      <RestoreButton id={caseRec.id} busy={busy} onClick={onRestoreClick} />
      <span className="shrink-0 text-[11px] tabular-nums text-ink-400 font-medium">{caseRec.id}</span>
      {kind !== "case" && (
        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tierAccent(kind)}`}>
          {kindLabel(kind)}
        </span>
      )}
      <span className="flex-1 min-w-0 truncate text-[13px] text-ink-700">{caseRec.title}</span>
      {lane && (
        <span className="shrink-0 hidden sm:inline-flex items-center gap-1.5 text-[11px] text-ink-400">
          <IconDot className={`w-2 h-2 ${laneDot(caseRec.status).replace("bg-", "text-")}`} />
          {laneLabel(caseRec.status)}
        </span>
      )}
      <DeletedStamp archivedAt={caseRec.archivedAt} purgeLabel={purgeLabel} clock={clock} />
    </div>
  );
}

// One deleted-reminder row: Restore, id, a status chip (done/dismissed), the title,
// when it was deleted, and the purge countdown. Not clickable (no in-place reminder
// drawer here — restore brings it back to the Reminders surface to act on).
function ReminderRow({
  reminder,
  retentionDays,
  clock,
  onRestore,
}: {
  reminder: Reminder;
  retentionDays: number;
  clock: Date;
  onRestore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const purgeLabel = purgeCountdown(reminder.archivedAt, retentionDays, clock);

  const onRestoreClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onRestore();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2.5">
      <RestoreButton id={reminder.id} busy={busy} onClick={onRestoreClick} />
      <IconBell className="w-3.5 h-3.5 shrink-0 text-ink-300" />
      <span className="shrink-0 text-[11px] tabular-nums text-ink-400 font-medium">{reminder.id}</span>
      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-ink-100 text-ink-500">
        {reminder.status}
      </span>
      <span className="flex-1 min-w-0 truncate text-[13px] text-ink-700">{reminder.title}</span>
      <DeletedStamp archivedAt={reminder.archivedAt} purgeLabel={purgeLabel} clock={clock} />
    </div>
  );
}

// The shared circular-arrow Restore button (stops propagation so a row click that
// would open a drawer never fires).
function RestoreButton({
  id,
  busy,
  onClick,
}: {
  id: string;
  busy: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-label={`Restore ${id}`}
      title="Restore"
      className="shrink-0 text-ink-400 hover:text-emerald-600 transition disabled:opacity-50"
    >
      <IconRefresh className="w-4 h-4" />
    </button>
  );
}

// The right-aligned "deleted <when>" + "purges in N days" stamp shared by both rows.
function DeletedStamp({
  archivedAt,
  purgeLabel,
  clock,
}: {
  archivedAt?: string;
  purgeLabel: string;
  clock: Date;
}) {
  if (!archivedAt) return null;
  return (
    <span className="shrink-0 tabular-nums text-[10.5px] text-ink-400 text-right">
      deleted {relativeTime(archivedAt, clock)}
      {purgeLabel && <span className="block text-ink-300">{purgeLabel}</span>}
    </span>
  );
}

// "purges soon" / "purges in N days" from archivedAt + the retention window. Returns
// "" when auto-purge is disabled (retentionDays <= 0) or the timestamp is unparseable.
function purgeCountdown(archivedAt: string | undefined, retentionDays: number, now: Date): string {
  if (retentionDays <= 0 || !archivedAt) return "";
  const due = Date.parse(archivedAt) + retentionDays * DAY_MS;
  if (Number.isNaN(due)) return "";
  const days = Math.ceil((due - now.getTime()) / DAY_MS);
  if (days <= 0) return "purges soon";
  return `purges in ${days} day${days === 1 ? "" : "s"}`;
}

// The empty state — a muted trash glyph and a friendly note.
function TrashEmpty() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <IconTrash className="w-5 h-5 mx-auto mb-2 text-ink-300" />
      <p className="text-[12.5px] text-ink-500">Trash is empty.</p>
      <p className="text-[11.5px] text-ink-400 mt-1">
        Deleted cases and old reminders land here and can be restored.
      </p>
    </div>
  );
}
