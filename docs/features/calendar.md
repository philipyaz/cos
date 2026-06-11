# Calendar events — appointments on the board

The board is where work *to do* lives; the calendar is where work *falls on a day* lives. Some
matters have a moment, not just a lane: a client call at 14:00, a passport renewal due Friday, an
all-day conference. Those are not tasks in a column — they are **appointments**, and the calendar
is the board's surface for them. It is a thin, deliberately **basic** layer: a thing with a
**Title**, a **Date**, an optional **Time**, and a line of **Description**, plotted on a
month grid — that can **link to the case it belongs to** so the appointment rolls up under the
matter it serves.

The headline idea is the **link**. An event is rarely a free-floating block: a meeting is *about*
a client onboarding, a deadline is *for* an open chase. So an event can carry a `caseId` that ties
it to a `CaseRecord`, and that one field is the **single source of truth** for the case↔event
relationship — the case can show its upcoming appointments, the appointment knows which matter it
serves, and neither side keeps a second copy of the link.

The calendar is intentionally small. It is **not** a scheduling engine and it does not own
timezone math — the **day** an event falls on is the contract, and a timed event is a day plus a
`HH:MM` start. Everything else (recurrence, invites, free/busy) is out of scope by design; the
metadata stays **basic per the product ask**.

## The one decision that makes this cheap: events ride the same store

A `CalendarEvent` is a **new record type**, but it is **not** a new store, a new id ceremony, or a
new write path. Events live in **`db.events[]`** in the same JSON file as cases and messages, are
minted `EVT-<n>` the same way cases are `CASE-<n>` and messages are `M-<n>`, and are written
through the **same serialized `mutate()` chokepoint** as everything else. So the entire existing
machinery is reused **for free**:

- the store's serialized read-modify-write `mutate()` critical section (id minting + insert are
  one atomic step, so concurrent creates can't collide on an `EVT-` id),
- the monotonic **`version`** counter + the **SSE live-refresh** (an agent or another tab adding an
  event lands on the calendar without a reload),
- the timestamped **backups** and the **validate-on-read** integrity pass,
- the **actor attribution** (`human` from the UI, `agent` from MCP) that stamps the linked case's
  activity log.

There is **no `eventIds[]` array on the case.** The link is held in exactly one place —
`event.caseId` — and a case's events are *derived* by filtering `db.events` for that id. One
source of truth, no two-sided bookkeeping to drift.

## Data model

A new record type — `CalendarEvent`, defined in `board/lib/types.ts` near `MessageRecord` — and
one new optional array on the store root. No new enums: `domain` reuses `CaseDomain` /
`VALID_DOMAIN`.

```ts
export interface CalendarEvent {
  id: string;            // "EVT-<n>" minted like CASE-<n>/M-<n> ids
  title: string;         // required, non-empty
  date: string;          // ISO calendar day "YYYY-MM-DD" (the day it falls on; for a timed event, the start day)
  allDay: boolean;       // default false
  startTime?: string;    // "HH:MM" 24h, present when !allDay
  endTime?: string;      // "HH:MM" 24h, optional
  description?: string;
  location?: string;
  caseId?: string;       // OPTIONAL link to a CaseRecord — the SINGLE SOURCE OF TRUTH for the case<->event link
  domain?: CaseDomain;   // "work" | "life" — optional/advisory (may mirror the linked case domain)
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
}
```

And one new optional field on the store shape:

```ts
export interface DBShape {
  // …
  events?: CalendarEvent[];   // calendar events (v4); event.caseId is the case<->event link source of truth
}
```

### The v3 → v4 schema bump — purely additive

`SCHEMA_VERSION` goes **3 → 4**. The bump is **purely additive**: the only change is the new
optional `db.events[]`. Old v3 files still read unchanged — migrate-on-read leaves a missing
`events` as `[]`, so a board with zero appointments is exactly the board you had. A board with no
calendar events is indistinguishable from a pre-calendar board. (See [Migration](../reference/migration.md).)

## The invariants

A `CalendarEvent` is valid iff:

- **`id` matches `/^EVT-\d+$/`** and is unique across `db.events` (minted by `nextEventId`, never
  by a caller).
- **`title` is a non-empty string** (trimmed) — an appointment with no title is rejected.
- **`date` is an ISO calendar day `YYYY-MM-DD`** — the day the event falls on (the start day for a
  timed event). String shape only; calendar/timezone correctness is out of scope.
