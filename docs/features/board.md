# Cos Board — Feature Spec

The Cos Board is the action surface of a local-first, agent-native personal operations system for a single power user. This spec turns it from a read-only kanban into a board that both the human and an AI chief-of-staff drive through one shared mutation path. The aim: every gesture a human makes on the board is the visual twin of an MCP tool the agent already calls.

> _Note (2026-05-31): Living spec. Priorities and sizing are estimates for a single-user, local-only build; phasing is the recommended build order, not a contract._

## Where the board is today

- **Read-only SSR display.** The kanban renders from `force-dynamic` server reads of `board/data/cases.json`. No drag-drop, no inline editing, the top **Filter** button is dead, and per-column **+** / **...** buttons do nothing.
- **All mutations flow through the "board" MCP server** (`create_case`, `get_case`, `update_case`, `add_task`, `update_task`, `complete_task`, `link_message`), mirrored by Next API routes under `board/app/api/cases/...`.
- **Three views:** "My Issues" (the kanban, default), "Inbox" (messages + linked-case panel), "Manual" (empty placeholder).
- **Five lanes** (`urgent` / `todo` / `in_progress` / `waiting_for_input` / `done`). A domain filter (All/Work/Life) exists.
- **No removal or triage path.** Cases and tasks can be created and edited but never deleted or archived (no `DELETE` route, no `archived` state); the Inbox read/unread flag and the sidebar unread badge are inert (hardcoded `4`). Every existing MCP verb is additive or a field-patch — **none destructive**.
- **Agent-driven changes are invisible** until a manual reload, breaking the "agent drives the board while you watch" differentiator.

## Design tenets

Any feature must respect these:

- **Local-first.** Files on disk (JSON store + Obsidian vault). No cloud DB, no auth system, no realtime/websocket server, single user.
- **One ingest path.** Everything inbound flows through `/second-brain-ingest`; classify → route → entity-resolve → dedupe → cross-link → watermark.
- **Agent-native parity.** Every human gesture maps 1:1 to an existing board MCP verb. Human and agent mutate through one identical path; no human-only or agent-only mutation surfaces.
- **Two surfaces, cross-linked bidirectionally.** Board cases ↔ vault entity pages, both directions.
- **Deduplicate aggressively, entity-resolved.** Same input twice → one canonical record.
- **Idempotent + watermarked.** Re-running a channel pull or a nudge never double-writes.
- **Fail safe over fail silent.** A bad write or hand-edit must not dark the board mid-chase.

## Feature areas

### Board interaction & editing

The read-only board becomes writable; every control is the human face of an existing MCP verb.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Optimistic updates + undo | Client-side pending-mutation layer; toast/Cmd+Z replays inverse op | Edits feel instant on a no-realtime board; mistakes are one keystroke to revert | None (inverse from pre-edit snapshot) | P0 | M |
| Drag-drop lane moves | Drag a card between lanes → `Case.status` | The document-chase IS yanking a card from `waiting_for_input` to `done`; maps to `update_case({id,status})` | None | P0 | M |
| Inline field editing | Click-to-edit title, eta | Retitle / fix a fat-fingered field without an MCP round-trip; each edit a scoped `update_case` | None (whitelist editable fields) | P0 | M |
| ~~Quick-add card~~ **(removed — agent-native)** | Every manual blank-case spawn is gone: the sidebar **+ New Case**, the toolbar **New ▾** menu, and the per-lane **+**. Cases now arrive from the agent, inbox **message→case** triage, or the command palette — not a manual composer | Less clutter + `cases.json` bloat; the board commits to agent-created cases (the `create_case` route stays for the agent + triage flows) | Dropped `quickAdd` / New-menu / per-column composer; the `POST /api/cases` route is unchanged | ✅ | S |
| Full card composer + task editor | Card-detail panel: summary, tags, vaultLinks, domain + add/rename/advance/complete tasks | The onboarding seed ("one task per document") and the done/total chase live here | None (existing arrays); vault-title link picker | P0 | L |
| Keyboard shortcuts | Vim-ish single-key ops on focused card (lane jumps, e/a/x/c/n) | Hands-on-keyboard daily triage; alternate triggers for existing handlers | None (card focus state) | P1 | S |
| **(merged) Command palette (Cmd+K)** | One palette = jump-to-case + spotlight search + NL board commands + verb dispatch | Human gets the same verb-first interface the agent uses; see Search area | None | P2 | M |
| Bulk select + bulk actions | Multi-select → bulk move/tag/assign/archive via new `update_cases({ids,patch})` | Sweep a clump after a busy day | New batch MCP tool/route | P1 | M |
| Archive / delete a case | Card/drawer action → **soft-archive** (recoverable, hidden by default) with a hard-delete escape hatch; bulk-archivable | A two-writer store that dedupes aggressively needs a removal path for mis-created, duplicate, or stale-and-closed cards — soft-first so neither you nor the agent can dark real work | `archivedAt` field + default filter; new `archive_case`/`delete_case` + `DELETE /api/cases/[id]` | P0 | S |
| Delete a task | Row hover → remove; counter rollup reverts | Tasks added in error or by an over-eager template seed need pruning without hand-editing JSON | `delete_task` + `DELETE …/tasks/[taskId]` | P0 | S |
| Clean Done lane (purge) | **Clean** action on the Done column header → PERMANENTLY deletes the done cases **in view** *and their linked emails* (an email also linked to a reminder is kept + unlinked); confirm dialog, no in-app undo (a disk backup is kept) | The storage-reclaiming counterpart to archive — archive only *hides*, it never shrinks the store, so finished work + its piled-up mail would bloat `cases.json` forever | `cleanCases` store fn + `POST /api/cases/clean` (done-only guard); deliberately **UI-only** | P1 | S |
| Reorder within a lane | Drag a card up/down inside its column; reorder tasks within a case | Manual "do this next" order inside a lane — distinct from sort, set by hand | Additive `position` on Case/Task; extends the drag handler | P1 | S |
| Inbox triage & message→case | Mark read/unread (revives the inert dot + a real sidebar unread count); turn a message into a new case or link it to an existing one | The hand-operated twin of the ingest router, from the Inbox surface that already exists — the human face of `link_message` | `update_message` + `PATCH /api/messages/[id]`; reuses `create_case` + `link_message` | P1 | M |

