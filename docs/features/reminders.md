# Reminders — lightweight nudges on the board

The board is where work *to do* lives, decomposed into cases with tasks, lanes, and a hierarchy.
But some matters are not really a case at all: they are a **nudge** — *a reminder to CHECK or to DO
something*. "Check the trip dates against the conference dates." "Confirm the
passport arrived." "Ping the lawyer if no reply by Friday." Those don't want a task checklist or a
kanban lane; they want to be **remembered at the right moment**, and then to go away. A reminder is
the board's surface for exactly that: a **first-class, deliberately lighter-than-a-case** record
with a **Title**, an optional line of **detail**, an optional **due date**, and a **status** —
nothing more.

The headline idea is the **link**, exactly as with calendar events. A reminder is rarely
free-floating: a check is *about* a trip, a nudge is *for* an open chase. So a reminder can carry a
`caseId` that ties it to a board node, and that one field is the **single source of truth** for the
node↔reminder relationship — the node can show its reminders, the reminder knows which matter it
serves, and neither side keeps a second copy of the link. Because all three tiers
(Initiative / Workstream / Case) are `CaseRecord`s in `db.cases` sharing **one `CASE-<n>` id
space**, that single `caseId` covers all three: a reminder can hang off an Initiative, a Workstream,
or a leaf Case with no per-tier field and no separate id space.

