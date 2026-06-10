# Priorities — what matters most, right now

The board is where work *to do* lives, decomposed into cases with tasks, lanes, and a hierarchy; the
reminders surface holds the lightweight *nudges*. But neither answers the most human question of all:
**of everything on the board, what matters most right now?** A board of forty cases is not a list of
priorities — it is the raw material a priority is *chosen from*. Priorities is the board's surface for
that choice. It is deliberately small, and it works two complementary ways:

1. **Star a node — a favorite / pin.** A single toggle on **any** case, workstream, or initiative
   that marks it as one of the things you care about most. Because all three tiers
   (Initiative / Workstream / Case) are `CaseRecord`s in `db.cases` sharing **one `CASE-<n>` id
   space**, the star is one optional field (`case.starred`) that covers all three with no per-tier
   field and no separate id space — you can pin an aspiration, a thread of work, or a single leaf
   chase exactly the same way.
2. **Priority notes — your own words.** A **free-text** "what matters most right now" item you type
   into the Priorities text box: *"Close the Acme onboarding this week." "Don't let the passport
   chase slip." "Health first — book the cardiology follow-up."* These don't map onto a card and they
   don't want a status, a lane, a link, or a checklist. They are a **new, deliberately lighter-than-a-
   reminder entity** (`PriorityNote`) — the priority **in your own words**, captured as plain text and
   nothing more.

The two together answer the question from both ends: stars point *at* the work the board already
holds; notes capture the intent that isn't a card yet. And both exist for a second reason beyond your
own glance — they are **what the agent reads to align its work**. Before it triages, sweeps mail, or
picks the next chase to push, the chief-of-staff agent can ask the board *"what does the user care
about most?"* and get back the starred nodes **and** the priority notes — so its attention tracks
yours instead of drifting across the whole board uniformly.

## The one decision that makes this cheap: priorities ride the same store

A `PriorityNote` is a **new record type**, but — exactly like reminders, and unlike the calendar — it
is **not** a new store, a new id ceremony, a new write path, and **not even a new MCP server**.
Priority notes live in **`db.priorities[]`** in the same JSON file as cases, messages, events, and
reminders, are minted `PRI-<n>` the same way cases are `CASE-<n>`, events are `EVT-<n>`, reminders are
`REM-<n>`, and messages are `M-<n>`, and are written through the **same serialized `mutate()`
chokepoint** as everything else. The **star** is even cheaper: it's just one optional boolean on the
`CaseRecord` you already have, set through the **existing** `update_case` / `PATCH /api/cases/[id]`
path — no new entity at all. So the entire existing machinery is reused **for free**:

- the store's serialized read-modify-write `mutate()` critical section (id minting + insert are
  one atomic step, so concurrent creates can't collide on a `PRI-` id),
- the monotonic **`version`** counter + the **SSE live-refresh** (an agent or another tab adding a
  priority note, or starring a case, lands on the Priorities surface without a reload),
- the timestamped **backups** and the **validate-on-read** integrity pass,
- and — for a star, which is a case write — the **actor attribution** (`human` from the UI, `agent`
  from MCP) that stamps the node's activity log, so star / unstar is auditable like any case edit.

There is no separate id space and no two-sided bookkeeping. The star is held in exactly one place —
`case.starred` — and the starred set is *derived* by filtering `db.cases` for it (`starredCases`). A
priority note holds nothing but its own text and rank; it links to nothing, so there is no link to
keep in sync and no link to clean up when it's deleted.

## Data model

A new record type — `PriorityNote`, defined in `board/lib/types.ts` near the reminder types — plus one
new optional flag on `CaseRecord` and one new optional array on the store root. **No new enums:** a
priority note has no enum fields, and `starred` is a boolean.

```ts
export interface PriorityNote {
  id: string;        // "PRI-<n>" minted like CASE-<n>/REM-<n>/EVT-<n> ids
  text: string;      // required, non-empty — the priority in the user's OWN words
  position?: number; // manual rank within the list (smaller = higher priority); absent sorts last
  createdAt: string;
  updatedAt: string;
}
```

A `PriorityNote` is **deliberately lighter than a Case or a Reminder**. A reminder is a *nudge* —
a title, a status, an optional due signal, an optional node link, and (v6) labels / a small checklist /
linked mail. A priority note throws all of that away and keeps only the one thing that matters: the
priority, **in your own words**, as free text. It has **no** status (it isn't done / open /
dismissed — it's just *true right now* until you delete it), **no** link to a node (it's an intent,
not a card), **no** tasks, **no** labels, **no** activity log. The only structure beyond `text` is an
optional `position` for manual rank. Agents **read** these (`get_priorities`) to align their work to
what you care about; they rarely need to write them.

The star is one optional field on the case record, sitting beside `priority` / `position`:

```ts
export interface CaseRecord {
  // …
  starred?: boolean;     // user-curated favorite / pin (the star). Absent === not starred. Additive optional (read-compatible like MessageRecord.outbound).
}
```

