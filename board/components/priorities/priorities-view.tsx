"use client";

// The Priorities surface — "what matters most right now", the lightweight twin of
// the Reminders surface. SSR seeds the starred nodes, the free-text priority notes,
// and the board version into local state; a live SSE subscription (subscribeToBoard)
// refetches whenever the board version advances past what we last saw (mirrors
// reminders-view / calendar-view), so an agent or another tab starring a case or
// adding a note lands here without a reload.
//
// Two complementary mechanisms (see docs/features/priorities.md):
//  (A) STARRED nodes — favorites/pins on ANY case/workstream/initiative (all three
//      tiers are CaseRecords in one id space). A filled amber star unstars; clicking
//      the row OPENS that case's detail drawer IN PLACE, layered over the list — the
//      same drawer the rest of the app uses, following the Activity-feed precedent
//      (the feed opens case drawers in place; we mirror it here).
//  (B) PRIORITY NOTES (PRI-<n>) — free-text top-of-mind items the user types in,
//      deliberately lighter than a Reminder (no status/link/tasks/labels). Inline
//      edit + delete, each routed through board-client and reconciled by refetch.
//
// Every mutation is OPTIMISTIC with revert-on-error, mirroring reminders-view: we
// mutate local state immediately, fire the board-client call, and on failure restore
// the pre-gesture snapshot + surface the error (then a refetch reconciles). We never
// persist view state to prefs.json — this surface is entirely server-backed.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseRecord, PriorityNote } from "@/lib/types";
import { LANES, caseKind, kindLabel, laneLabel, laneDot } from "@/lib/types";
import { sortPriorityNotes } from "@/lib/selectors";
import { relativeTime, tierAccent } from "@/lib/format";
import {
  fetchPriorities,
  createPriority,
  updatePriority,
  deletePriority,
  starCase,
} from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { IconStar, IconTrash, IconPlus, IconDot } from "@/components/icons";
import { CaseDetailDrawer } from "@/components/case-detail-drawer";