- **`allDay` defaults to `false`.** When an event is timed (`!allDay`), `startTime` is the
  `HH:MM` 24h start; `endTime` is optional and, when present, is also `HH:MM`.
- **`startTime` / `endTime` are `HH:MM` (24h)** when present — shape-validated by the same
  `/^\d{2}:\d{2}$/` guard the routes use.
- **`caseId`, when present, references an existing `CaseRecord`** — checked **inside the store
  lock** (a relational check, the cases-route precedent), so an unknown `caseId` is rejected with a
  `400`, never silently dangled. `caseId` absent === a **standalone** event.
- **`domain`, when present, is `work` | `life`** (`VALID_DOMAIN`) — optional and **advisory**, and
  may mirror the linked case's side.

### Where the invariants are enforced — two places

1. **The routes.** Both `/api/events` files share the same shape guards (`isISODate`, `isHHMM`, the
   title check, the `VALID_DOMAIN` check) — fast `400`s outside the lock for body shape — and assert
   the **relational** rule (the `caseId` references a real case) **inside `mutate()`**, before the
   write, throwing `BadRequestError → 400`. Id minting (`nextEventId`) and insert happen in that same
   critical section so concurrent creates can't mint a duplicate `EVT-` id.
2. **Lint.** `tests/board-lint.mjs` re-asserts the whole contract over the persisted store as a hard
   gate: `db.events` (when present) is an array; each event has a unique `/^EVT-\d+$/` id, a
   non-empty `title`, a parseable `YYYY-MM-DD` `date`, boolean `allDay`, `HH:MM` `startTime`/`endTime`,
   a `work|life` `domain`, and a `caseId` that references an existing case (a **dangling** caseId
   FAILs). Because `db.events` is optional, every v3 file passes unchanged.