And one new optional array on the store shape:

```ts
export interface DBShape {
  // …
  priorities?: PriorityNote[];   // free-text priority notes (v7); see PriorityNote
}
```

### The v6 → v7 schema bump — purely additive

`SCHEMA_VERSION` goes **6 → 7**. The bump is **purely additive**: it adds `db.priorities`
(`PriorityNote`) **and** `CaseRecord.starred` (a user-curated favorite flag). Old v6 files read
unchanged — `priorities` defaults to `[]`, and an absent `starred` is exactly the case you had (a
board with no priorities and nothing starred is indistinguishable from a pre-priorities board).
**No new enums** — `starred` is a boolean and `PriorityNote` has no enum fields. (See
[Migration](../reference/migration.md).)

## The invariants

A `PriorityNote` is valid iff:

- **`id` matches `/^PRI-\d+$/`** and is unique across `db.priorities` (minted by `nextPriorityId`,
  never by a caller).
- **`text` is a non-empty string** (trimmed) — a priority with no words is rejected. Empty or
  whitespace-only text is ignored on update (the existing text is kept), mirroring the
  never-undo-the-user's-edit tenet.
- **`position`, when present, is a number** (smaller = higher priority); absent sorts last. It carries
  manual rank for agents / a future reorder gesture; v1 of the UI does not expose dragging.

A `CaseRecord.starred` is a boolean: `true` when starred, **absent** when not (stored `true`, cleared
to `undefined` so unstarred cases stay byte-clean — the `archivedAt` / `kind` clear-to-undefined
idiom). It rides through `migrateCase` on the case spread, so old files carry it forward with no code.

### Where the invariants are enforced

**The routes.** The two `/api/priorities` files share the same shape guards (`text` is a non-empty
string; `position`, when present, is a number) — fast `400`s — and run every write inside the
serialized `mutate()` critical section, throwing `BadRequestError → 400`, `NotFoundError → 404`, and
`VersionConflictError → 409` exactly like the reminders routes. Id minting (`nextPriorityId`) and
insert happen in that same critical section so concurrent creates can't mint a duplicate `PRI-` id.
The text-trim / position coercion lands at the un-validating store chokepoint `applyPriorityUpdate`
(mirroring `applyReminderUpdate` / `applyEventUpdate`): empty / missing text is ignored, a non-number
`position` clears to absent. A priority note has **no** links, so `removePriority` simply splices it
out — there is nothing to unlink. Star writes need **no** new route: `PATCH /api/cases/[id]` already
passes its whole body to `applyCaseUpdate`, which now handles `starred` (store `true`, clear to
`undefined`) and logs the change via `describeCaseChange` so the node's activity records the star.

The pure projection layer lives in `selectors.ts` and is shared by both the GET route and the UI so
their order always agrees: `sortPriorityNotes` (by `position ?? Infinity` ascending, tiebreak
`createdAt` ascending) orders the notes, and `starredCases` returns the non-archived starred nodes
(`c.starred && !c.archivedAt`) sorted by tier rank (initiative → workstream → case) then most-recently-
touched first. Both are deterministic, with no I/O.

## API

Priorities ride two new route files under `board/app/api/priorities`, mirroring the existing
reminders-route idioms — but **simpler**: a priority note has no `caseId`, no labels, no tasks, no
domain, and no case-audit, so the routes carry none of that.

| route | does |
|---|---|
| `GET /api/priorities` | Returns **everything the surface (and the agent) needs in one call**: `{ priorities, starred, version }` — `priorities` is `sortPriorityNotes(db.priorities)` and `starred` is `starredCases(db.cases)` (the non-archived starred nodes). No filters. |
| `POST /api/priorities` | Creates a priority note. `text` required (non-empty string, else `400 "Field 'text' is required."`); `position` optional (a number, else `400`). Inside the lock: mints `nextPriorityId`, builds `{ id, text: text.trim(), position?, createdAt, updatedAt }`, pushes to `db.priorities`. → `{ priority, version }`, `201`. |
| `PATCH /api/priorities/[id]` | Partial update. If `text` is present it must be a non-empty string (`400`); if `position` is present and non-null it must be a number (`400`). Optional `expectedVersion` optimistic guard (`≠ current → 409`). Inside the lock: `findPriority` (`404` if unknown), then `applyPriorityUpdate(rec, body)`. → `{ priority, version }`. |
| `DELETE /api/priorities/[id]` | **Hard-removes** the note (priority notes have no status / soft-archive — to drop a priority you delete it). `404` on an unknown id. → `{ ok: true, version }`. |

**Starring needs no route change.** `{ starred: true }` / `{ starred: false }` to the existing
`PATCH /api/cases/[id]` "just works" — that route already forwards its whole body to
`applyCaseUpdate`, which now coerces `starred`. The starred set then shows up in the next
`GET /api/priorities` response.

## The priority tools — on the board MCP