export function PrioritiesView({
  now,
  priorities: initialPriorities,
  starred: initialStarred,
  cases,
  version,
}: {
  now: string;
  priorities: PriorityNote[];
  starred: CaseRecord[];
  // The full case set, so the opened drawer can resolve hierarchy/lineage; the
  // starred list is the curated subset we render.
  cases: CaseRecord[];
  version?: number;
}) {
  // Live state seeded from SSR. The board version we last reconciled to — a ref so
  // the SSE callback always compares against the freshest value.
  const [priorities, setPriorities] = useState<PriorityNote[]>(initialPriorities);
  const [starred, setStarred] = useState<CaseRecord[]>(initialStarred);
  const [liveCases, setLiveCases] = useState<CaseRecord[]>(cases);
  const lastVersion = useRef<number>(version ?? 0);

  // A surface-level error banner for whole-list failures (rows surface their own
  // inline errors where it makes sense; this covers the composer + star toggles).
  const [error, setError] = useState<string | null>(null);

  // ── Open a starred case in place (the Activity-feed precedent) ───────────────
  // Clicking a starred row opens THAT case's drawer layered over the list; we resolve
  // the record against the live case set so a vanished/unstarred-elsewhere case can
  // never render a stale drawer.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedCase = selectedId ? liveCases.find((c) => c.id === selectedId) ?? null : null;
  // The drawer's Messages section rolls up linked mail; this surface doesn't thread
  // messages, so an empty list is passed (the drawer renders "No linked messages").

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the priorities (notes + starred) and the case set, advancing lastVersion.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchPriorities();
      setPriorities(res.priorities);
      setStarred(res.starred);
      lastVersion.current = res.version;
    } catch {
      // Non-critical: a failed refetch just leaves the last-known state in place.
    }
  };

  useLiveBoard(lastVersion, refetch);

  const sortedNotes = useMemo(() => sortPriorityNotes(priorities), [priorities]);
  const hasStarred = starred.length > 0;

  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives the note rows' relative
  // timestamps. Never `new Date()` during render (no SSR/hydration drift).
  const clock = useMemo(() => new Date(now), [now]);

  // ── Star toggle (unstar a favorite) ─────────────────────────────────────────
  // Optimistically drop the row, fire the case PATCH, revert + surface on error.
  const onUnstar = async (id: string): Promise<void> => {
    const before = starred;
    setError(null);
    setStarred((cur) => cur.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
    try {
      const res = await starCase(id, false);
      if (typeof res.version === "number") lastVersion.current = res.version;
      // Keep the live case set in sync so the drawer reflects the unstarred state.
      setLiveCases((cur) => cur.map((c) => (c.id === id ? { ...c, starred: undefined } : c)));
    } catch (e) {
      setStarred(before); // revert
      setError(e instanceof Error ? e.message : "Couldn't unstar that node.");
      void refetch();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — context on the left. */}
      <div className="h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0">
        <span className="text-[13px] font-semibold text-ink-900">Priorities</span>
        <span className="text-[12px] text-ink-400 tabular-nums">
          {starred.length} starred · {priorities.length} note{priorities.length === 1 ? "" : "s"}
        </span>
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
          {/* ── Section A — Starred favorites ─────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                Starred
              </h2>
              {hasStarred && (
                <span className="text-[11px] text-ink-300 tabular-nums">{starred.length}</span>
              )}
            </div>
            {!hasStarred ? (
              <StarredEmpty />
            ) : (
              <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                {starred.map((c) => (
                  <StarredRow
                    key={c.id}
                    caseRec={c}
                    onOpen={() => setSelectedId(c.id)}
                    onUnstar={() => onUnstar(c.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Section B — Your priorities (free-text notes) ─────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                Your priorities
              </h2>
              {priorities.length > 0 && (
                <span className="text-[11px] text-ink-300 tabular-nums">{priorities.length}</span>
              )}
            </div>

            {/* Composer — type a top-of-mind item; Enter or Add creates it. New notes
                append AFTER the current max position so the manual order stays stable
                (reorder is out of scope for v1; position lives on for agents/future). */}
            <NoteComposer
              notes={priorities}
              onCreate={async (text, position) => {
                const tempId = `PRI-temp-${Date.now()}`;
                const now = new Date().toISOString();
                const optimistic: PriorityNote = {
                  id: tempId,
                  text,
                  position,
                  createdAt: now,
                  updatedAt: now,
                };
                const before = priorities;
                setError(null);
                setPriorities((cur) => [...cur, optimistic]);
                try {
                  const res = await createPriority({ text, position });
                  if (typeof res.version === "number") lastVersion.current = res.version;
                  // Swap the temp placeholder for the server's canonical record.
                  setPriorities((cur) => cur.map((p) => (p.id === tempId ? res.priority : p)));
                } catch (e) {
                  setPriorities(before); // revert
                  setError(e instanceof Error ? e.message : "Couldn't add that priority.");
                  void refetch();
                }
              }}
            />

            {/* The existing notes, in sortPriorityNotes order. */}
            {sortedNotes.length > 0 && (
              <div className="mt-3 rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                {sortedNotes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    clock={clock}
                    onSave={async (text) => {
                      const before = priorities;
                      setError(null);
                      setPriorities((cur) =>
                        cur.map((p) =>
                          p.id === note.id ? { ...p, text, updatedAt: new Date().toISOString() } : p,
                        ),
                      );
                      try {
                        const res = await updatePriority(note.id, { text });
                        if (typeof res.version === "number") lastVersion.current = res.version;
                        setPriorities((cur) => cur.map((p) => (p.id === note.id ? res.priority : p)));
                      } catch (e) {
                        setPriorities(before); // revert
                        setError(e instanceof Error ? e.message : "Couldn't save that priority.");
                        void refetch();
                      }
                    }}
                    onDelete={async () => {
                      const before = priorities;
                      setError(null);
                      setPriorities((cur) => cur.filter((p) => p.id !== note.id));
                      try {
                        const res = await deletePriority(note.id);
                        if (typeof res.version === "number") lastVersion.current = res.version;
                      } catch (e) {
                        setPriorities(before); // revert
                        setError(e instanceof Error ? e.message : "Couldn't delete that priority.");
                        void refetch();
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* In-place case drawer — gated on the resolved record so an unstarred/vanished
          case can never render a stale drawer. Mirrors the Activity feed's open-in-
          place behaviour; onChanged refetches so the starred list + drawer stay live. */}
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

// ── Starred section ────────────────────────────────────────────────────────────
// One starred row: a FILLED amber star (click → unstar, optimistic), a tier badge
// (Initiative/Workstream/Case for containers), the title, and the lane (dot + label).
// Clicking the row (not the star) opens the case drawer in place. The star button
// stops propagation so it never opens the drawer.
function StarredRow({
  caseRec,
  onOpen,
  onUnstar,
}: {
  caseRec: CaseRecord;
  onOpen: () => void;
  onUnstar: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const kind = caseKind(caseRec);
  const lane = LANES.find((l) => l.key === caseRec.status) ?? null;

  const onStarClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onUnstar();
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
      {/* Filled amber star — click to unstar. */}
      <button
        onClick={onStarClick}
        disabled={busy}
        aria-label={`Unstar ${caseRec.id}`}
        title="Unstar"
        className="shrink-0 text-amber-500 hover:text-amber-600 transition disabled:opacity-50"
      >
        <IconStar className="w-4 h-4" fill="currentColor" />
      </button>

      {/* Id */}
      <span className="shrink-0 text-[11px] tabular-nums text-ink-400 font-medium">{caseRec.id}</span>

      {/* Tier badge (containers only — a leaf "case" needs no badge). */}
      {kind !== "case" && (
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tierAccent(kind)}`}
        >
          {kindLabel(kind)}
        </span>
      )}

      {/* Title */}
      <span className="flex-1 min-w-0 truncate text-[13px] text-ink-900">{caseRec.title}</span>

      {/* Lane — dot + label. */}
      {lane && (
        <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] text-ink-500">
          <IconDot className={`w-2 h-2 ${laneDot(caseRec.status).replace("bg-", "text-")}`} />
          {laneLabel(caseRec.status)}
        </span>
      )}
    </div>
  );
}

// The starred empty state — a muted star and a friendly prompt.
function StarredEmpty() {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-10 px-6 text-center">
      <IconStar className="w-5 h-5 mx-auto mb-2 text-ink-300" />
      <p className="text-[12.5px] text-ink-500">
        Star a case, workstream, or initiative to pin it here.
      </p>
    </div>
  );
}

// ── Notes section ──────────────────────────────────────────────────────────────
// The composer for a new free-text priority note. Enter (or the Add button) creates
// it, after which the field clears and refocuses for fast multi-entry. New notes are
// appended AFTER the current max position so the list order is stable.
function NoteComposer({
  notes,
  onCreate,
}: {
  notes: PriorityNote[];
  onCreate: (text: string, position?: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The next manual position: just past the current max (stable append). Absent
  // positions don't participate, so a note-less or position-less list seeds the first.
  const nextPosition = (): number => {
    const positions = notes.map((n) => n.position).filter((p): p is number => typeof p === "number");
    return positions.length ? Math.max(...positions) + 1 : 0;
  };

  const commit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onCreate(text, nextPosition());
      setDraft("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        aria-label="New priority"
        placeholder="What matters most right now…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        className="flex-1 bg-white border border-ink-200 rounded-md px-2.5 py-1.5 text-[13px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400"
      />
      <button
        onClick={() => void commit()}
        disabled={!draft.trim() || busy}
        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-40"
      >
        <IconPlus className="w-3.5 h-3.5" />
        Add
      </button>
    </div>
  );
}

// One priority-note row: click-to-edit text (commit on Enter/blur, Esc cancels) and a
// trash button to delete. Inline edit mirrors the drawer's EditableText idiom; the
// delete confirms (a deliberate destructive click) then optimistically drops the row.
function NoteRow({
  note,
  clock,
  onSave,
  onDelete,
}: {
  note: PriorityNote;
  clock: Date;
  onSave: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Seed the draft + caret when entering edit mode. Keyed on `editing` alone (NOT
  // note.text) so a live SSE/agent refetch mid-edit can't clobber in-progress text.
  useEffect(() => {
    if (!editing) return;
    setDraft(note.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    const text = draft.trim();
    // Empty or unchanged text is ignored (matches applyPriorityUpdate's contract).
    if (!text || text === note.text) return;
    await onSave(text);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(note.text);
  };

  const onDeleteClick = async () => {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete this priority?`)) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2.5">
      {/* A small star-dot accent so notes read as priorities, consistent with the ink palette. */}
      <IconStar className="w-3.5 h-3.5 shrink-0 text-ink-300" />

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          aria-label="Edit priority"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              cancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          className="flex-1 min-w-0 bg-white border border-sky-300 rounded px-1.5 py-1 text-[13px] text-ink-900 outline-none focus:ring-2 focus:ring-sky-100"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Click to edit"
          className="flex-1 min-w-0 text-left text-[13px] text-ink-900 truncate rounded px-1 -mx-1 hover:bg-ink-50 transition cursor-text"
        >
          {note.text}
        </button>
      )}

      {/* Updated timestamp — muted, right-aligned (only when not editing). */}
      {!editing && (
        <span className="shrink-0 tabular-nums text-[10.5px] text-ink-400">
          {relativeTime(note.updatedAt, clock)}
        </span>
      )}

      {/* Delete */}
      <button
        onClick={onDeleteClick}
        disabled={busy}
        aria-label="Delete priority"
        title="Delete priority"
        className="shrink-0 text-ink-300 hover:text-rose-600 transition disabled:opacity-50"
      >
        <IconTrash className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
