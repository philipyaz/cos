# Activity — the unified audit trail on the board

The board records *what happened* in a dozen scattered places: every case carries an append-only
`activity[]` log (created, moved, task completed, email linked, flagged overdue …); reminders are
created, completed, or dismissed; calendar events come into being. Each of those is a **fact** — a
who-did-what-when — but until now there was nowhere to *read them all in one stream*. The **Activity**
surface is that one place: a single **reverse-chronological feed of every fact the board has
recorded**, across every case, reminder, and event. It is the trust ledger made browsable — the
answer to "what changed on the board, and in what order".

Activity replaces the old **Today** nav slot. Today's *worklist* selector (`todayCases`) still
exists and still powers the needs-attention reads; only the nav surface changed. The `/today` route
now **redirects to `/activity`**, so old links and bookmarks keep working.

The feed **list itself is read-only** — it renders the audit trail and never mutates it. But every
row now **opens the subject's detail drawer IN PLACE over the feed** (case → `CaseDetailDrawer`,
reminder → `ReminderDrawer`, event → `EventDrawer`), so the feed is also an **entry point for
editing**: the drawers own their mutations, and after one the matching slice is refetched so the open
drawer and the derived feed update without a reload. The page's "Live" dot is still cosmetic — the
surface does **not** subscribe to the board stream, so an external/agent write elsewhere still needs a
reload to appear.

## Data sources — three streams, one shape

The feed is assembled by the pure `activityFeed(db)` selector (`board/lib/selectors.ts`) from three
sources, flattened into one `FeedEntry[]`:

- **Case rows** — one entry per `case.activity[]` entry, for **every** case including **archived**
  ones (the audit trail shows everything; nothing is filtered by `archivedAt`). These carry the real
  `actor` (`human` / `agent`), `verb`, and optional `detail` verbatim.
- **Reminder rows** — `db.reminders` has no activity log of its own, so the selector **synthesizes**
  lifecycle rows: always a `reminder_created` at `createdAt`; a `reminder_completed` at
  `completedAt ?? updatedAt` when `status === "done"`; a `reminder_dismissed` at `updatedAt` when
  `status === "dismissed"`.
- **Event rows** — one synthesized `event_created` per calendar event at its `createdAt`.

Synthesized (reminder/event) rows carry **no `actor`** — the store never attributes them, so the
property is omitted entirely (not set to `undefined`). Case rows always carry one. A `FeedEntry`:

```ts
export type FeedKind = "case" | "reminder" | "event";

export interface FeedEntry {
  key: string;        // stable, unique, deterministic — also the sort tie-break
  ts: string;         // ISO timestamp this fact occurred at
  actor?: Actor;      // PRESENT only for case rows; OMITTED for synth rows
  verb: string;       // raw verb (real CaseActivity.verb, or a synth verb)
  detail?: string;    // CaseActivity.detail when present (case rows only)
  kind: FeedKind;
  subjectId: string;  // CASE-/REM-/EVT- id of the subject
  title: string;      // subject display title
  caseId?: string;    // set when the row links to a case
}
```

Rows are sorted **newest-`ts` first**, tie-broken by `key` ascending (the key embeds the id + index)
for a deterministic order, then sliced to `opts.limit ?? 200`. The SSR page (`app/activity/page.tsx`)
calls `activityFeed(db, { limit: 200 })`.

### Intended non-dedupe

A reminder linked to a case produces **both** a case-row `reminder_linked` (the *link-time* fact,
pointing **at the case**) and a reminder-row `reminder_created` (the *create-time* fact, pointing
**at the reminder**). These are **different facts at different times linking to different places** —
the feed does **not** dedupe across kinds. A unit test pins this so a future "cleanup" can't collapse
them.

## Colour categories

Every verb maps to one of eleven colour **categories** (`format.feedCategory`), each with a literal
Tailwind chip + dot class (`feedChipClasses` / `feedDotClass` — full literal strings, no runtime
concat, so the content scanner emits them). The verb's readable label comes from `feedVerbLabel`
(explicit entries for every known verb; an unmapped verb humanizes its snake_case).

| Category | Chip / dot | Verbs |
|---|---|---|
| `create` | emerald | `created`, `task_added`, `reminder_created`, `event_created` |
| `complete` | teal | `task_completed`, `reminder_completed` |
| `move` | sky | `moved` |
| `update` | amber | `updated`, `task_updated`, `event_updated`, `restored`, `merged` |
| `link` | indigo | `message_linked`, `reminder_linked`, `event_linked` |
| `unlink` | orange | `message_unlinked` |
| `note` | violet | `note_added` |
| `archive` | ink | `archived`, `reminder_dismissed` |
| `delete` | rose | `task_deleted` |
| `flag` | red | `flagged_overdue` |
| `neutral` | gray | any unlisted verb (the fallback) |

