"use client";

// The Activity surface — one reverse-chronological feed of EVERY fact the board has
// recorded, the audit-trail twin of the work surfaces. Its rows come from
// selectors.activityFeed: real case.activity[] entries plus synthesized reminder /
// event lifecycle rows. SSR threads us the live DB slices (cases/messages/reminders/
// events/labels + version) plus a fixed clock (`now`, an ISO string) — we DERIVE the
// feed from the slices with the pure selector, and parse `now` ONCE into a Date and
// feed it to every relative-time + day-grouping computation, so the client never
// constructs its own clock during render (no SSR/hydration drift).
//
// Clicking a row OPENS THE SUBJECT'S DETAIL DRAWER IN PLACE, layered over the feed
// (case → CaseDetailDrawer, reminder → ReminderDrawer, event → EventDrawer) — the
// feed never navigates away. A reminder/event row opens THAT reminder/event, not its
// linked case. The drawers own their mutations; after one, we refetch the matching
// slice (cases WITH archived, to match the feed) so the open drawer and the derived
// feed update without a reload.
//
// The LIST itself is read-only, but the surface IS live: a `lastVersion` ref + a
// `refetch` re-pull the feed's slices, wired through useLiveBoard so the feed streams
// in whenever the board version advances (an external/agent write elsewhere appears
// WITHOUT a reload) — that's what backs the page's "Live" dot. In-place drawer
// mutations refetch their own slice too and advance the ref to suppress the
// self-triggered echo.
//
// Two pure client filters narrow the feed: an ACTOR filter (All · Human · Agent —
// synthesized rows carry no actor, and the handful of legacy "system"-seeded rows
// likewise have no chip, so both show only under "All") and a CATEGORY filter
// (grouping the colour categories from format.feedCategory).

import { useCallback, useMemo, useRef, useState } from "react";
import type { Actor, CaseRecord, MessageRecord, Reminder, CalendarEvent, LabelDef } from "@/lib/types";
import { activityFeed, rolledUpMessageIds, type FeedEntry, todayISO } from "@/lib/selectors";
import {
  relativeTime,
  feedCategory,
  feedVerbLabel,
  feedChipClasses,
  feedDotClass,
  formatDate,
  type FeedCategory,
} from "@/lib/format";
import { fetchCases, fetchReminders, fetchEvents } from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import { CaseDetailDrawer } from "@/components/case-detail-drawer";
import { ReminderDrawer } from "@/components/reminders/reminder-drawer";
import { EventDrawer } from "@/components/calendar/event-drawer";
import { IconActivity } from "@/components/icons";

// The actor filter chips. "all" matches every row; a specific actor matches only
// case rows attributed to it (synth rows have no actor → excluded unless "all").
// No "system" chip: no live write path attributes a row to the system actor (it was
// only ever a one-time seed convention from the original board build), so it would
// never be a meaningful filter. The few legacy system-seeded rows still surface —
// with a "system" badge — under "All".
const ACTOR_FILTERS: { key: "all" | Actor; label: string }[] = [
  { key: "all", label: "All" },
  { key: "human", label: "Human" },
  { key: "agent", label: "Agent" },
];

// The category filter chips. Each maps to a set of FeedCategory values so every
// category is reachable: "Archived" folds in deletes, "Linked" folds in unlinks.
// `neutral` is reachable only via "All" (no surprise verb gets its own chip).
const CATEGORY_FILTERS: { key: string; label: string; cats: FeedCategory[] | null }[] = [
  { key: "all", label: "All", cats: null },
  { key: "create", label: "Created", cats: ["create"] },
  { key: "complete", label: "Completed", cats: ["complete"] },
  { key: "move", label: "Moved", cats: ["move"] },
  { key: "update", label: "Updated", cats: ["update"] },
  { key: "link", label: "Linked", cats: ["link", "unlink"] },
  { key: "note", label: "Notes", cats: ["note"] },
  { key: "archive", label: "Archived", cats: ["archive", "delete"] },
  { key: "flag", label: "Flagged", cats: ["flag"] },
];

// Which subject's drawer is open (each kind opens THAT subject, by its own id).
type Selected = { kind: "case"; id: string } | { kind: "reminder"; id: string } | { kind: "event"; id: string };