### Views & layouts

The single kanban becomes the operational lenses an operator thinks in. Most are pure read projections over the loaded cases.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Activity feed (UI) | **Activity** nav → one reverse-chronological audit trail across the whole board: every `case.activity[]` entry plus synthesized reminder/event lifecycle rows, colour-coded by category, filterable by actor (Human · Agent) and category, grouped by day, each row deep-linking back into its surface; read-only, SSR snapshot with a fixed request-time clock | One place to see *everything that happened* — the trust ledger made browsable; replaces the **Today** nav slot (`/today` now redirects to `/activity`) | `activity-view.tsx` + pure `activityFeed` selector + `feedCategory`/`feedVerbLabel`/`feedHref` format helpers; see [Activity](activity.md) | P0 | M |
| Today / Focus view | Computed worklist: urgent + own open tasks + overdue, excluding `waiting_for_input` | The daily "what must I personally touch now" across three lives (the underlying `todayCases` selector; the `/today` route now redirects to the Activity surface) | None (selector); reads `dueAt` | P0 | M |
| Swimlanes | Status columns split into rows by domain/tag | One screen showing the pipeline per-domain | None (group-by transform) | P0 | M |
| Per-entity view | Filter cases by `vaultLinks` membership | The whole relationship before a call | None | P0 | M |
| List / table view | Dense sortable register (id, status, done/total, eta, updatedAt) | Scanning 40 cases, finding stale onboardings | None | P1 | S |
| Calendar view | Month/week plot keyed on the normalized `dueAt` | Deadline pileups visible; consumer of the one due-date field | None new (reuses `dueAt`) | P1 | L |
| **(merged) Saved views / quick-filter chips** | Named lenses (viewType + group + filter + sort) as sidebar entries / chips | Recurring stances ("Client book", "Life admin") in one click | **One** `views.json` + `list_views`/`save_view` | P1 | M |
| Timeline / Gantt | Bars from `createdAt`→`dueAt`; task milestones | Duration at a glance | None (reuses `dueAt`) | P2 | L |

### Search, filter, sort & navigation

The five split filter/search cards collapse into **one predicate + sort + group engine** over the SSR cases array, URL-encoded.