`merged` / `restored` aren't in current data but the store can emit them, so they're mapped for
forward-compat; the `neutral` + humanize fallback covers any surprise verb regardless.

## Opening a subject — drawers in place

Clicking a row **opens the owning detail drawer right on `/activity`**, layered over the feed (no
navigation):

- **case rows** → `CaseDetailDrawer` for `entry.caseId ?? entry.subjectId`;
- **reminder rows** → `ReminderDrawer` for the reminder (`entry.subjectId`) — **that reminder**, not
  its linked case;
- **event rows** → `EventDrawer` for the event (`entry.subjectId`) — **that event**, not its linked
  case.

The open subject is resolved from the **SSR-seeded live slices** (`cases`/`reminders`/`events` kept
in `useState`, seeded from the page props), and each drawer is gated on the resolved record so a
vanished/deleted subject can never render a stale drawer. After a drawer **mutation** the matching
slice is refetched — **cases WITH archived** (the feed shows archived cases, so the refetch includes
them) — which both reconciles the open drawer and recomputes the derived feed without a reload. The
`EventDrawer` does not close itself on save (calendar-view closes it via `onSaved`), so the Activity
view's `onSaved` refetches **and** closes; `CaseDetailDrawer`/`ReminderDrawer` close themselves on the
relevant actions, so their handlers only refetch.

The surface still does **not** subscribe to SSE, so an external/agent write elsewhere needs a reload
to appear. The `feedHref` / `reminderHref` / `eventHref` helpers **remain** in `format.ts` (still
unit-tested), but the view no longer uses them for navigation.

## The fixed-clock contract (no hydration drift)

Relative timestamps ("5m ago", "2d ago") and the **Today** / **Yesterday** day-group labels both
need a "now". To avoid an SSR/hydration mismatch, the **request-time clock is computed once** in the
SSR page (`new Date().toISOString()`) and passed as the `now` ISO prop into the client view. The
client (`components/activity/activity-view.tsx`) parses it **once** (`useMemo(() => new Date(now),
[now])`) and feeds that single `clock` to `relativeTime` and to the day-grouping — it **never** calls
`new Date()` during render. Day-grouping uses UTC-day keys (`todayISO`), consistent with the rest of
the app's UTC-anchored day math.

## Filters

Two pure client filters narrow the feed (ephemeral `useState`, not persisted):

- **Actor** — `All · Human · Agent`. A specific actor matches only case rows attributed to
  it; synthesized rows (no actor) show only under **All**.
- **Category** — `All · Created · Completed · Moved · Updated · Linked · Notes · Archived · Flagged`.
  Each chip maps to a set of categories so every category is reachable (**Linked** folds in unlinks,
  **Archived** folds in deletes); `neutral` is reachable only via **All**.

## Code map

- **Selector** — `activityFeed` + `FeedKind` / `FeedEntry` in `board/lib/selectors.ts` (pure).
- **Format helpers** — `feedCategory` / `feedVerbLabel` / `feedChipClasses` / `feedDotClass` /
  `feedHref` / `reminderHref` / `eventHref` + the `FeedCategory` type in `board/lib/format.ts`.
- **SSR page** — `board/app/activity/page.tsx` (computes the one `now`, threads the live db slices —
  `cases` / `messages` / `reminders` / `events` / `labels` + `version` — and renders `TopBar` +
  `ActivityView`).
- **Client view** — `board/components/activity/activity-view.tsx` (derives the feed via `activityFeed`
  from the live slices, filters, day-grouping, colour rows, and mounts the three detail drawers —
  `CaseDetailDrawer` / `ReminderDrawer` / `EventDrawer` — in place, refetching the matching slice
  after a mutation).
- **Icon** — `IconActivity` (a pulse line) in `board/components/icons.tsx`; the **Activity** nav item
  in `board/components/sidebar.tsx`.
- **Redirect** — `board/app/today/page.tsx` → `redirect("/activity")`.
- **Tests** — `tests/unit/activity.test.ts` (flattening, archived inclusion, DESC sort, key
  tie-break, limit, reminder/event synthesis, non-dedupe, and the format helpers).