Priorities get **five** agent verbs — `get_priorities`, `add_priority`, `update_priority`,
`remove_priority`, and `set_starred` — but, exactly like the reminder tools and unlike the calendar,
they live on the **existing `board` MCP server**, *not* on a new one. A priority note is a
**board-native sub-resource** (it lives in the board's own store), and the star is a field on the
board's own `CaseRecord` — so there is **no new server, no new bridge port, and no `.mcp.json`
change**. The agent that already drives the board gains the priority verbs in the same toolset.

Every tool wraps the board's `/api/priorities` routes (and, for the star, `/api/cases/[id]`) over the
same HTTP path the board verbs use; the star write is attributed `actor: "agent"` so the node's audit
trail stays honest.

| verb | does |
|---|---|
| `get_priorities()` | `GET /api/priorities`. **Read-only — the headline verb.** Returns **what the user cares about most**: their starred cases / workstreams / initiatives **plus** their free-text priority notes (the user's own words), so the agent can **align its work and triage to the user's priorities**. Renders the starred nodes (one line each: id · `[tier]` · title · `[lane]`) then the priority notes (one line each: `PRI-id — text`), and says so if both are empty — ending with a hint that these are the user's stated priorities to align to. |
| `add_priority(text, [position])` | `POST /api/priorities`. Creates a free-text priority note — `text` is the priority in plain words; `position` is the optional manual rank. Returns the minted `PRI-` id. |
| `update_priority(id, [text], [position])` | `PATCH /api/priorities/{id}`. Edit a note's `text` and/or `position`. Nothing to update → a tool error. |
| `remove_priority(id)` | `DELETE /api/priorities/{id}`. Hard-removes the note. |
| `set_starred(id, starred)` | `PATCH /api/cases/{id} { starred }`. Star / unstar **any** node (`"CASE-1"`, a workstream, or an initiative). This is the **user-facing favorite / pin**: starred nodes surface in `get_priorities` and on the Priorities page. Confirms `Starred CASE-x` / `Unstarred CASE-x`. |

## The UI

A new **Priorities** entry in the board's left nav (`/priorities`, placed immediately after **My
Issues**) opens the **priorities surface**, which has two sections:

- **Starred — your favorites.** The starred cases / workstreams / initiatives (`starredCases` order:
  tier rank, then most-recently-touched first). Each row shows a **filled amber star** button to
  *unstar* it (optimistically), a tier badge (Initiative / Workstream / Case), the title, and the
  lane. Clicking a row **opens that node's case-detail drawer in place** — the same open-a-case
  mechanism the rest of the app uses (the way the Activity feed opens case / reminder drawers over the
  feed), so you never lose the Priorities page. Empty state: *"Star a case, workstream, or initiative
  to pin it here."*
- **Your priorities — your own words.** A **text box** to add a free-text priority note (Enter or an
  Add button → `createPriority`, optimistic), then the list of existing notes (in `sortPriorityNotes`
  order), each with **inline edit** (`updatePriority` the text) and a delete (the trash icon →
  `deletePriority`, optimistic). New notes append after the current max `position` so order stays
  stable; manual reorder is out of scope for v1 (the `position` field lives in the model for agents
  and a future drag gesture). Empty state: a prompt to type your top priorities.

SSR seeds the priorities + the starred set + the board version into local state; a live **SSE**
subscription refetches (`fetchPriorities`) whenever the board version advances past what the page last
saw (mirroring board-view / reminders-view / calendar-view) — so an agent's MCP write or another tab's
edit lands here **without a reload**. Every mutation is optimistic with **revert-on-error**, and no
view state is persisted to `prefs.json`.

**Star toggles on the existing surfaces — the star is everywhere the node is.** Because the star is
just a field on the case, you can set it wherever a node already appears, not only on the Priorities
page:

- **The case-detail drawer** gains a star toggle in its header (filled amber when starred, outline
  otherwise) → `starCase(c.id, !c.starred)`, using the drawer's own optimistic / refresh idiom.
- **The board cards** (and the strategy-tree rows) gain a small, unobtrusive top-corner star
  affordance — filled amber when starred, outline otherwise — that toggles `starCase` **without**
  opening the card (`stopPropagation`).

## Parity rule

Priorities obey the board's founding tenet: **every human gesture is the visual twin of an MCP
verb.** Typing a priority into the text box, editing or deleting a note, and toggling a star on the
Priorities page, a card, or the drawer all resolve to the **same** routes the agent calls —
`createPriority` / `updatePriority` / `deletePriority` → `/api/priorities` (the `add_priority` /
`update_priority` / `remove_priority` tools), and `starCase` → `PATCH /api/cases/[id] { starred }`
(the `set_starred` tool). There is no human-only or agent-only way to set a priority or pin a node —
one mutation path, two faces. And like every board write, a priority mutation flows through the single
atomic, version-guarded `mutate()` store path; a star, being a case write, also records who did it in
the node's activity log (`human` vs `agent`).