> **Semantic search ✅ shipped.** `GET·POST /api/search` + the read-only `search` MCP tool search
> across cases/tasks/messages **and reminders** (incl. `done` ones — reminders have no archive),
> with **semantic ranking via an optional `uv`-run Python sidecar** (`:8008`, model2vec + turbovec)
> and an **absent-safe keyword fallback** — search never darks the board even with no sidecar and no
> `uv`. Each hit flags **its nature** (`type`: case / task / message / reminder). Design:
> [Search](../reference/search.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| **(merged) Filter+sort+group engine** | Revives dead Filter button: AND predicates (status/domain/tag/age) + sort (age/title/done-ratio) + group-by; renders as swimlanes/table | Isolate "work + tag=onboarding + waiting" in two clicks; one engine, not five components | None (projection); structured `filter` arg shape | P0 | M |
| **✅ Global Spotlight Search (Cmd+K)** | Fuzzy across Case/Task/Message **and Reminder** fields; grouped, jump-able, each hit flagging its nature — now **semantically ranked** by an optional local embedding sidecar, keyword fallback when it's down | Recall by fragment ("the passport doc") across all four streams | Read-only `search` MCP tool + `GET·POST /api/search` (additive `reminders` bucket); optional `:8008` sidecar. Design: [Search](../reference/search.md) | P0 | M |
| Deep-linkable URL state | Encode filter/sort/group/search/`?case=` into searchParams | Any board slice is bookmarkable + agent-returnable | None (state in URL) | P0 | S |
| Cross-surface facets | Filter by linked vault entity, message source, has-unread, untracked (no vaultLinks) | The two-surface differentiator + a hygiene/audit lens | None (joins Inbox dataset) | P2 | M |
| Jump-to-case (in palette) | Type-to-jump by id/title → `?case=CASE-n` | Land on a known case without hunting the lanes; merged into Cmd+K | None (uses `get_case`) | P1 | S |

> **Inbox mail search & filters ✅ shipped.** The Inbox surface gained a full basic-mail
> toolbar: a **semantic search bar scoped to messages** (the same fail-safe `POST /api/search`
> the palette uses — semantic ranking via the `:8008` sidecar, transparent keyword fallback, with
> an inline "Semantic"/"Keyword" badge), an **unread/read/all** segmented filter, a **Newest↔Oldest**
> date sort (inert under an active search, since relevance wins), and **From / To / Cc** participant
> substring filters with an active-count badge. All filtering/sorting precedence lives in one pure,
> unit-tested selector, [`board/lib/inbox.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/inbox.ts) (`selectInboxMessages`), so the
> view stays a thin renderer.

> **Open-in-Gmail deep-link ✅ shipped.** A linked message now carries an optional
> `url` (`MessageRecord.url`, schema **v8**): the direct deep-link back to the **original**
> email — for Gmail the thread URL (`https://mail.google.com/mail/u/0/#all/<threadId>`),
> captured at link time. It's surfaced as an **"Open in Gmail"** affordance (the
> `IconExternalLink` / `MessageLink` pair) wherever a message renders, and is settable via
> `link_message` (`POST /api/cases/[id]/messages`) and `update_message`
> (`PATCH /api/messages/[id]`). A single pure server-side gate,
> [`board/lib/message-url.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/message-url.ts) (`normalizeMessageUrl`), admits
> ONLY an absolute http(s) URL (relative / `javascript:` / `data:` / `mailto:` → dropped),
> so the stored value is always safe to render as an `<a href>`. Purely additive
> (read-compatible like `outbound`/`reminderId`; `migrate()` is a no-op for it).

### Labels & configurable taxonomy ✅ shipped

A catalog-backed categorization layer richer than freeform `tags`: each **label** is a
`{ id, title, description, color }` where the *description states when it applies* (so agents
pick correctly). Labels group into installable **bundles** — per role (manager, sales, IT,
developer-tooling, …), per life area (health, travel, finance, …), and a **universal**
cross-cutting set — so each person personalizes their depth of categorization. Full taxonomy +
design in [Labels](../reference/labels.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Label catalog | `db.labels: LabelDef[]` (versioned, backed-up, lint-checked); `Case.labels: string[]` ids | The configurable taxonomy that cuts noise into focus, per role + life | Additive optional fields; migrate-on-read | P0 | M |
| Installable bundles | 37 built-in packs (role/life/universal) in `label-bundles.ts`; one-click install unions into the catalog (idempotent) and **uninstall** removes the labels a bundle owns (provenance-based; optional scrub off cases) | Personalize without admin: pick the packs that fit you, drop the ones you don't | Static content; `GET/POST /api/labels/bundles`, `DELETE /api/labels/bundles/:id` | P0 | M |
| Label API + agent contract | `GET /api/labels` (+ `list_labels` MCP); case writes **reject unknown ids** with the valid set | Skills fetch the catalog then assign valid ids — categorization never silently fails | Validation inside the store lock (`BadRequestError`→400) | P0 | M |
| Labels manager (UI) | Install bundles, add custom labels, edit title/description/colour, delete (scrub) — all in-board | "Easily done via the kanban UI" — no config files | Slide-over over the label API | P0 | M |
| Filter + group by label | A category-scoped, searchable **Labels dropdown** with collapsible bundle groups + **tri-state select-all** (filter by a whole bundle or a scope of several in one click) drives an OR facet; active selection shows as removable chips; group-by Label; click a card chip to filter | All filters in the main UI, scalable to a large catalog | `BoardQuery.labels[]`; pure selectors; `label-filter.tsx` | P0 | S |

### Initiatives & Workstreams (hierarchy) ✅ shipped

A three-tier tree on top of the flat board: **Initiative** (an Epic) > **Workstream** (a
Sub-Epic) > **Case** (the leaf Issue you already have). The load-bearing decision: **all three
tiers are `CaseRecord`s in `db.cases`, one `CASE-<n>` id space** — a `kind` discriminator (+
`parentId`) on the record we already have, so the *entire* existing lifecycle (mutate path,
activity log, notes, labels, vaultLinks, messages, search, archive, merge) is reused at every
tier. The board gains a **Strategy** outline view (rollup roadmap) toggled against the
**Operational** leaves-only kanban. Full design: [Hierarchy](../architecture/hierarchy.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Three-tier model | `CaseKind` (`initiative`/`workstream`/`case`) + `parentId` on `CaseRecord`; `kind` absent === leaf | Big aspirations decompose into threads of work without leaving the kanban | Two additive optional fields; migrate-on-read; `SCHEMA_VERSION` stays 3 | P0 | M |
| Strict tree invariants | Max-depth-3 tree: initiative=root, workstream→initiative, case→container; no cycles, container parents only; `hierarchyViolation()` is the single source of truth | A clean tree the agent and human can both reason about; illegal moves rejected, not silently allowed | `assertHierarchy` in store (`BadRequestError`→400), re-asserted in lint, UI offers only legal targets | P0 | M |
| Rollup progress | `Rollup` over non-archived descendant leaves: `doneCases/totalCases` + task sums + child count; pure `rollupFor`/`buildForest` selectors | A container shows its real progress; one rollup definition shared by API tree, strategy view, drawer | None new (pure read projection) | P0 | S |
| Cascade integrity | A removed container is soft-archived to Trash (not destroyed); its children keep their `parentId` and the hierarchy selectors still surface an out-of-list (archived) parent, while `regroup_cases`/`set_parent` re-home leaves under the tree invariants | Nothing is silently destroyed or left dangling at a removed parent | Soft-delete + retention sweep; selectors tolerate an archived parent | P0 | S |
| `GET /api/tree` + regroup | New read endpoint returns the forest; batch `regroup_cases(ids, parentId)` groups many leaves at once | The strategy roadmap + the "group these under an Initiative" verb | `buildForest` over the loaded cases; batch PATCH accepts `parentId` | P0 | M |
| Strategy / Operational views | Segmented toggle (persisted via `BoardPrefs.view`); operational kanban filters to leaves with a lineage breadcrumb chip; strategy is a collapsible Initiative>Workstream>Case outline with rollup bars | The same cases seen as a daily worklist or a roadmap; one click between them | `view` pref; pure forest selectors; `strategy-view.tsx` | P0 | M |

### Calendar events ✅ shipped

A calendar surface on the board for **appointments** — the matters that fall on a *day*, not just
in a lane: a client call at 14:00, a passport deadline on Friday, an all-day conference. It is
deliberately **basic** (Title / Date / Time / Description + optional location, domain), plotted on a
**month grid** reached from a **Calendar** nav entry. The headline idea is the **link**: an event
can carry a `caseId` tying it to a `CaseRecord` — that one field is the **single source of truth**
for the case↔event link (no `eventIds[]` on the case; a case's events are derived by filtering), so
an appointment rolls up under the matter it serves. Events are a new `CalendarEvent` record in
**`db.events[]`** but ride the *same* store: one `mutate()` chokepoint, `EVT-<n>` ids minted like
`CASE-<n>`, the SSE live-refresh, backups, and `human`/`agent` activity attribution. The agent gets
a matching **`calendar`** MCP server (port 8003) whose verbs wrap the same `/api/events` routes, with
a prefer-linking-to-a-case guardrail. Full design: [Calendar](calendar.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| CalendarEvent model | New `CalendarEvent` record in `db.events[]` (`id`/`title`/`date`/`allDay`/`startTime`/`endTime`/`description`/`location`/`caseId`/`domain`); `EVT-<n>` ids minted like `CASE-<n>` | Appointments — a day (and optional time), not a lane — get a home that isn't a task | Additive `db.events?`; `SCHEMA_VERSION` 3→4, purely additive (old files read, `events` defaults to `[]`); no new enums (`domain` reuses `CaseDomain`) | P0 | M |
| Case↔event link | Optional `event.caseId` references an existing case — the single source of truth for the link; `GET /api/cases/[id]` now returns the case's linked `events` | An appointment rolls up under the matter it serves; the case shows its upcoming events without a second-sided array | Relational check inside the store lock (`BadRequestError`→400 on unknown `caseId`); derived `events` on the case read | P0 | S |
| Events API | `GET·POST /api/events` (+ `?from=&to=&caseId=&domain=` filters) and `GET·PATCH·DELETE /api/events/[id]`; `caseId:null` unlinks; events hard-delete (no soft-archive) | One mutation path for appointments, mirroring the case routes exactly | New routes under `board/app/api/events`; same `resolveActor` / `mutate()` / version-guard idioms | P0 | M |
| Calendar MCP | `calendar` stdio server (port 8003): `create_event`/`list_events`/`get_event`/`update_event`/`delete_event`/`link_event` over `/api/events`, all `actor:"agent"`, with a **prefer-linking-to-a-case** guardrail (search the board first) | The agent twin of the calendar UI — drive an appointment from the sandboxed Cowork VM, attached to the right case | Wraps the HTTP routes over `fetch` on `CRM_BASE_URL`; logs `event_linked`/`event_unlinked` on the case | P0 | M |
| Calendar surface (UI) | **Calendar** nav → month grid over `db.events`; click a day to create, click a chip to edit; event drawer with the case linker; chips tinted by the linked case's lane; live via SSE | The same appointment seen as a human gesture or an MCP verb — one mutation path through `board-client` → `/api/events` | `calendar-view.tsx` + `event-drawer.tsx`; pure `monthGrid`/`eventsForDay` selectors | P0 | M |

### Reminders ✅ shipped

A **Reminders** surface on the board for the matters that are really just a **nudge** — *a reminder
to CHECK or to DO something*: "Check the trip dates against the conference dates",
"confirm the passport arrived", "ping the lawyer if no reply by Friday". A reminder is **first-class
but deliberately lighter than a case** — no kanban lanes, no hierarchy of its own, no activity log —
with a **Title**, optional **detail**, an optional **due date**, and a **status** (`open` / `done` /
`dismissed`). **The v6 enrichment** lets a reminder hold just a little more so minor matters don't
leak into cases: **catalog labels** (the same `db.labels` taxonomy a case uses), a **short tasks
checklist** (`ReminderTask` rows — concise, not full Tasks), and **linked emails** (many emails about
one matter point at one reminder via `message.reminderId`). The headline idea, as with events, is the
**link**: a reminder can carry a `caseId` tying it to **any** board node (Initiative / Workstream /
Case — all one `CASE-<n>` id space) — that one field is the **single source of truth** for the
node↔reminder link (no `reminderIds[]` on the case; a node's reminders are derived by filtering), so a
nudge rolls up under the matter it serves and the node lists it back; `message.reminderId` is the
inverse-twin source of truth for the reminder↔email link (no `messageIds[]` on the reminder).
Reminders are a `Reminder` record in **`db.reminders[]`** but ride the *same* store: one `mutate()`
chokepoint, `REM-<n>` ids minted like `CASE-<n>`, the SSE live-refresh, backups, and `human`/`agent`
activity attribution. Unlike the calendar, reminders get **no new MCP server** — their eight verbs
ride the existing **`board`** MCP (board-native sub-resource, no new bridge port), with the same
prefer-linking-to-a-node guardrail. The schema bumps **v4 → v5** (the array) then **v5 → v6** (the
enrichment) — both purely additive; old files read, new fields default empty. Full design:
[Reminders](reminders.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Reminder model | `Reminder` record in `db.reminders[]` (`id`/`title`/`detail`/`status`/`caseId`/`dueAt`/`domain`/`createdAt`/`updatedAt`/`completedAt`); `REM-<n>` ids minted like `CASE-<n>` | Some cases are really just a lightweight nudge to CHECK/DO something — a home that isn't a task or a full case | Additive `db.reminders?`; `SCHEMA_VERSION` 4→5, purely additive (old files read, `reminders` defaults to `[]`); one new enum `ReminderStatus` (`domain` reuses `CaseDomain`) | P0 | S |
| Reminder enrichment (v6) | Optional `Reminder.labels` (catalog `db.labels` ids, validated like a case's), `Reminder.tasks` (`ReminderTask` `id`/`title`/`done` checklist, store-minted `REM-<n>-T<k>` ids), and `MessageRecord.reminderId` (the reminder↔email link — many emails on one matter → one reminder) | Minor notices/checks (e.g. a billing thread) land as a well-formed *reminder* instead of bloating into a case | `SCHEMA_VERSION` 5→6, purely additive (no structural change; old files read); **no new enums** (`labels` validated via `assertKnownLabels`); `removeReminder` unlinks its emails on delete | P0 | S |
| Node↔reminder link | Optional `reminder.caseId` references an existing node of **any** tier — the single source of truth for the link; `GET /api/cases/[id]` now returns the node's linked `reminders` | A nudge rolls up under the matter it concerns; the node shows its reminders without a second-sided array | Relational check inside the store lock (`BadRequestError`→400 on unknown `caseId`); derived `reminders` on the case read | P0 | S |
| Reminders API | `GET·POST /api/reminders` (+ `?status=&caseId=&domain=` filters) and `GET·PATCH·DELETE /api/reminders/[id]`; `caseId:null` unlinks; `status:done` stamps `completedAt`; reminders hard-delete (no soft-archive). (v6) POST/PATCH accept `labels`+`tasks`; `GET /[id]` returns the linked `messages`; new `POST /api/reminders/[id]/messages` links an email; `PATCH /api/messages/[id]` accepts `reminderId` | One mutation path for nudges, mirroring the case/event routes exactly | New routes under `board/app/api/reminders` (incl. `[id]/messages`); same `resolveActor` / `mutate()` / version-guard idioms | P0 | M |
| Reminder tools (board MCP) | 8 verbs on the **existing** `board` server: `create_reminder`/`list_reminders`/`get_reminder`/`update_reminder`/`complete_reminder`/`delete_reminder`/`link_reminder` + (v6) `link_reminder_message` over `/api/reminders`, all `actor:"agent"`, with a **prefer-linking-to-a-node** guardrail (`search` + `get_tree` first). (v6) create/update take `labels`+`tasks`; `get_reminder` renders labels/tasks/messages | The agent twin of the reminders UI — and a board-native sub-resource, so **no new server/port/bridge** unlike the calendar | Wraps the HTTP routes; logs `reminder_linked`/`reminder_unlinked`/`reminder_completed` on the node; MCP server v3.2.0 | P0 | S |
| Reminders surface (UI) | **Reminders** nav → list grouped by due bucket (Overdue · Today · Soon · Later · No date); reminder drawer with a **node linker** (link to any tier), (v6) a labels picker, a tasks checklist editor, and a read-only linked-emails list; a Reminders section on the case-detail drawer for the reverse link (with label chips + task-progress); live via SSE | The same nudge seen as a human gesture or an MCP verb — one mutation path through `board-client` → `/api/reminders` | `reminders-view.tsx` + `reminder-drawer.tsx`; pure `sortReminders`/`upcomingReminders`/`remindersByCaseId`/`messagesByReminderId` selectors | P0 | M |

### Priorities ✅ shipped

A **Priorities** surface on the board for the most human question of all: *of everything on the board,
what matters most right now?* It works two complementary ways. **(1) Star a node** — a single
favorite / pin toggle on **any** case, workstream, or initiative (one optional `case.starred` flag,
covering all three tiers because they share one `CASE-<n>` id space). **(2) Priority notes** —
**free-text** "what matters most right now" items you type into the Priorities text box (e.g. *"Close
the Acme onboarding this week"*), captured as a new, **deliberately lighter-than-a-reminder** entity
(`PriorityNote`): the priority **in your own words**, with **no** status, link, tasks, or labels —
only its text and an optional manual `position`. Both exist for the agent too: `get_priorities` returns
the starred nodes **and** the notes so the chief-of-staff agent can **align its work and triage to what
the user cares about**. Priority notes are a `PriorityNote` record in **`db.priorities[]`** but ride
the *same* store (one `mutate()` chokepoint, `PRI-<n>` ids minted like `CASE-<n>`, the SSE
live-refresh, backups); the star is just a case write through the **existing** `update_case` path
(`human`/`agent` attribution, logged in the node's activity). Like reminders, priorities add **no new
MCP server** — their five verbs ride the existing **`board`** MCP (no new bridge port). The schema
bumps **v6 → v7** (purely additive; old files read, `priorities` defaults to `[]`, `starred` absent).
Full design: [Priorities](priorities.md).

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Star a node | Optional `CaseRecord.starred` boolean — a user-curated favorite / pin on **any** case / workstream / initiative (one id space, one flag); toggled on the Priorities page, the board cards, the strategy tree, and the case-detail drawer | The one-click way to mark *"this is one of the things I care about most"* on the work the board already holds, at any tier | Additive optional `starred?`; set via the **existing** `PATCH /api/cases/[id]` (no new route); `describeCaseChange` makes star/unstar auditable; `starredCases` derives the set | P0 | S |
| PriorityNote model | New `PriorityNote` record in `db.priorities[]` (`id`/`text`/`position?`/`createdAt`/`updatedAt`); `PRI-<n>` ids minted like `CASE-<n>` | Free-text "what matters most" intents that aren't a card — the priority in the user's own words, lighter than a reminder (no status/link/tasks/labels) | Additive `db.priorities?`; `SCHEMA_VERSION` 6→7, purely additive (old files read, `priorities` defaults to `[]`, `starred` absent); **no new enums** | P0 | S |
| Priorities API | `GET /api/priorities` returns `{ priorities, starred, version }` in one call (`sortPriorityNotes` + `starredCases`); `POST /api/priorities` (text required, position optional); `GET·PATCH·DELETE /api/priorities/[id]` (priority notes hard-delete — no soft-archive); starring needs **no** route change (the existing case PATCH handles `starred`) | One mutation path for priorities, mirroring the reminders routes but simpler (no caseId/labels/tasks/domain/case-audit) | New routes under `board/app/api/priorities`; same `force-dynamic` / `mutate()` / version-guard idioms | P0 | M |
| Priority tools (board MCP) | 5 verbs on the **existing** `board` server: `get_priorities` (read-only — the starred nodes **plus** the notes, so the agent aligns to the user's priorities) + `add_priority`/`update_priority`/`remove_priority` over `/api/priorities` + `set_starred` over `PATCH /api/cases/{id} { starred }`, all `actor:"agent"` | The agent reads what the user cares about most and pins nodes on the user's behalf — a board-native sub-resource, so **no new server/port/bridge** unlike the calendar | Wraps the HTTP routes; MCP server v3.2.0 → v3.3.0 | P0 | S |
| Priorities surface (UI) | **Priorities** nav (after My Issues) → two sections: **Starred** (favorites with a filled-amber unstar button, tier badge + lane; clicking a row opens the node's case-detail drawer in place) and **Your priorities** (a text box to add a note + inline-edit/delete the list, `sortPriorityNotes` order); star toggles also on the board cards, the strategy tree, and the case-detail drawer header; live via SSE; optimistic with revert-on-error | The same priority seen as a human gesture or an MCP verb — one mutation path through `board-client` → `/api/priorities` (+ the case PATCH for stars) | `priorities-view.tsx`; pure `sortPriorityNotes`/`starredCases` selectors; `IconStar` (outline default, filled via `fill`) | P0 | M |

### Case & task data model extensions

Small, additive fields are the substrate every later "smart" feature reads. Due dates are **collapsed to ONE** `Case.dueAt` + `Task.dueAt`.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| **(merged) Due dates** | One additive `Case.dueAt` + `Task.dueAt` (ISO); SSR overdue/due-soon badge; extend update tools. `startDate` only if Gantt ships | Turns free-text `eta` into a sortable/filterable signal feeding Today/Calendar/nudges | Additive optional fields; back-compat keep `eta` | P0 | S |
| Activity / audit log | Append-only `Case.activity[]` (actor human/agent, verb, ts) written by API layer | The trust ledger — what the agent did while you were away; powers "what changed" | Append per mutation; new array | P0 | M |
| Case templates | Named task-set seeds (e.g. onboarding doc-checklist) → `create_case(tasks)` | The onboarding checklist becomes one click / one agent call | `templates.json`; `list/apply_template` | P0 | M |
| Comments / notes | `Case.notes[]` free-form, human or agent, distinct from messages | A place for "called, no answer" that isn't a task or an email | New array; `add_note` tool | P1 | S |
| Subtasks / checklist | One-level `Task.subtasks[]` for multi-part docs | Multi-part requirements without case sprawl | Nested array; counter rollup | P2 | M |
| Priority field | Explicit `Case.priority` (P0–P3) distinct from urgent lane | Rank within a lane | One enum field | P2 | S |
| Recurring cases | `recurrence` rule respawns on completion | Quarterly reviews, monthly admin | Materialize-next-on-done; ingest dedupe | P2 | M |
| Archive / soft-delete state | `archivedAt` (ISO) — archived ≠ `done`; hidden by default, restorable; optional retention/trash window | The removal primitive that delete and bulk-archive all write; recoverable by design for an agent-written store | One optional field + default filter; pairs with `delete_*` | P0 | S |
| Manual order | `position` (float) on Case-within-lane and Task-within-case | Stable hand-set ordering for intra-lane reorder + drag that survives reloads | One optional field; fall back to `updatedAt` when absent | P1 | S |

_Gap (critic): **schema versioning + migration.** Every additive field needs a `schemaVersion` on the store root and a tiny migrate-on-read so old `cases.json` and the MCP server never disagree. Fold into the first data-model PR. P0/S._

### Agent-native intelligence (the differentiator)

The board's reason to exist over a generic kanban: the AI chief-of-staff operates it and reports back. All read existing data + write through existing verbs.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Stale / aging detection | Flag cards idle > N days (esp. `waiting_for_input`) | The chase that quietly dies — surfaced; feeds nudges | Derived from `updatedAt`/activity | P0 | S |
| NL board commands | "move the Acme onboarding to done" → verb dispatch | The conversational twin of drag-drop | Maps NL→existing MCP verbs | P0 | M |
| Draft-reply for waiting | Draft the chase email for an aging `waiting_for_input` case via Gmail MCP | Closes ingest→board→outbound loop | Cross-MCP; Gmail draft | P2 | M |
| Pending-actions approval queue | When `auto-sync` is off, agent-proposed mutations land in an in-board tray → approve/reject commits through the same verb | The product's approval mode (§5) has no surface today — this is where "confirm before committing" actually happens, and a preview of the trust ledger | Proposed-mutation store (`pending.json` or `Case.pending[]`) + approve/reject route; writes the activity log on commit | P1 | M |

### Notifications, reminders & follow-ups

Local-first signal, no push infra. The board computes; the agent (via recipes) delivers.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Needs-attention tray | In-board panel: overdue, aging-waiting, unlinked, untriaged | One honest "what needs you" list without leaving the board | None (derived) | P0 | M |
| Due / overdue badges | SSR-computed date chips on cards | Glanceable urgency | Reads `dueAt` | P0 | S |
| Follow-up nudges | Agent recipe escalates aging `waiting_for_input` (digest / draft / →urgent w/ approval) | The board chases for you | Reads aging; writes via approval switch | P1 | M |
| Snooze | Hide until a date (`snoozeUntil`) | Defer without losing | One optional field + filter | P1 | S |
| Reminder tasks | A task whose `dueAt` is the reminder; nudge surfaces it | Time-based prompts in the model you have | Reuses `Task.dueAt` | P2 | S |

### Integrations & channels

Every inbound deepens the existing one-ingest-path; nothing writes the board directly except through the router + board MCP.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| 2-way Gmail from a case | Draft/send a reply from a case; auto-`link_message` outbound | The onboarding chase without leaving the board | Cross-MCP; `link_message` | P0 | M |
| Calendar prep/time-block | Create a prep/time-block event from a case; recap returns | Deadlines become calendar reality | Calendar MCP; store event id | P1 | M |
| Inbound webhook → router | Single local sink normalizing new sources into the router | One clean extension point for new channels | Tiny local receiver → ingest | P2 | M |
| Slack/WhatsApp/Telegram capture | New channel adapters feeding the router | Capture where messages already land | Per-adapter; reuse dedupe/watermark | P2 | L |
| Jira/Linear mirror | Two-way mirror for the DevForge dev work | Dev tasks beside life without context-switch | External-id map; conflict policy | P2 | L |

_Out of scope (critic): a generic public/3rd-party API. A single local webhook into the router is the only inbound extension point; a real API implies auth + multi-tenant the product explicitly rejects._

### Vault ↔ board bidirectional bridge

The two-surface payoff made visible from the board. The router already maintains `case.vaultLinks` ↔ page `cases:` frontmatter.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Vault context panel on a case | Render linked entity/concept/source pages in the card panel | Who/what/why beside the work — the differentiator | Read-only MD reader (vault path) | P0 | M |
| Entity 360 | One page: all cases + vault facts + history for an actor | The pre-call/pre-meeting brief | Joins cases by `vaultLinks` + vault read | P0 | L |
| Bidirectional backlinks nav | Card → vault page and back, in-app | One-hop both directions | Reuses cross-link arrays | P1 | M |
| Link picker (vault titles) | Autocomplete real vault page titles when linking | Keeps `vaultLinks` ↔ `cases:` honest from the UI | Vault title index read | P1 | S |
| Untracked/orphan lens | Cases with no `vaultLinks`; vault entities with no case | Hygiene for the two-way invariant | Derived join | P2 | S |

### Analytics, reporting & SLA

The operator's instrument panel. All derivable from cases + activity + `dueAt`; exports written to the vault.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Waiting-SLA timers | Time-in-`waiting_for_input` per case; breach badge | The DX Lead's core metric — how long a request has been blocked on someone else | Derived from activity/`updatedAt` | P0 | M |
| Work/life balance | Open/closed split by domain over time | Is life losing to work | Derived | P1 | S |
| Throughput / cycle time | Created vs done/wk; lane dwell | Are things actually closing | Needs activity timestamps | P1 | M |
| Aging / WIP report | Histogram by age & lane | Where the pipeline clogs | Derived | P1 | S |
| Adoption pipeline dashboard | Onboarding funnel + setup-checklist completion | The flagship use case, measured | Derived (+ optional skill fields) | P1 | M |
| Markdown/CSV export | Reports to `vault/output/` the router can file | Compounding records, not throwaway views | File write | P2 | S |
| WIP limits | Soft per-lane caps with visual warn | Guards against overload | Config + check | P3 | S |

### Persistence, sync, auth & platform

The foundation that makes agent-native real and keeps the JSON store trustworthy under two writers.

| Feature | What | Why it matters | Data/Arch impact | Pri | Size |
|---|---|---|---|---|---|
| Live refresh (SSE + file-watch) | Watch `cases.json`; push reloads so writes appear live | **Without this the agent-native promise is invisible**; the keystone | SSE endpoint + watcher; no DB | P0 | M |
| Safe concurrent writes | Atomic write (tmp+rename) + version/ETag guard against lost updates | Two writers (you + agent) must not clobber | Atomic file write; `version` field | P0 | M |
| Store integrity + backup | Validate-on-read, timestamped snapshot on write, hand-edit friendly | One bad write can't dark the board; hand-editable | Snapshot dir; JSON validation | P0 | S
| Settings (fill "Manual") | Real settings: auto-sync toggle, defaults, theme, WIP limits | The dead third view earns its place | `settings.json` | P1 | S |
| Guard master toggle (Security) | A user-controllable **ON/OFF master switch** for the prompt-injection Guard on `/security` (**default OFF**); ON is deps-gated (a model-deps checklist + a copy/paste [`guard-setup`](https://github.com/philipyaz/cos/blob/main/.claude/skills/guard-setup/SKILL.md) command + Refresh), OFF is a reachable **passthrough** (mail admitted un-scanned, the user's explicit choice) — *distinct* from a down sidecar, which still **fails closed**. State lives in the sidecar (`guard/data/guard-config.json`); the board is a thin proxy (`GET·POST /api/guard/config`). See [Guard](../security/guard.md). | Security is the user's call; the gate, the deps, and the supported-model catalog are all manageable in-board | `ConfigStore` + `GET·POST/GET /config·/models` on the sidecar; `app/api/guard/config` proxy + `<GuardControl>` | P1 | M |
| Accessibility & interaction states | Focus management, ARIA roles + labels for the now-interactive board; explicit loading / empty / error / confirm-destructive states | A read-only render had only Esc; a mutable board needs honest feedback and keyboard/AT access — "fail safe over fail silent" at the UI layer | None (component-level); confirm dialog pairs with archive/delete | P1 | S |
| Responsive / PWA | Mobile layout; installable; read-first offline | Triage from a phone | Responsive pass; service worker | P2 | L |
| Dark mode | Theme toggle | Long sessions / preference | CSS vars + toggle | P3 | S |

_Out of scope (critic): **auth/login** (single-user local; OS-level security suffices), **multi-device real-time sync / cloud DB** (revisit only at device #2 — keep the swappable store seam), **collaborative/multi-user** (single-user by design; no collaborator accounts)._

## Phased roadmap

Build order. Each phase is independently shippable and leaves the board fully usable.

1. **Phase 0 — Make the board writable + live (the keystone).** Drag-drop, inline edit, quick-add, archive/delete (with confirm), optimistic+undo on the human side; SSE+file-watch live refresh, atomic versioned writes, integrity+backup on the platform side. _Rationale: nothing else matters if the board can't be edited or if agent writes stay invisible. Closes the read-only gap and lights up the agent-native promise in one stroke._
2. **Phase 1 — Trustworthy model + the slices you read daily.** Schema versioning/migrate-on-read, `dueAt`, activity log, case templates; Today/Focus + the unified filter/sort/group engine + deep-link URLs; needs-attention tray + due badges; inbox triage; accessibility + interaction states. _Rationale: additive fields first (everything smart reads them), then the daily-use lenses they unlock._
3. **Phase 2 — Two-surface payoff + first agent intelligence.** Vault context panel, entity 360, full card composer + task editor; daily briefing, stale detection, NL board commands, the pending-actions approval queue; 2-way Gmail from a case. _Rationale: with model + live board solid, deliver the differentiator (vault bridge) and the first agent loop that reports and acts._
4. **Phase 3 — Operator instrumentation + delivery.** Waiting-SLA timers, work/life + throughput/aging reports, adoption pipeline dashboard; follow-up nudges, digest delivery, snooze; saved views, table/calendar views. _Rationale: once data + activity accrue, measurement and proactive nudging pay off._
5. **Phase 4 — Reach + depth (optional/opportunistic).** Command palette, bulk actions, subtasks, recurring cases, priority; calendar/Gantt; webhook + new channel adapters; PWA/responsive, dark mode, WIP limits. _Rationale: power-user depth and breadth once the core operating loop is proven._

## Highest-leverage first

If only one slice ships, ship this (the critic's top-leverage set, all Phase 0–1):

- **Live refresh (SSE + file-watch)** — the keystone; makes every agent action visible and the differentiator real.
- **Drag-drop + inline edit + quick-add + archive** — the table-stakes writable board.
- **Optimistic updates + undo** — makes a no-realtime board feel instant and safe.
- **Safe concurrent writes + integrity/backup** — two writers can't corrupt or dark the store.
- **`dueAt` + activity log** — the two additive fields the most features read (dates → Today/Calendar/nudges; activity → trust ledger/SLA/briefing).
- **Today/Focus view + needs-attention tray** — turns the data into the one daily-driver screen.
- **Unified filter/sort/group engine** — revives the dead Filter button and underpins every view.
- **Stale detection** — the cheapest, highest-signal agent-native win.

## Out of scope (for now)

With the one-line reason each:

- **Auth / login / accounts** — single-user local product; OS-level security is the boundary.
- **Multi-device real-time sync / cloud DB** — revisit only when a second device appears; keep the store seam swappable until then.
- **Collaborative / multi-user** — single-user by design; no collaborator accounts, no identity system.
- **Generic public/3rd-party API** — one local webhook into the router is the only inbound extension; a real API implies the auth/multi-tenant the product rejects.
- **Heavy client state libs / SPA rewrite** — keep SSR + light client interactivity; don't trade local-first simplicity for a framework.
- **Per-card real-time collaboration / presence** — no second human, so no presence/locking beyond single-writer version guards.

## Backend surface — verbs & routes (existing vs new)

Agent-native parity means **one mutation path**: every human gesture in the tables above and every agent action resolve to the *same* board MCP verb / API route. Today **7 verbs exist, none destructive**; the full feature set implies a small, mostly-additive set of new ones (✅ exists · 🆕 to build).

| Verb | Route | Status | Feeds |
|---|---|---|---|
| `create_case` | `POST /api/cases` | ✅ | quick-add · composer · message→case · templates |
| `get_case` | `GET /api/cases/[id]` | ✅ | drawer · jump-to-case |
| `update_case` | `PATCH /api/cases/[id]` | ✅ | drag-drop lane move · inline edit · reorder |
| `add_task` | `POST /api/cases/[id]/tasks` | ✅ | task editor · next-action |
| `update_task` / `complete_task` | `PATCH /api/cases/[id]/tasks/[taskId]` | ✅ | advance / complete · task reorder |
| `link_message` | `POST /api/cases/[id]/messages` | ✅ | inbox link · 2-way Gmail |
| `archive_case` / `delete_case` | `DELETE /api/cases/[id]` (soft via `archivedAt`) | 🆕 | archive/delete · bulk-archive |
| `delete_task` | `DELETE /api/cases/[id]/tasks/[taskId]` | 🆕 | task delete |
| `update_message` | `PATCH /api/messages/[id]` | 🆕 | inbox read/unread · unread badge |
| `update_cases` | `PATCH /api/cases` (batch) | 🆕 | bulk actions · regroup |
| — (UI-only, by design) | `POST /api/cases/clean` (`{ids}` → hard-delete done cases + purge their linked emails; done-only guard) | 🆕 | Clean Done lane (storage reclaim) |
| `add_note` | `POST /api/cases/[id]/notes` | 🆕 | comments / notes |
| `create_initiative` / `create_workstream` | `POST /api/cases` (`kind:"initiative"` / `kind:"workstream"`+`parentId`) | 🆕 | new Initiative · new Workstream (see [Hierarchy](../architecture/hierarchy.md)) |
| `set_parent` | `PATCH /api/cases/[id]` (`parentId`, `null` detaches) | 🆕 | re-parent / detach a node |
| `regroup_cases` | `PATCH /api/cases` (batch `{ ids, patch:{ parentId } }`) | 🆕 | group leaves under an Initiative/Workstream |
| `get_tree` / `list_initiatives` | `GET /api/tree` | 🆕 | strategy roadmap · Initiative outline |
| `create_event` / `list_events` / `get_event` / `update_event` / `delete_event` / `link_event` | `…/api/events` (`GET·POST /api/events`, `GET·PATCH·DELETE /api/events/[id]`) | 🆕 | calendar surface · appointments linked to a case (see [Calendar](calendar.md)) — via the `calendar` MCP (port 8003) |
| `create_reminder` / `list_reminders` / `get_reminder` / `update_reminder` / `complete_reminder` / `delete_reminder` / `link_reminder` / `link_reminder_message` | `…/api/reminders` (`GET·POST /api/reminders`, `GET·PATCH·DELETE /api/reminders/[id]`, `POST /api/reminders/[id]/messages`) | 🆕 | reminders surface · lightweight nudges linked to any node, with v6 labels/tasks/linked-emails (see [Reminders](reminders.md)) — on the **`board`** MCP (no new server/port) |
| `get_priorities` / `add_priority` / `update_priority` / `remove_priority` / `set_starred` | `…/api/priorities` (`GET·POST /api/priorities`, `PATCH·DELETE /api/priorities/[id]`) · `set_starred` → `PATCH /api/cases/[id] { starred }` | 🆕 | priorities surface · starred nodes + free-text priority notes the agent reads to align its work (see [Priorities](priorities.md)) — on the **`board`** MCP (no new server/port) |
| `search` | `GET /api/search` (keyword) · `POST /api/search` (batch semantic top-K) | ✅ | spotlight · command palette |
| `list_views` / `save_view` | `GET·POST /api/views` | 🆕 | saved views |
| `list_templates` / `apply_template` | `GET·POST /api/templates` | 🆕 | case templates |
| `propose` / `approve` / `reject` | `…/api/pending` | 🆕 | approval queue |
| — (live) | `GET /api/stream` (SSE) | 🆕 | live refresh |

Two rules keep parity honest: **(1) no human-only or agent-only mutation** — if the UI can do it a verb exists, and every verb has a UI twin; **(2)** every verb writes through the single atomic, version-guarded store path (see *Persistence — Safe concurrent writes*). The lone deliberate exception to (1) is the **Clean Done** purge (`POST /api/cases/clean`): a destructive bulk-housekeeping action kept off the agent surface on purpose — the agent has per-case `delete_case(hard:true)` but no mass-purge.

## Open questions

Genuine decisions before/within the build:

1. **Store: stay JSON or move to SQLite?** Additive fields + activity log grow `cases.json`. JSON keeps hand-editability + local-first simplicity; SQLite buys concurrent-write safety + queries. Recommendation: **stay JSON with atomic writes + version guard now**, keep the `store.ts` seam swappable. When does growth force the switch?
2. **Live refresh transport: SSE vs poll?** SSE is clean but adds a long-lived route; a 3–5s SSR poll is dead-simple and may suffice for one user. Which fits the local-first ethos better?
3. **Activity log location: in `cases.json` or a sidecar?** Inline keeps one file + atomic; a sidecar `activity.jsonl` keeps the case file lean and append-only. Pick before the audit log ships.
4. **Agent autonomy default:** does drag-drop-equivalent agent triage need the `auto-sync` approval gate, or only outward actions (email/calendar)? Where's the line between board-internal and outward?
5. **NL command verbs:** new dedicated MCP verbs, or NL→existing-verb dispatch in the skill layer? Affects whether the palette is board code or router code.
6. **`eta` vs `dueAt`:** keep free-text `eta` beside structured `dueAt`, or migrate `eta`→`dueAt`+notes? Affects onboarding skill prompts already writing `eta`.
7. **Archive vs hard-delete + retention.** Is removal always soft (`archivedAt`, restorable) with hard-delete reserved for a manual "empty trash" — and how long do archived (and old `done`) cases live before pruning? Affects store growth and the agent's dedupe-merge behavior.
8. **Approval-queue home.** Does the pending-actions queue live board-side (a `pending` store the UI reviews) or router-side (the skill holds proposals until confirmed)? Determines whether approval is board code or router code — parallels Q5.

---

_Synthesized from a 10-dimension design pass (interaction, views, search, data model, agent intelligence, notifications, integrations, vault bridge, analytics, platform), a completeness critique, and a sequencing pass. Merges noted inline; gaps and out-of-scope flagged from the critique._
