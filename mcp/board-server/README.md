# board MCP server (v3.3)

A stdio MCP server (registry name **`board`**) that opens and maintains cases on the
Cos board — the single to-do surface for both **work** and **life**. Every
tool wraps the board HTTP API over `fetch` on `CRM_BASE_URL`; the server never shells
out to `curl`. Used by the router and skills so a case can be driven from the sandboxed
Cowork VM (which can't call the API directly).

The MCP is the **agent's twin** of the board UI: both write through the same HTTP API.
The UI writes are attributed to **`human`**; every write this server makes is attributed
to **`agent`** (see [Actor attribution](#actor-attribution)), so the case activity log
records who did what.

## Actor attribution

Every **write** (anything that isn't a `GET`) is attributed to the agent two ways, for
robustness against either route convention:

- an **`x-actor: agent`** request header, and
- **`{ "actor": "agent" }`** folded into the JSON body (added even to bodyless writes
  like a soft-delete `DELETE`).

The board reads either signal and stamps the resulting `activity[]` entry with
`actor: "agent"`. You never pass `actor` yourself — the server adds it.

### Manual actions (do-not-undo contract)

The read side is the companion to actor attribution. `get_case` surfaces the
case's **human-actor** activity as a leading **"Manual actions by the user (human)"**
block — the lane moves, task completions, and field edits the user made by hand —
and the HTTP `GET /api/cases/{id}` also returns a `manualActions` array. These are
the user's **deliberate** state and are **authoritative**: an agent must **not**
revert a human lane move, task completion, or field edit, and must not archive a
case the user is actively working or restore one they archived by hand. When an
email or inference seems to conflict with a manual action, **add a note** (or
**propose** the change for approval) instead of silently overwriting it.

## Tools

The server exposes the full v3 case / task / message lifecycle plus board ops, the
**v3.2** reminder enrichment (catalog `labels`, a short `tasks` checklist, and linked emails via
`link_reminder_message`; reminders are searched and each hit flags its nature), and the **v3.3**
**priorities** family (`get_priorities` reads the user's starred nodes + free-text priority notes;
`add`/`update`/`remove_priority` manage the notes; `set_starred` pins any node). `[x]` marks optional
args.

### Reads

#### `get_case(id)`
`GET /api/cases/{id}`. Loads a case's current state. Returns the case fields — including
**`domain`**, **`priority`**, **`dueAt`**, **`archivedAt`**, **`snoozeUntil`**, and linked
**vault context** pages — its tasks (status, owner, detail, `dueAt`), its **notes**, its
linked **messages**, and the **last few activity** entries. Unknown id → tool error.

#### `search(q | queries[], [k], [types], [domain], [status])`
**Semantic + keyword** search across case titles/summaries/tags/labels,
task titles, message subjects/senders/bodies, **and reminders** (title/detail/labels/task titles) —
fuzzy, not just substring. Read-only. Reminders are indexed too — **including DONE ones** (reminders
have no archive) — and each hit **flags its nature** (`case` · `task` · `message` · `reminder`) so you
can tell what matched.

- A single `q` → `GET /api/search?q=` and prints the legacy `cases` / `tasks` / `messages` block plus
  an additive **`Reminders:`** block (the three original arrays are unchanged).
- An array of `queries` → `POST /api/search` with `{ queries, k, types?, domain?, status? }`,
  printing **ranked hits per query** with a per-hit score/`why` and a dedupe footer; reminder hits
  carry a `[reminder·<status>]` nature tag. `k` is the top-K per query (default 10, max 50); `types`
  restricts to `case|task|message|reminder`; `domain`/`status` filter the case lane/side (reminders are
  exempt from the case-lane `status` filter and honour `domain` only when they carry one).
- **Search-first / dedupe:** before `create_case`, run several queries at once (the person/entity
  name, the vault entity, the topic) to find an existing case on the same matter — if a strong match comes
  back, `update_case` / `add_task` / `link_message` instead of creating a duplicate. `search`
  **surfaces Trash (soft-deleted) cases** (it defaults `includeArchived` on) — a hit carrying
  `archivedAt` means the matter was deleted: `restore_case` + `link_message` onto it, never
  `create_case`. `get_tree`/`list_initiatives` HIDE Trash, so always cross-check with `search`.
- **Fail-safe:** the route is fail-safe — with the search sidecar up you get `engine: "semantic"`;
  with it down (or no `uv`) it transparently falls back to `engine: "keyword"` (no error). An
  unreachable board surfaces as a tool error via the shared `api()` helper.

#### `list_templates()`
`GET /api/templates`. Lists the built-in case templates (e.g. a developer-tooling onboarding
doc-checklist and a generic follow-up). Read-only. Use to discover a template `id` before
`apply_template`.

#### `list_pending()`
`GET /api/pending`. Lists the approval queue — agent-proposed mutations awaiting a human
approve/reject. Read-only. Each entry has an `id`, the proposed `verb` + `payload`, a
`summary`, and a `status`.

#### `get_tree([rootId], [domain], [includeArchived])`
`GET /api/tree`. Reads the board **hierarchy** as an indented outline — `Initiative > Workstream >
Case` — with each container's rollup (`done/total` leaf cases) and child count. Read-only. Pass
`rootId` to print only that subtree. **Call this first** before creating a case/initiative/workstream
to find the right place to nest it and avoid duplicating a theme. Archived/deleted (Trash) nodes are
**hidden** unless `includeArchived` — you MUST also call `search` (which surfaces Trash) before
`create_*` to avoid duplicating a soft-deleted matter.

#### `list_initiatives([domain], [includeArchived])`
`GET /api/tree` (top level). One line per **Initiative** with its rollup and workstream/case
counts. Use to see the big themes at a glance; drill into one with `get_tree(rootId)`.
Archived/deleted (Trash) nodes are **hidden** unless `includeArchived` — cross-check with `search`
(which surfaces Trash) before `create_*` to avoid duplicating a soft-deleted matter.

### Case lifecycle

#### `create_case(title, [domain], [status], [summary], [tags], [eta], [dueAt], [startDate], [priority], [vaultLinks], [tasks])`
`POST /api/cases`. Opens a case.

- `title` **(required)**.
- `domain` — `work | life`. Defaults to **`work`**. Files the case on the right side of the board.
- `status` — board column. Defaults to `todo`. One of `urgent | todo | in_progress | waiting_for_input | done`.
- `dueAt` — **structured ISO due date** (e.g. `"2026-06-15"` or a full ISO timestamp). This is the
  sortable/filterable deadline, **distinct from the free-text `eta`**.
- `priority` — `P0 | P1 | P2 | P3` (triage; distinct from the `urgent` lane).
- `vaultLinks` — array of vault page **titles** exactly as they appear inside `[[...]]` wikilinks, e.g. `["Acme Ltd", "Jane Doe"]`.
- `tasks` — array of `{ title, detail?, status?, owner?, dueAt? }`; each task defaults to status `open`.
- Returns the created case id, domain, status, priority, due date, task count, vault links, and board URL.

#### `update_case(id, [title], [summary], [status], [domain], [tags], [eta], [dueAt], [startDate], [priority], [snoozeUntil], [vaultLinks])`
`PATCH /api/cases/{id}`. Updates fields and/or moves the card between columns. Pass only the
fields you want to change. `status` moves the card to a new lane; `domain` refiles between
`work` / `life`; `dueAt`/`priority` change the deadline/triage; `vaultLinks` **replaces** the
linked vault page titles; `snoozeUntil` hides the card until a date.

#### `update_cases(ids, patch)`
`PATCH /api/cases`. **Bulk** update: applies one `patch` object to every id in `ids`. Use for
sweeps (re-prioritise a batch, move several cards to a lane, refile a group). Activity is
logged per case.

#### `archive_case(id)`
`DELETE /api/cases/{id}` (soft). Sets `archivedAt` and hides the card from the default board —
**nothing is destroyed**. Archived ≠ done. Undo with `restore_case`.

#### `restore_case(id)`
`PATCH /api/cases/{id} { archivedAt: null }`. Clears `archivedAt` so the case returns to the
board. The inverse of `archive_case`.

#### `delete_case(id)`
`DELETE /api/cases/{id}`. A **soft delete (Trash)**: sets `archivedAt`, hides the case from the
default board, and is fully restorable with `restore_case` — identical wire behaviour to
`archive_case`. Nothing is destroyed by this verb; **permanent removal happens automatically** via
the lazy retention sweep once `archivedAt` is older than the configured window
(`config/settings.json` `trashRetentionDays`, default 30; env `COS_TRASH_RETENTION_DAYS` overrides),
which purges the case and its emails **except** any email still referenced by a reminder or a
surviving case. There is no hard-delete flag (the old "keep but unlink" path orphaned emails and
caused re-triage to duplicate cases).

#### `apply_template(id, [overrides])`
`POST /api/templates { id, overrides? }`. Creates a new case from a built-in template (see
`list_templates`). `overrides` are merged onto the template (e.g. `{ title, domain, priority, dueAt }`).
Goes through the same create path as `create_case`.

### Hierarchy — Initiatives & Workstreams

The board is a three-tier tree. **All three tiers are `CaseRecord`s** in one `CASE-<n>` id space —
they differ only by `kind` + `parentId`, so the whole lifecycle (tasks, notes, labels, vaultLinks,
messages, archive, search) works at every tier.

| Tier | `kind` | Parent rule |
|---|---|---|
| **Initiative** (Epic) | `initiative` | a root — **no** parent |
| **Workstream** (Sub-Epic) | `workstream` | **must** sit under an Initiative |
| **Case** (Issue) | `case` (absent) | optional — under an Initiative or Workstream, else standalone |

A strict tree of **max depth 3** (no leaf-as-parent, no cycles). The board enforces these invariants
on every write and **rejects an illegal move with a 400** (e.g. a workstream with no initiative, a
case under a case, an initiative given a parent). `create_case` and `update_case` also accept `kind`
and `parentId` (pass `parentId: null` on update to detach a leaf to top-level).

**Nesting discipline:** prefer a **standalone Case** for an orphan one-off; nest **under an existing**
Initiative/Workstream when the matter belongs to one; open a **new Initiative** only for a genuinely
new multi-stream theme. Call `get_tree` / `search` first.

#### `create_initiative(title, [domain], [summary], [vaultLinks], [labels], [tags], [dueAt], [priority])`
`POST /api/cases { kind: "initiative" }`. Opens a top-tier Initiative (a root). Use only for a new
multi-stream theme (e.g. "Build DevForge", "Get healthy").

#### `create_workstream(title, initiativeId, [domain], [summary], [vaultLinks], [labels], [tags], [dueAt], [priority])`
`POST /api/cases { kind: "workstream", parentId: initiativeId }`. Opens a Workstream **under** an
Initiative. `initiativeId` **(required)** must reference an existing initiative.

#### `set_parent(id, parentId)`
`PATCH /api/cases/{id} { parentId }`. Re-parents a single node under a container, or pass
`parentId: null` to **detach a leaf Case** to top-level. (Detaching a Workstream is illegal — convert
it to an Initiative with `update_case { kind: "initiative" }` instead.)

#### `regroup_cases(ids, parentId)`
`PATCH /api/cases { ids, patch: { parentId } }`. **Groups several cases under one** Initiative or
Workstream in a single sweep — the headline "organise these cases" verb. `parentId: null` detaches
them all. If **any** id would violate the tier rules the **whole batch is rejected** (400).

### Tasks

#### `add_task(id, title, [detail], [status], [owner], [dueAt])`
`POST /api/cases/{id}/tasks`. Appends a task (drives the card's done/total counter). Defaults to
status `open`. `dueAt` sets a per-task ISO deadline.

#### `update_task(id, taskId, [title], [detail], [status], [owner], [dueAt])`
`PATCH /api/cases/{id}/tasks/{taskId}`. Updates a task. Setting `status` to `done` stamps
`completedAt`.

#### `complete_task(id, taskId)`
Sugar for `update_task` with `status: "done"` → `PATCH /api/cases/{id}/tasks/{taskId}`.

#### `delete_task(id, taskId)`
`DELETE /api/cases/{id}/tasks/{taskId}`. Hard-removes a task from the checklist (not a
completion — prefer `complete_task` when the work is actually done).

### Notes

#### `add_note(id, body)`
`POST /api/cases/{id}/notes`. Appends a freeform note to the case (attributed to the agent). Use
for context/observations that aren't a task or a message.

### Messages

#### `link_message(id, source, from, [subject], [preview], [body], [receivedAt], [read], [to], [cc], [outbound], [url])`
`POST /api/cases/{id}/messages`. Creates a message (id `M-<n>`), sets its `caseId`, and pushes its
id onto the case's `messageIds`.

- `source` **(required)** — `gmail | jira | agent | client | system`.
- `from` **(required)** — an email address, name, or system id.
- `receivedAt` defaults to now; `read` defaults to `false`.
- `to` — recipient addresses (`string[]`); `cc` — cc addresses (`string[]`).
- `outbound` — `boolean`, **TRUE only for the user's own sent mail** (set from the Gmail SENT scan,
  never inferred from `from`). Linking an **outbound** message auto-derives its genuine two-way
  correspondents as `trusted` in the guard whitelist (deterministic, server-side; best-effort,
  fail-open). The rule is tight: an address is trusted iff it both wrote in (an inbound `from`) and
  the user replied to it (it's in an outbound `to`), or it is the **sole** `to` of a 1:1 outbound
  with no Cc. **Cc is never auto-trusted.** Cross-ref [Guard](../../docs/security/guard.md).
- `url` — the direct **deep-link back to the ORIGINAL message** so the board/UI can jump straight to
  it; for Gmail pass the thread URL `https://mail.google.com/mail/u/0/#all/<threadId>` (`u/0` is the
  signed-in account index). The board **validates it as an absolute http(s) URL** and stores it only
  if it passes (anything else is dropped).

#### `update_message(id, [read], [caseId], [url])`
`PATCH /api/messages/{id}`. Updates an existing message. `read` flips the read flag; `caseId`
links/relinks the message to a case (both sides — the case's `messageIds` and the message's
`caseId` — are maintained server-side). `url` sets the **deep-link back to the original message**
(the Gmail thread URL form), or pass `url: null` to **clear** it; the board **validates it as an
absolute http(s) URL** and stores it only if it passes.

### Reminders

A **reminder** is a lightweight **nudge** — "remember to CHECK / DO something" — for a minor matter
that doesn't justify a full **case** (no kanban lanes, no hierarchy of its own). It is **richer than a
bare note**, though: a reminder may carry catalog **`labels`**, a SHORT **`tasks`** checklist (concise
`{ title, done }` items — NOT full Tasks), and **linked emails** — attach a multitude of emails about
**one matter** (e.g. a billing issue) to **one** reminder via `link_reminder_message`
(`message.reminderId` is the **single source of truth** for that link; a message may link to a case
**and/or** a reminder). It can also optionally point at **one** board node it concerns via **`caseId`**
— the id of **any** tier (Initiative / Workstream / Case, all one `CASE-<n>` id space), the **single
source of truth** for the node↔reminder link (the node lists its reminders by filtering on it; there is
no `reminderIds[]` on the case). `status` is one of `open | done | dismissed`.

Reminders **ride the board MCP/API** (`/api/reminders`) — there is **no new server, port, bridge,
or `.mcp.json` change**: they're board-native sub-resources alongside cases/tasks/notes/messages.

> **Prefer-linking guardrail (`create_reminder` / `link_reminder`):** this agent ALSO has the board
> case tools, so **before** creating a reminder, run `search` (several queries) **and** `get_tree`
> first to find the Initiative/Workstream/Case the reminder concerns. If a node matches, set `caseId`
> so that node lists the reminder; if nothing matches, create it **standalone** (omit `caseId`).

#### `create_reminder(title, [detail], [status], [dueAt], [domain], [caseId], [labels], [tasks])`
`POST /api/reminders`. Opens a lightweight nudge.

- `title` **(required)** — the nudge itself, e.g. `"Check the trip dates against the Tech Deep Dive dates"`.
- `status` — `open | done | dismissed`. Defaults to **`open`**.
- `dueAt` — ISO date (`"2026-06-15"`) or full ISO datetime — when to be reminded / when the check is due (the sortable signal).
- `domain` — `work | life` (optional/advisory; may mirror the linked node's domain).
- `caseId` — OPTIONAL link to **any** tier node (e.g. `"CASE-3"`). A `caseId` that doesn't exist is rejected (400). See the prefer-linking guardrail above.
- `labels` — catalog label ids; **call `list_labels` FIRST** — unknown ids are **rejected** (400).
- `tasks` — a SHORT checklist of `{ title, done? }` items (the store mints each id `REM-<n>-T<k>` — never pass an id on create).
- Returns the created `REM-<n>` id, status, due/domain, labels, task progress, and whether it's linked or standalone.

#### `list_reminders([status], [caseId], [domain])`
`GET /api/reminders`. Lists reminders, **one compact line each** (`status · due · title · linked caseId`,
plus ` · <done>/<total> tasks` when the reminder has a checklist). Read-only. Filter by `status`, by the
linked `caseId` (to see a node's reminders), and/or `domain`.

#### `get_reminder(id)`
`GET /api/reminders/{id}`. Loads one reminder by id (e.g. `"REM-1"`): its title, status, detail,
`dueAt`, `domain`, **catalog `labels`**, its **`tasks`** checklist (rendered `done/total` + `[x] / [ ]`
lines), its **linked messages** (`[source] from — subject`), plus the node it's linked to (`caseId`)
or that it's standalone. Read-only.

#### `update_reminder(id, [title], [detail], [status], [dueAt], [domain], [caseId], [labels], [tasks])`
`PATCH /api/reminders/{id}`. Updates a reminder. Pass only what you want to change. Setting `status`
to `done` stamps `completedAt`. Pass `caseId: null` to **unlink** it to standalone. `labels`
**replaces** the catalog labels (call `list_labels` first — unknown ids rejected); `tasks`
**replaces** the checklist (keep an existing `{ id, title, done }` row to retain it, omit `id` to add a
new one — the store mints `REM-<n>-T<k>`).

#### `complete_reminder(id)`
`PATCH /api/reminders/{id} { status: "done" }`. Sugar for "I did/checked it" (also stamps `completedAt`).

#### `link_reminder(id, [caseId])`
`PATCH /api/reminders/{id} { caseId }`. Attaches the reminder to the node it concerns (any tier), or
pass `caseId: null`/empty to **unlink** it to standalone. Sugar over `update_reminder`'s `caseId`; the
same prefer-linking guardrail applies — find the node with `search` + `get_tree` first.

#### `link_reminder_message(id, source, from, [subject], [preview], [body], [receivedAt], [read], [url])`
`POST /api/reminders/{id}/messages`. Creates a message (id `M-<n>`) and sets its **`reminderId`** to
this reminder (the **single source of truth** for the reminder↔email link). Mirrors `link_message` but
targets a reminder — attach **many** emails about **one matter** (e.g. a billing notice) to **one**
reminder. A message may link to a case **and/or** a reminder (the two links are independent). The
reminder must exist (unknown id → tool error).

- `source` **(required)** — `gmail | jira | agent | client | system`.
- `from` **(required)** — an email address, name, or system id.
- `receivedAt` defaults to now; `read` defaults to `false`.
- `url` — the direct **deep-link back to the ORIGINAL message** (for Gmail, the thread URL
  `https://mail.google.com/mail/u/0/#all/<threadId>`); the board **validates it as an absolute http(s)
  URL** and stores it only if it passes.

#### `delete_reminder(id)`
`DELETE /api/reminders/{id}`. **Hard-removes** the reminder (reminders have no soft-archive). Prefer
`complete_reminder` / status `dismissed` when the nudge is simply resolved.

### Priorities

**Priorities** are "what matters most right now." Two complementary mechanisms, both **read back** by
`get_priorities` so the agent can **align** its work and triage to the user's stated focus:

1. **Star a node** — a favorite/pin toggle on **any** case / workstream / initiative (all three tiers
   share one `CASE-<n>` id space). `set_starred` flips it; starred nodes surface in `get_priorities`
   and on the Priorities page. Starring is just `PATCH /api/cases/{id} { starred }`.
2. **Priority notes** — free-text "top of mind" items in the user's **own words** (id `PRI-<n>`), a
   NEW lightweight entity — **lighter than a reminder** (no status, link, tasks, or labels).
   `add`/`update`/`remove_priority` manage them at `/api/priorities`.

Priorities **ride the board MCP/API** — there is **no new server, port, bridge, or `.mcp.json`
change** (exactly like reminders).

#### `get_priorities()`
`GET /api/priorities`. Reads **what the user cares about most** — their **starred** nodes (cases /
workstreams / initiatives, one line each: `id [tier] title — lane`) **plus** their free-text
**priority notes** (`PRI-<n> — text`, the user's own words). Read-only. Call this to ground a sweep or
a plan in the user's stated priorities before acting; says so explicitly when both lists are empty.

#### `add_priority(text, [position])`
`POST /api/priorities`. Adds a free-text priority note in plain words (e.g. `"Close the Acme deal this
week"`). `text` **(required)**. `position` is an optional manual rank (smaller = higher priority; omit
to sort last). Returns the created `PRI-<n>` id.

#### `update_priority(id, [text], [position])`
`PATCH /api/priorities/{id}`. Updates a priority note's `text` and/or its manual `position`. Pass only
what you want to change (at least one). Empty/whitespace `text` is rejected.

#### `remove_priority(id)`
`DELETE /api/priorities/{id}`. **Hard-removes** a priority note (no soft-archive). Use when the user
no longer wants it on their list.

#### `set_starred(id, starred)`
`PATCH /api/cases/{id} { starred }`. Stars (`starred: true`) or unstars (`false`) **any** node — a
case, workstream, or initiative. The star is the user-facing **favorite/pin**: starred nodes surface
in `get_priorities` and on the Priorities page.

### Labels (taxonomy config)

A **label** is a catalog-backed category — the configurable taxonomy that organises cases, richer
than the freeform `tags` string. Cases (and reminders) carry a `labels` array of catalog **ids**, and
the board **rejects an unknown id** on a case write — so a skill **must call `list_labels` first**,
choose ids whose descriptions match the case, then set them via `create_case` / `update_case` /
`update_cases`. These four tools read and configure the catalog itself; they are config ops, not case
writes.

#### `list_labels()`
`GET /api/labels`. Lists the **active** label catalog, one line each — `id — title: description
[bundle]`. The description tells you **when** the label applies. Read-only. **Always call this before
setting `labels`** on a case (unknown ids are rejected). An empty catalog prints a hint to install a
bundle first.

#### `list_label_bundles()`
`GET /api/labels/bundles`. Lists the built-in installable **bundles** — themed packs of labels for a
role (`manager`, `sales`, IT, developer-tooling, …), a life area (health, travel, finance, …), or the
universal cross-cutting set. Read-only. Each line shows the bundle `id`, `[category/domain]`, name,
label count, how many of its labels are **already installed** (owned), and its description. Use to
discover a bundle id before `install_label_bundle`.

#### `install_label_bundle(bundleId)`
`POST /api/labels/bundles { bundleId }`. Installs a bundle's labels into the active catalog —
**idempotent** (labels already present are skipped). `bundleId` **(required)**, from
`list_label_bundles` (e.g. `'manager'`). Returns the ids actually added and the new catalog size.

#### `uninstall_label_bundle(bundleId, [scrub])`
`DELETE /api/labels/bundles/{bundleId}` (the inverse of install). Removes the labels the bundle
**owns** from the catalog; labels shared with another installed bundle, and custom labels, are kept.
`bundleId` **(required)**. By default the removed ids are also **stripped from any cases** that use
them; pass `scrub: false` to keep those (now dangling) references (`?scrub=0`). Returns the removed
ids, how many cases were scrubbed, and the new catalog size.

### Approval queue

#### `propose(verb, [target], payload, summary)`
`POST /api/pending`. Proposes a board mutation for human approval instead of doing it directly.
Lands in the pending queue; on approve it is committed through the matching `verb`. `verb` is the
board verb to run (e.g. `update_case`, `move`, `archive`, `restore`), `payload` its arguments,
`summary` a one-line human-readable description.

#### `approve(pendingId)`
`POST /api/pending/{id} { decision: "approve" }`. Commits a pending proposal through its verb and
marks it approved.

#### `reject(pendingId)`
`POST /api/pending/{id} { decision: "reject" }`. Marks a pending proposal rejected; it is never
committed.

## Config

`CRM_BASE_URL` — base URL of the board. Default `http://localhost:3000`.

## Install

```bash
cd mcp/board-server && npm install
```

## `.mcp.json` entry (registry name: `board`)

In this repo the committed `.mcp.json` (Claude Code) is **generated** from
`mcp/board-server/board.service.json` by `scripts/gen-mcp-json.mjs`, the macOS launchd bridge plist
by `scripts/gen-launchd.mjs`, and the Cowork direct-stdio entry by `scripts/gen-cowork-config.mjs`
(see [`mcp/CLAUDE.md`](../CLAUDE.md) and the `/mcp-bridge-setup` skill). The blocks below show what
those generators produce.

### Option A — Cowork VM via supergateway (the sandboxed setup)

The VM can't run stdio servers or call the API directly, so front this server with
supergateway on the host. Add to your `start-mcp-servers.sh` (the board bridge port = 8001):

```bash
# start-mcp-servers.sh  (run on the host, outside the sandbox)
CRM_BASE_URL=http://localhost:3000 \
  supergateway --stdio "node /ABSOLUTE/PATH/TO/mcp/board-server/server.mjs" \
  --port 8001 --baseUrl /mcp &
```

Keep it alive with pm2:

```bash
pm2 start start-mcp-servers.sh --name mcp-bridge
pm2 save
```

Point `.mcp.json` at the bridge:

```json
{
  "mcpServers": {
    "board": { "type": "streamable-http", "url": "http://localhost:8001/mcp" }
  }
}
```

### Option B — local stdio (no supergateway, for testing on your own machine)

Claude Code spawns the server itself over stdio (this is the default in this repo's `.mcp.json`):

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["./mcp/board-server/server.mjs"],
      "env": { "CRM_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

## Verify

With the board dev server running (`npm run dev` on :3000):

```bash
cd mcp/board-server && node test-client.mjs
```

It spawns the server over stdio, lists tools, then exercises the full v3 lifecycle —
`create_case` (with `domain`, `tasks`, `dueAt`, `priority`, and `vaultLinks`) → `get_case`
→ `add_task` → `complete_task` → `update_case` (move lane) → `add_note` → `link_message`
→ `archive_case` → `restore_case` → `search` → `get_case` again — printing each result and
its `isError` flag, plus a negative (missing-title) check. The `CASE` id is parsed from the
create result, never hardcoded.