The pure projection layer over `db.events` (`eventsByCaseId`, `eventsForDay`, `eventsByDateRange`,
`upcomingEvents`, `monthGrid`, `todayISO` in `selectors.ts`) is unit-tested deterministically in
`tests/unit/calendar.test.ts` (every time-relative helper takes a fixed `now`), and the HTTP contract
is exercised end-to-end against a running board by `tests/api-events.mjs`
(create → `EVT-<n>` + version bump, list + `from`/`to`/`caseId` filters, PATCH persist, link to a real
case so the case GET lists it, the bad-case/missing-title/bad-date/bad-`HH:MM` 400s, delete) — both
wired into [`tests/run.sh`](https://github.com/philipyaz/cos/blob/main/tests/run.sh).

## API

The calendar rides two new route files under `board/app/api/events`, mirroring the existing case-route
idioms exactly: `force-dynamic`, `resolveActor` (human default; `x-actor: agent` or
`body.actor === "agent"` ⇒ agent), `BadRequestError → 400`, `NotFoundError → 404`,
`VersionConflictError → 409`, the `{ error }` body, the `mutate()` critical section, and a `version`
on every success body.

| route | does |
|---|---|
| `GET /api/events` | Lists events; optional `?from=&to=&caseId=&domain=` filters. `from` (inclusive) / `to` (exclusive) bound a half-open day window by ISO-day string compare; `caseId` narrows to one case's events; `domain` to `work`/`life`. No filters → **all** events. Returns `{ events, version }`. |
| `POST /api/events` | Creates an event. `title` + `date` required; `allDay` defaults `false`; absent optionals are omitted from the record. A `caseId` is validated against an existing case **inside the lock**. On a linked create, the case's activity log gets an `event_linked` entry. → `{ event, version }`, `201`. |
| `GET /api/events/[id]` | Loads one event by id. Unknown id → `404`. → `{ event, version }`. |
| `PATCH /api/events/[id]` | Partial update of any field, incl. **(re)linking via `caseId`**; `caseId: null`/`""` **unlinks** (leaves it standalone). Optional `expectedVersion` optimistic guard (`≠ current → 409`). Logs `event_linked`/`event_unlinked`/`event_updated` on the affected case(s). → `{ event, version }`. |
| `DELETE /api/events/[id]` | **Hard-removes** the event (events have **no soft-archive**). If it was linked, the link is dropped and the case logs `event_unlinked`; the case itself is untouched. → `{ ok: true, version }`. |

**The case read now surfaces its events.** `GET /api/cases/[id]` returns a new `events` array
alongside `case` / `messages` / `manualActions`, computed by filtering `db.events` for
`e.caseId === id` (the link's single source of truth — there is no `eventIds[]` on the case to
read). A leaf or a container alike sees the appointments tied to it.

## The calendar MCP — the agent verbs

A new **stdio MCP server** (registry name **`calendar`**, bridge port **`8003`**) is the agent's
twin of the calendar UI. Every tool wraps the board's `/api/events` routes over `fetch` on
`CRM_BASE_URL` (default `http://localhost:3000`) — it never shells out to `curl` — so an
appointment can be driven from the sandboxed Cowork VM. Every write is attributed `actor: "agent"`
(both an `x-actor: agent` header **and** `{ actor: "agent" }` in the body), so the case audit trail
stays honest.

| verb | does |
|---|---|
| `create_event(title, date, [allDay], [startTime], [endTime], [description], [location], [caseId], [domain])` | `POST /api/events`. Mints an `EVT-` id; **prefer setting `caseId`** to roll the event up under a case. Unknown `caseId` → tool error (400). |
| `list_events([from], [to], [caseId], [domain])` | `GET /api/events`. One line per event (day · time-or-`all-day` · title · linked `caseId`), chronological. Read-only. |
| `get_event(id)` | `GET /api/events/{id}`. Renders title, date, time (or **all-day**), description, location, domain, and the linked `caseId` (or that it's standalone). |
| `update_event(id, …)` | `PATCH /api/events/{id}`. Pass only changed fields. `caseId` (re)links; **`caseId: null` unlinks**. |
| `delete_event(id)` | `DELETE /api/events/{id}`. Hard-removes the event; the linked case is untouched. |
| `link_event(id, [caseId])` | `PATCH /api/events/{id} { caseId }`. Sugar for the common roll-up: pass a `caseId` to link, `null`/empty (or omit) to unlink. |

### The house guardrail — prefer linking to a case

The calendar MCP carries a deliberate **prefer-linking** rule, baked into the `create_event` and
`link_event` tool descriptions: **before creating a standalone appointment, find the case it
belongs to.** The agent that has the calendar MCP also has the **`board`** MCP — so it should call
`search` (and `get_tree`) **first** to find a matching case by person/entity or
topic. If a strong match exists, set `caseId` so the appointment rolls up under that case and its
related data; only if nothing matches does it create the event **standalone** (omit `caseId`). This
is the calendar twin of the board's search-before-create dedupe mandate — an appointment, like a
case, should attach to the matter it serves rather than float alone.

## The UI

A new **Calendar** entry in the board's left nav (`/calendar`, beside Inbox / Today / My Issues)
opens a **month-grid** page:

- **Month grid over `db.events`.** SSR seeds the events list + the board version into local state;
  a live **SSE** subscription (`subscribeToBoard`) refetches whenever the board version advances
  past what the page last saw (mirroring board-view / inbox-view) — so an agent's MCP write or
  another tab's edit lands here **without a reload**. The grid reads pure projections
  (`monthGrid`, `eventsForDay`) from `selectors.ts`.
- **Click a day to create.** Clicking an empty part of a day cell opens the composer **prefilled to
  that day**; clicking an event chip opens the **editor** for it. A New-appointment button in the
  toolbar composes on today.
- **The event drawer + the case linker.** The drawer captures the basic metadata —
  Title / Date / all-day toggle / start+end Time / Description / location / domain — and a **case
  linker** that sets `event.caseId`. A chip is **coloured by its linked case's lane** when `caseId`
  is set, else by a neutral work/life tone keyed off the advisory `domain`.
- **One mutation path.** Every create/edit/delete routes through `board-client`
  (`createEvent` / `updateEvent` / `deleteEvent`) → the `/api/events` routes — the exact routes the
  calendar MCP calls.

## Parity rule

The calendar obeys the board's founding tenet: **every human gesture is the visual twin of an MCP
verb.** Clicking a day to compose, editing an event in the drawer, dragging the case linker to
attach an appointment, and deleting a chip all resolve to the **same `/api/events` routes** the
agent's `create_event`, `update_event`, `link_event`, and `delete_event` call. There is no
human-only or agent-only way to make, move, or link an appointment — one mutation path, two faces.
And like every board write, an event mutation flows through the single atomic, version-guarded
`mutate()` store path, with the linked case's activity log recording who did it
(`event_linked` / `event_updated` / `event_unlinked`, `human` vs `agent`).