Reminders are deliberately **lighter than a case, but no longer bare**. The original instinct —
*a reminder is just a title + status + due signal* — held back the matters that don't justify a
full Case yet still carry a little more than a one-liner: a billing notice with two emails about
it, a small check that's really three quick boxes to tick. The **v6 enrichment** keeps a reminder a
*nudge* while letting it hold exactly that much more — so a minor notice ("YouTube (Google Play) —
subscription suspended, update payment") lands as a well-formed reminder instead of bloating into a
case. A reminder now carries:

- **catalog labels** (`reminder.labels`) — the *same* `db.labels` ids a case uses, validated the
  same way (unknown ids rejected `400`), so a nudge categorizes into the same taxonomy and search
  facets as everything else;
- a **short tasks checklist** (`reminder.tasks` — `ReminderTask` rows of `id`/`title`/`done`) — a
  *concise* list of boxes to tick ("update payment method", "confirm it reactivated"), **not** full
  Tasks (no owner, no status enum, no dates, no subtasks);
- **linked emails** — many emails about **one** matter point at one reminder via
  `message.reminderId`, the single source of truth for the reminder↔email link (no `messageIds[]`
  on the reminder), so a string of billing notices attaches to the one nudge that resolves them.

A reminder is still **not** a case: no hierarchy of its own, no kanban lane, no activity log, no
soft-archive (prefer flipping to `done`/`dismissed`). And it is still **not** a calendar appointment
(no time-of-day, no month-grid placement — a reminder's `dueAt` is *when to be nudged*, not *where
it falls on a day*). The model stays a nudge — title, status, an optional due signal, an optional
node link — now with just enough structure (labels, a small checklist, attached mail) to capture the
minor matters that would otherwise leak into cases.

## The one decision that makes this cheap: reminders ride the same store

A `Reminder` is a **new record type**, but it is **not** a new store, a new id ceremony, a new write
path, and — unlike the calendar — **not even a new MCP server**. Reminders live in
**`db.reminders[]`** in the same JSON file as cases, messages, and events, are minted `REM-<n>` the
same way cases are `CASE-<n>`, events are `EVT-<n>`, and messages are `M-<n>`, and are written
through the **same serialized `mutate()` chokepoint** as everything else. So the entire existing
machinery is reused **for free**:

- the store's serialized read-modify-write `mutate()` critical section (id minting + insert are
  one atomic step, so concurrent creates can't collide on a `REM-` id),
- the monotonic **`version`** counter + the **SSE live-refresh** (an agent or another tab adding a
  reminder lands on the Reminders surface without a reload),
- the timestamped **backups** and the **validate-on-read** integrity pass,
- the **actor attribution** (`human` from the UI, `agent` from MCP) that stamps the linked node's
  activity log.

There is **no `reminderIds[]` array on the case.** The link is held in exactly one place —
`reminder.caseId` — and a node's reminders are *derived* by filtering `db.reminders` for that id
(`db.reminders.filter(r => r.caseId === id)`). One source of truth, no two-sided bookkeeping to
drift. **The reminder↔email link follows the same shape, inverted:** an email points at its reminder
via `message.reminderId`, that one field is the single source of truth (no `messageIds[]` on the
reminder), and a reminder's emails are *derived* by filtering `db.messages` for that id
(`messagesByReminderId` / `messagesForReminder`). A message may link to a case *and* a reminder
independently — `caseId` and `reminderId` are separate fields, neither derived from the other.

## Data model

A new record type — `Reminder`, defined in `board/lib/types.ts` right after `CalendarEvent` — one
new enum (`ReminderStatus`), the small `ReminderTask` interface (v6), and one new optional array on
the store root. `domain` reuses `CaseDomain` / `VALID_DOMAIN`; the v6 `labels` reuse the same
`db.labels` / `LabelDef` catalog a case uses (no reminder-specific label space), and `tasks` carry
**no** status enum — a `ReminderTask` is just `id`/`title`/`done`.

```ts
export type ReminderStatus = "open" | "done" | "dismissed";
export const VALID_REMINDER_STATUS: ReminderStatus[] = ["open", "done", "dismissed"];

// A SHORT checklist item under a reminder (v6) — concise, NOT a full Task (no status
// enum / owner / dates). The id ("REM-<n>-T<k>") is minted by the store
// (nextReminderTaskId), never the caller — mirrors Subtask but lives on a Reminder.
export interface ReminderTask {
  id: string;
  title: string;
  done: boolean;
}

export interface Reminder {
  id: string;            // "REM-<n>" minted like CASE-<n>/EVT-<n>/M-<n> ids
  title: string;         // required, non-empty — the nudge itself
  detail?: string;       // optional elaboration / context
  status: ReminderStatus; // "open" (default) | "done" | "dismissed"
  caseId?: string;       // OPTIONAL link to ANY CaseRecord (initiative|workstream|case) — the SINGLE SOURCE OF TRUTH for the node<->reminder link
  dueAt?: string;        // ISO date (or datetime) — when to be reminded / when the check is due; the sortable signal
  domain?: CaseDomain;   // "work" | "life" — optional/advisory (may mirror the linked node domain)
  labels?: string[];     // (v6) catalog-backed label ids (db.labels / LabelDef) — validated like a case's labels
  tasks?: ReminderTask[]; // (v6) a SHORT checklist (id/title/done) — concise, NOT full Tasks
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
  completedAt?: string;  // ISO — set when status flips to "done" (cleared otherwise), like Task.completedAt
}
```

And the v6 email link is one new optional field on `MessageRecord` (the reminder↔email source of
truth — see *Linked emails* below):

```ts
export interface MessageRecord {
  // …
  caseId?: string;       // link to a CaseRecord
  reminderId?: string;   // (v6) OPTIONAL link to a Reminder (REM-<n>) — single source of truth for the reminder<->email link (mirrors caseId; a message may link to a case and/or a reminder)
}
```

And one new optional field on the store shape (unchanged since v5):

```ts
export interface DBShape {
  // …
  reminders?: Reminder[];   // lightweight nudges (v5); reminder.caseId is the node<->reminder link source of truth
}
```

### The v5 → v6 schema bump — purely additive

`SCHEMA_VERSION` goes **5 → 6**. The bump is **purely additive**: the only changes are the optional
`Reminder.labels` + `Reminder.tasks` (v6) and the optional `MessageRecord.reminderId` (v6) — there
is **no structural change** to the store root (`db.reminders[]` already arrived in v5). Old v5 (and
v4) files still read unchanged — a reminder with no `labels`/`tasks` is exactly the reminder you
had, and a message with no `reminderId` is exactly the message you had. No new enums: `labels` are
validated against `db.labels` via `assertKnownLabels` in the route, and `tasks` carry no status. (An
earlier bump, **v4 → v5**, added the optional `db.reminders[]` array itself.) (See
[Migration](../reference/migration.md).)

## The invariants

A `Reminder` is valid iff:

- **`id` matches `/^REM-\d+$/`** and is unique across `db.reminders` (minted by `nextReminderId`,
  never by a caller).
- **`title` is a non-empty string** (trimmed) — a nudge with no title is rejected.
- **`status` is `open` | `done` | `dismissed`** (`VALID_REMINDER_STATUS`); it defaults to **`open`**
  on create. When `status` flips **to `done`**, `completedAt` is stamped (like `Task.completedAt`)
  and cleared again if it leaves `done`.
- **`dueAt`, when present, is a parseable ISO date/datetime** — a date-only `"YYYY-MM-DD"` or a full
  ISO datetime. It is the sortable signal (*when to be nudged*), not a time-of-day placement.
- **`caseId`, when present, references an existing `CaseRecord`** — checked **inside the store
  lock** (a relational check, the cases/events-route precedent), so an unknown `caseId` is rejected
  with a `400`, never silently dangled. A `caseId` may point at **any tier** (initiative /
  workstream / case) since all three share one id space; `caseId` absent === a **standalone**
  reminder.
- **`domain`, when present, is `work` | `life`** (`VALID_DOMAIN`) — optional and **advisory**, and
  may mirror the linked node's side.
- **`labels`, when present, are catalog-backed `db.labels` ids** — each must be a known label id,
  asserted **inside the store lock** via `assertKnownLabels` (the same check a case's labels get),
  so an unknown id is rejected with a `400` and the valid set returned. Empty after trim/dedupe ⇒
  the field collapses to absent (clearing never persists `[]`).
- **`tasks`, when present, are `ReminderTask` rows** (`id` / non-empty `title` / `done` boolean).
  Empty-title rows are dropped; an empty result collapses to absent. Each `id` is `REM-<n>-T<k>`,
  **minted by the store** (`nextReminderTaskId`) — never by a caller — continuing from the max
  existing `-T<k>`.

The two new fields are coerced (dedupe/trim for `labels`; row coercion + id minting for `tasks`) at
the same un-validating store chokepoint that handles every reminder field — `applyReminderUpdate`.
Label-id **validity** is the route's job (`assertKnownLabels` before the coercion runs); the
coercion only normalizes shape.

### Where the invariants are enforced

**The routes.** Both `/api/reminders` files share the same shape guards (the title check, the
`VALID_REMINDER_STATUS` check, the parseable-`dueAt` check, the `VALID_DOMAIN` check, plus the v6
`labels`-is-array and `tasks`-is-objects-with-string-titles shape checks) — fast `400`s outside the
lock for body shape — and assert the **relational** rules **inside `mutate()`**, before the write,
throwing `BadRequestError → 400`: the `caseId` references a real case, and (v6) `assertKnownLabels`
that every label id is in `db.labels`. Id minting (`nextReminderId`) and insert happen in that same
critical section so concurrent creates can't mint a duplicate `REM-` id; the `ReminderTask`
`-T<k>` ids are likewise minted by the store (`nextReminderTaskId`), never the caller. The store
helpers (`findReminder`, `applyReminderUpdate`, `removeReminder`, `remindersForCase`, and the v6
`messagesForReminder`) are the single read/write surface the routes call, mirroring the case/event
helpers. `applyReminderUpdate` is the un-validating coercion chokepoint for `labels` (dedupe + trim
+ drop-empty, copied exactly from the case path) and `tasks` (row coercion + `-T<k>` minting);
`removeReminder` now also **unlinks the reminder's emails** (clears each `m.reminderId === id`) so a
hard-delete leaves no dangling link, mirroring `removeCaseHard`'s message-unlink.

The pure projection layer over `db.reminders` lives in `selectors.ts` — `remindersByCaseId`
(a node's reminders), the v6 `messagesByReminderId` (the emails linked to a reminder —
`m.reminderId === id`, the inverse twin of `remindersByCaseId`), `openReminders` (the
still-actionable ones), `sortReminders` (status rank `open < done < dismissed`, then by `dueAt`),
and `upcomingReminders` (open reminders whose `dueAt` day falls in `[today, today+daysAhead]`) — all
deterministic and time-relative helpers anchored to a passed-in `now`, exactly like the calendar
selectors.

## API

Reminders ride two new route files under `board/app/api/reminders`, mirroring the existing
case/event-route idioms exactly: `force-dynamic`, `resolveActor` (human default; `x-actor: agent` or
`body.actor === "agent"` ⇒ agent), `BadRequestError → 400`, `NotFoundError → 404`,
`VersionConflictError → 409`, the `{ error }` body, the `mutate()` critical section, and a `version`
on every success body.

| route | does |
|---|---|
| `GET /api/reminders` | Lists reminders; optional `?status=&caseId=&domain=` filters. `status` narrows to `open`/`done`/`dismissed` (only when a valid `ReminderStatus`); `caseId` to one node's reminders; `domain` to `work`/`life`. No filters → **all** reminders. Returns `{ reminders, version }`. |
| `POST /api/reminders` | Creates a reminder. `title` required; `status` defaults `open`; absent optionals are omitted from the record. A `caseId` is validated against an existing case **inside the lock**. (v6) optional `labels` (array of label ids, `assertKnownLabels` **inside the lock**) and `tasks` (array of `{ title, done? }`, `-T<k>` ids minted by the store) — both shape-checked outside the lock (`400`) and coerced via `applyReminderUpdate`. On a linked create, the node's activity log gets a `reminder_linked` entry. → `{ reminder, version }`, `201`. |
| `GET /api/reminders/[id]` | Loads one reminder by id. Unknown id → `404`. (v6) also returns the reminder's **linked emails** — `messages = messagesForReminder(db, id)` sorted newest-first by `receivedAt` (NaN sinks last). → `{ reminder, messages, version }`. |
| `PATCH /api/reminders/[id]` | Partial update of any field, incl. **(re)linking via `caseId`** and a `status` flip (a flip **to `done`** stamps `completedAt`); `caseId: null`/`""` **unlinks** (leaves it standalone). (v6) accepts `labels` (`assertKnownLabels` **inside the lock**, before the coercion) and `tasks` (toggle/add/remove rows; kept rows keep their `-T<k>` id, new id-less rows get minted ones). Optional `expectedVersion` optimistic guard (`≠ current → 409`). Logs `reminder_linked`/`reminder_unlinked`/`reminder_completed`/`reminder_updated` on the affected node(s). → `{ reminder, version }`. |
| `POST /api/reminders/[id]/messages` | (v6) **Links an email to the reminder** — mirrors `POST /api/cases/[id]/messages` but the reminder must exist (`404 "Reminder <id> not found"`), sets `msg.reminderId = id` (not `caseId`), and logs **no** activity (a reminder has no activity log). Accepts `to`/`cc`/`outbound` and **auto-derives guard trust** over the reminder's own message set (a reminder is a first-class trust source, same rule as a case — see [Guard](../security/guard.md)); the push is best-effort / fail-open. → `{ reminder, message, version }`, `201`. |
| `DELETE /api/reminders/[id]` | **Hard-removes** the reminder (reminders have **no soft-archive** — prefer flipping to `done`/`dismissed` when it's simply resolved). If it was linked, the node logs `reminder_unlinked`; the node itself is untouched. (v6) its **linked emails survive** — `removeReminder` clears each `m.reminderId === id` so no message dangles. → `{ ok: true, version }`. |

**The case read now surfaces its reminders.** `GET /api/cases/[id]` returns a new `reminders` array
alongside `case` / `messages` / `manualActions` / `events`, computed by filtering `db.reminders` for
`r.caseId === id` (the link's single source of truth — there is no `reminderIds[]` on the case to
read). A leaf or a container alike sees the nudges tied to it.

### Linked emails — `message.reminderId` (v6)

A minor matter is often **a string of emails** — a billing notice, a payment reminder, a "still
unpaid" follow-up — that together don't justify a case but want capturing as **one** nudge. v6 lets
you attach a multitude of emails to one reminder, the inverse twin of the case↔reminder link:

- **`message.reminderId` is the single source of truth.** There is no `messageIds[]` on the reminder;
  a reminder's emails are derived by filtering `db.messages` (`messagesForReminder` →
  `messagesByReminderId`). A message can link to a case **and** a reminder at once — `caseId` and
  `reminderId` are independent fields.
- **Two ways to link.** `POST /api/reminders/[id]/messages` creates-and-links an email in one call
  (the reminder twin of the case route); `PATCH /api/messages/[id] { reminderId }` links an existing
  message — and `{ reminderId: null }` **unlinks** it, leaving the message intact. Linking to a
  non-existent reminder is a `404 "Reminder <id> not found"`.
- **Hard-deleting the reminder keeps the mail.** `removeReminder` clears `reminderId` on every
  linked message rather than deleting the messages — the emails survive, just unlinked.

**Worked example — a billing notice that isn't a case.** "YouTube (Google Play) — subscription
suspended, update payment" arrives, followed by a "still unpaid" nudge a few days later. It needs
no analysis, no multi-step tracking, no kanban lane — so it's a **standalone reminder**, not a case:
title the nudge, attach **both** emails to it via `link_reminder_message`, add a catalog `finance`
label, and add a one-line `tasks` checklist (`update payment method`). One nudge holds the whole
matter; when it's resolved you flip it `done`.

**Reminders are searchable now (incl. `done`).** v6 adds reminders to board search — a `search`
hit can be a case, task, message, **or reminder**, and each hit flags its nature (`type`). A
reminder's title / detail / labels / task titles / domain are indexed, and `done`/`dismissed`
reminders are included regardless of any archive filter (reminders have no archive). See
[Search](../reference/search.md).

## The reminder tools — on the board MCP

Reminders get **eight** agent verbs — `create_reminder`, `list_reminders`, `get_reminder`,
`update_reminder`, `complete_reminder`, `delete_reminder`, `link_reminder`, and (v6)
`link_reminder_message` — but they live on the **existing `board` MCP server**, *not* on a new one.
This is the deliberate difference from the calendar (which earned its own `calendar` stdio server on
port 8003): a reminder is a **board-native sub-resource**, alongside cases, tasks, notes, and
messages, that **links to the board's own nodes**.
Putting its verbs on the board MCP means **no new server, no new bridge port, and no `.mcp.json`
change** — the agent that already drives the board gains the reminder verbs in the same toolset, and
the prefer-linking guardrail can lean on the `search` and `get_tree` tools that sit right beside it.

Every tool wraps the board's `/api/reminders` routes over the same HTTP path the board verbs use, and
every write is attributed `actor: "agent"` (both an `x-actor: agent` header **and**
`{ actor: "agent" }` in the body), so the linked node's audit trail stays honest.

| verb | does |
|---|---|
| `create_reminder(title, [detail], [status], [dueAt], [domain], [caseId], [labels], [tasks])` | `POST /api/reminders`. Mints a `REM-` id; `status` defaults `open`; **prefer setting `caseId`** to roll the reminder up under the node it concerns. (v6) `labels` is catalog label ids — **call `list_labels` FIRST; UNKNOWN ids are REJECTED** — and `tasks` is a short checklist of `{ title, done? }` items. Unknown `caseId` or label id → tool error (400). |
| `list_reminders([status], [caseId], [domain])` | `GET /api/reminders`. One compact line per reminder (status · due · title · linked `caseId`); (v6) may append ` · <done>/<total> tasks` when tasks exist. Read-only. |
| `get_reminder(id)` | `GET /api/reminders/{id}`. Renders title, status, detail, `dueAt`, domain, the linked `caseId` (or that it's standalone), and (v6) a **Labels** line, a **Tasks** checklist (done/total + `[x]`/`[ ] title` lines), and a **Messages** block (`[source] from — subject`) of the linked emails. |
| `update_reminder(id, …)` | `PATCH /api/reminders/{id}`. Pass only changed fields. `status: "done"` stamps `completedAt`; `caseId` (re)links; **`caseId: null` unlinks**. (v6) accepts `labels` (validated; call `list_labels` first) and `tasks` (`{ id?, title, done? }` rows — keep a row's `id` to update it, omit it to add a new one). |
| `complete_reminder(id)` | `PATCH /api/reminders/{id} { status: "done" }`. Sugar for "I did/checked it" — also stamps `completedAt`. |
| `delete_reminder(id)` | `DELETE /api/reminders/{id}`. Hard-removes the reminder; the linked node is untouched and any linked emails survive (just unlinked). Prefer `complete_reminder` / `dismissed` when it's simply resolved. |
| `link_reminder(id, [caseId])` | `PATCH /api/reminders/{id} { caseId }`. Sugar for the common roll-up: pass a `caseId` (any tier) to link, `null`/empty (or omit) to unlink. |
| `link_reminder_message(id, source, from, [subject], [preview], [body], [receivedAt], [read])` | (v6) `POST /api/reminders/{id}/messages`. The reminder twin of `link_message` — attaches an email to the reminder (`message.reminderId = id`). Use to gather **many emails about one matter** (e.g. a billing thread) onto **one** nudge. |

### The house guardrail — prefer linking to a node

The reminder tools carry the same **prefer-linking** rule baked into the calendar MCP, in the
`create_reminder` and `link_reminder` tool descriptions: **before creating a standalone reminder,
find the node it concerns.** Because the reminder verbs live on the board MCP, the agent already has
`search` and `get_tree` — so it should call `search` (several queries) **and** `get_tree` **first**
to find a matching Initiative / Workstream / Case by person/entity or topic. If a
strong match exists, set `caseId` so the reminder rolls up under that node and the node lists it;
only if nothing matches does it create the reminder **standalone** (omit `caseId`). This is the
reminders twin of the board's search-before-create dedupe mandate — a nudge, like a case, should
attach to the matter it serves rather than float alone.

## The UI

A new **Reminders** entry in the board's left nav (`/reminders`, beside Inbox / Today / Calendar)
opens the **reminders surface**:

- **Grouped by due bucket.** Open reminders are partitioned into **Overdue · Today · Soon · Later ·
  No date** buckets (via the `dueStatus` selector) and ordered inside each by `sortReminders`;
  finished ones (done / dismissed) sit in their own pile. SSR seeds the reminders list + the board
  version into local state; a live **SSE** subscription refetches whenever the board version
  advances past what the page last saw (mirroring board-view / calendar-view) — so an agent's MCP
  write or another tab's edit lands here **without a reload**.
- **The reminder drawer + the node linker.** The drawer captures the nudge — Title / detail / status
  / due date / domain — and a **node linker** that sets `reminder.caseId`. The linker is the headline
  gesture: a typeahead (reusing the calendar's case-picker approach) that lets you link to **any**
  board node — Initiative, Workstream, **or** Case — since all three tiers share one id space. A
  linked reminder shows the node's id + a tier badge (for containers) + a lane dot; an unlinked one
  is standalone. (v6) The drawer also holds a **labels picker** (catalog chips fetched via
  `fetchLabels`, toggling id membership, reusing the board cards' label-chip styling/colours), a
  **tasks checklist editor** (rows of text input + done checkbox + remove, plus an add-row), and —
  when editing — a read-only **Linked emails** list (loaded via `fetchReminder(id)`, showing
  source / from / subject, each unlinkable via `updateMessage(mId, { reminderId: null })`).
- **A Reminders section on the case-detail drawer — the reverse link.** Opening a case (or a
  container) shows a **Reminders** section listing the nudges linked to *that* node, with inline
  add / complete / delete — the bidirectional twin of the reminders surface. New reminders composed
  there prefill `caseId` and mirror the node's domain. (v6) the rows reflect resolved label chips and
  a task-progress chip (`<done>/<total>`) when present. It owns its own fetch/state and re-pulls
  after any mutation, then bubbles to the parent so the rest of the drawer reflects the change.
- **One mutation path.** Every create/edit/complete/delete routes through `board-client`
  (`createReminder` / `updateReminder` / `completeReminder` / `deleteReminder`, plus the v6
  `linkReminderMessage` / `fetchReminder`) → the `/api/reminders` routes — the exact routes the
  reminder tools call.

## Parity rule

Reminders obey the board's founding tenet: **every human gesture is the visual twin of an MCP
verb.** Composing a nudge in the drawer, flipping it done with the checkbox, linking it to a node
through the typeahead, and deleting it all resolve to the **same `/api/reminders` routes** the
agent's `create_reminder`, `update_reminder`, `complete_reminder`, `link_reminder`, and
`delete_reminder` call. There is no human-only or agent-only way to make, complete, or link a
reminder — one mutation path, two faces. And like every board write, a reminder mutation flows
through the single atomic, version-guarded `mutate()` store path, with the linked node's activity
log recording who did it (`reminder_linked` / `reminder_updated` / `reminder_completed` /
`reminder_unlinked`, `human` vs `agent`).