export function ActivityView({
  now,
  cases: initialCases,
  messages,
  reminders: initialReminders,
  events: initialEvents,
  labels = [],
  version,
}: {
  now: string;
  cases: CaseRecord[];
  messages: MessageRecord[];
  reminders: Reminder[];
  events: CalendarEvent[];
  labels?: LabelDef[];
  version?: number;
}) {
  // Live state seeded from props — the slices the in-place drawers mutate. `messages`
  // and `labels` stay static props (no client refetch for them, matching board-view).
  const [cases, setCases] = useState<CaseRecord[]>(initialCases);
  const [reminders, setReminders] = useState<Reminder[]>(initialReminders);
  const [events, setEvents] = useState<CalendarEvent[]>(initialEvents);
  // The last board version we've reconciled to. Advanced after our OWN writes (the
  // drawer refetchers + the live refetch) so a self-triggered SSE tick is suppressed;
  // the live subscription only refetches when a NEWER version arrives. (Mirrors the
  // Trash/Priorities/Reminders pattern.)
  const lastVersion = useRef<number>(version ?? 0);

  // Derive the feed from the live slices with the pure selector (replaces the old
  // server-computed `entries` prop). This object literal satisfies activityFeed's
  // DBShape parameter with no cast — it has every required field — and activityFeed
  // ignores everything except cases/reminders/events. Recomputing on slice change
  // keeps the feed consistent with edits made via the in-place drawers.
  const entries = useMemo(
    () =>
      activityFeed(
        { schemaVersion: 0, version: version ?? 0, cases, messages, reminders, events, labels },
        { limit: 200 },
      ),
    [cases, messages, reminders, events, labels, version],
  );

  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives relativeTime + the
  // "Today"/"Yesterday" day-group labels. Never `new Date()` during render.
  const clock = useMemo(() => new Date(now), [now]);

  const [actor, setActor] = useState<"all" | Actor>("all");
  const [category, setCategory] = useState<string>("all");

  // ── In-place drawer state ───────────────────────────────────────────────────
  const [selected, setSelected] = useState<Selected | null>(null);
  // The feed row that opened the current drawer. The drawers don't return focus on
  // close (Esc / overlay / Close), so we restore it here — a keyboard user lands
  // back on the row they came from instead of on <body>.
  const triggerRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setSelected(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    // Defer until after the drawer unmounts this commit, then restore focus.
    if (trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  // Refetchers — re-pull a slice after its drawer mutates, swapping live state so the
  // open drawer and the derived feed stay current. Each is best-effort (a failed
  // refetch just leaves the last-known slice in place; non-critical).
  const refetchCases = useCallback(async () => {
    try {
      // The feed shows ARCHIVED cases too, so include them to stay consistent.
      const r = await fetchCases({ includeArchived: true });
      setCases(r.cases);
      lastVersion.current = r.version;
    } catch {
      // Non-critical: keep the last-known cases.
    }
  }, []);
  const refetchReminders = useCallback(async () => {
    try {
      const r = await fetchReminders();
      setReminders(r.reminders);
      lastVersion.current = r.version;
    } catch {
      // Non-critical: keep the last-known reminders.
    }
  }, []);
  const refetchEvents = useCallback(async () => {
    try {
      const r = await fetchEvents();
      setEvents(r.events);
      lastVersion.current = r.version;
    } catch {
      // Non-critical: keep the last-known events.
    }
  }, []);

  // ── Live reconciliation ───────────────────────────────────────────────────────
  // Re-pull ALL three live slices the feed derives from — the same way the page seeds
  // them (cases WITH archived, to match the feed) — and advance lastVersion to the max
  // we saw, so the derived feed picks up external/agent writes without a reload. Each
  // is best-effort; a failed refetch leaves the last-known slice in place. (messages
  // and labels stay static props, matching the drawer refetchers above.)
  const refetch = useCallback(async () => {
    try {
      const [cs, rs, es] = await Promise.all([
        fetchCases({ includeArchived: true }),
        fetchReminders(),
        fetchEvents(),
      ]);
      setCases(cs.cases);
      setReminders(rs.reminders);
      setEvents(es.events);
      lastVersion.current = Math.max(cs.version, rs.version, es.version);
    } catch {
      // Non-critical: a failed refetch just leaves the last-known slices in place.
    }
  }, []);

  useLiveBoard(lastVersion, refetch);

  // Open the drawer for a row's subject. A reminder/event row opens THAT reminder/
  // event (its subjectId), NOT its linked case — only case rows open a case.
  const openEntry = useCallback((entry: FeedEntry) => {
    // Remember the focused row so close() can return focus to it.
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    if (entry.kind === "case") {
      setSelected({ kind: "case", id: entry.caseId ?? entry.subjectId });
    } else if (entry.kind === "reminder") {
      setSelected({ kind: "reminder", id: entry.subjectId });
    } else {
      setSelected({ kind: "event", id: entry.subjectId });
    }
  }, []);

  // Resolve the open subject against the live slices (null when none / vanished).
  const selectedCase =
    selected?.kind === "case" ? cases.find((c) => c.id === selected.id) ?? null : null;
  const selectedReminder =
    selected?.kind === "reminder" ? reminders.find((r) => r.id === selected.id) ?? null : null;
  const selectedEvent =
    selected?.kind === "event" ? events.find((e) => e.id === selected.id) ?? null : null;

  // The case drawer's Messages section rolls up every message linked to the case OR
  // any descendant (rolledUpMessageIds — self first, de-duplicated), then sorts
  // newest-first. COPIED VERBATIM from board-view (a bad/absent receivedAt sinks to
  // the bottom), gated on a resolved selectedCase and including archived to match the
  // feed's archived-inclusive rollup.
  const drawerMessages = useMemo(() => {
    if (!selectedCase) return [];
    const ids = new Set(rolledUpMessageIds(cases, selectedCase.id, { includeArchived: true }));
    // Newest-first; normalize so a bad/absent receivedAt (NaN) deterministically
    // sinks to the bottom rather than landing in an engine-dependent spot.
    const receivedMs = (m: MessageRecord): number => {
      const n = new Date(m.receivedAt).getTime();
      return Number.isNaN(n) ? -Infinity : n;
    };
    return messages
      .filter((m) => ids.has(m.id))
      .sort((a, b) => receivedMs(b) - receivedMs(a));
  }, [selectedCase, cases, messages]);

  // Apply both filters. A row matches the actor filter under "all", or when its own
  // actor equals the selection (synth rows have no actor → fail any non-"all" pick).
  // It matches the category filter under "all", or when its verb's category is in the
  // selected chip's set.
  const filtered = useMemo(() => {
    const catDef = CATEGORY_FILTERS.find((c) => c.key === category);
    const cats = catDef?.cats ?? null;
    return entries.filter((e) => {
      if (actor !== "all" && e.actor !== actor) return false;
      if (cats && !cats.includes(feedCategory(e.verb))) return false;
      return true;
    });
  }, [entries, actor, category]);

  // Day-grouping using the fixed clock. entries arrive DESC-sorted; bucketing by
  // UTC calendar day (todayISO — the app-wide UTC day anchor) preserves that order
  // within and across groups. Label: "Today" / "Yesterday" / a locale date.
  const groups = useMemo(() => groupByDay(filtered, clock), [filtered, clock]);

  const hasAny = entries.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-ink-50">
      {/* Toolbar — actor filter on the left, category filter on the right. */}
      <div className="h-12 px-5 flex items-center gap-3 border-b border-ink-100 bg-white shrink-0 overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          {ACTOR_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              active={actor === f.key}
              onClick={() => setActor(f.key)}
            />
          ))}
        </div>
        <span className="w-px h-5 bg-ink-100 shrink-0" aria-hidden />
        <div className="flex items-center gap-1 shrink-0">
          {CATEGORY_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              active={category === f.key}
              onClick={() => setCategory(f.key)}
            />
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-[760px] mx-auto space-y-6">
          {!hasAny ? (
            <EmptyState text="No activity yet." />
          ) : groups.length === 0 ? (
            <EmptyState text="No activity matches these filters." />
          ) : (
            groups.map((g) => (
              <section key={g.key}>
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <h2 className="text-[11px] uppercase tracking-wide text-ink-400 font-medium">
                    {g.label}
                  </h2>
                  <span className="text-[11px] text-ink-300 tabular-nums">{g.items.length}</span>
                </div>
                <div className="rounded-lg border border-ink-100 bg-white shadow-card divide-y divide-ink-50 overflow-hidden">
                  {g.items.map((entry) => (
                    <ActivityRow
                      key={entry.key}
                      entry={entry}
                      clock={clock}
                      onOpen={() => openEntry(entry)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {/* In-place drawers — each gated on the resolved record so a vanished/deleted
          subject can never render a stale drawer. */}
      {selectedCase && (
        <CaseDetailDrawer
          caseRec={selectedCase}
          messages={drawerMessages}
          allCases={cases}
          labelCatalog={labels}
          onClose={close}
          onChanged={refetchCases}
        />
      )}
      {selectedReminder && (
        <ReminderDrawer
          reminder={selectedReminder}
          cases={cases}
          onSaved={refetchReminders}
          onClose={close}
        />
      )}
      {selectedEvent && (
        <EventDrawer
          event={selectedEvent}
          date={selectedEvent.date}
          cases={cases}
          // EventDrawer.onSave does NOT close itself (calendar-view closes it via
          // onSaved), so onSaved must refetch AND close.
          onSaved={() => {
            void refetchEvents();
            close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

// A toolbar filter toggle — compact, accessible (aria-pressed), mirroring the
// row-button idiom elsewhere on the board.
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-[12px] px-2.5 py-1 rounded-md transition ${
        active
          ? "bg-ink-900 text-white"
          : "text-ink-600 hover:bg-ink-50 border border-ink-200"
      }`}
    >
      {label}
    </button>
  );
}

// One feed row — a button that opens the subject's detail drawer IN PLACE. Left→right:
// a category colour dot, the subject id (muted), the verb chip, the subject title, an
// optional detail line, an actor badge (case rows only — synth rows omit it), and a
// muted, right-aligned relative timestamp (see agoLabel).
function ActivityRow({
  entry,
  clock,
  onOpen,
}: {
  entry: FeedEntry;
  clock: Date;
  onOpen: () => void;
}) {
  const cat = feedCategory(entry.verb);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left group flex items-center gap-2.5 px-3 py-2.5 hover:bg-ink-50/60 transition"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${feedDotClass(cat)}`} aria-hidden />
      <span className="text-[11px] text-ink-400 tabular-nums shrink-0">{entry.subjectId}</span>
      <span
        className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${feedChipClasses(cat)}`}
      >
        {feedVerbLabel(entry.verb)}
      </span>
      <span className="truncate flex-1 text-[13px] text-ink-800 group-hover:text-ink-900">
        {entry.title}
      </span>
      {entry.detail && (
        <span className="hidden sm:block line-clamp-1 text-[11.5px] text-ink-500 max-w-[200px] shrink-0">
          {entry.detail}
        </span>
      )}
      {entry.actor && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-ink-100 text-ink-600 capitalize">
          {entry.actor}
        </span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-[10.5px] text-ink-400">
        {agoLabel(entry.ts, clock)}
      </span>
    </button>
  );
}

// The friendly empty state — distinct copy for "nothing recorded" vs "filtered out".
function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white py-12 px-6 text-center">
      <IconActivity className="w-5 h-5 mx-auto mb-2 text-ink-300" />
      <p className="text-[13px] text-ink-500">{text}</p>
    </div>
  );
}

// Relative timestamp for a row. relativeTime returns a bare magnitude ("5m", "3h",
// "2d"), "just now", or a locale date for anything older than a week. Append " ago"
// ONLY to the elapsed-magnitude buckets so it never reads "just now ago" or a
// date with a trailing "ago".
function agoLabel(ts: string, clock: Date): string {
  const rt = relativeTime(ts, clock);
  return /^\d+[mhd]$/.test(rt) ? `${rt} ago` : rt;
}

// Bucket the (already DESC-sorted) entries by UTC calendar day, preserving order.
// The label reads "Today" / "Yesterday" relative to the fixed clock's UTC day, else
// a locale date for the bucket's day.
function groupByDay(
  entries: FeedEntry[],
  clock: Date,
): { key: string; label: string; items: FeedEntry[] }[] {
  const todayKey = todayISO(clock);
  const yesterdayKey = todayISO(
    new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() - 1)),
  );
  const groups: { key: string; label: string; items: FeedEntry[] }[] = [];
  const byKey = new Map<string, { key: string; label: string; items: FeedEntry[] }>();
  for (const entry of entries) {
    const dayKey = todayISO(new Date(entry.ts));
    let g = byKey.get(dayKey);
    if (!g) {
      const label =
        dayKey === todayKey
          ? "Today"
          : dayKey === yesterdayKey
            ? "Yesterday"
            : formatDate(entry.ts);
      g = { key: dayKey, label, items: [] };
      byKey.set(dayKey, g);
      groups.push(g);
    }
    g.items.push(entry);
  }
  return groups;
}
