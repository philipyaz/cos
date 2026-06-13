# The Platform API — one write seam, two faces

The board is not "the UI plus an API." The board is a **platform**, and its HTTP API is the
**single seam** through which everything writes. The Next.js UI is the *human face* of that
seam; the [`board` MCP server](mcp-servers.md) is the *agent twin* of it. Neither has a
private back door. A human dragging a card and the agent calling `update_case` resolve to the
**same route**, mutate the **same store**, and append to the **same activity log** — they
differ only in who gets the credit.

This page is the architecture of that seam: the store as single source of truth, actor
attribution and the do-not-undo contract, the approval queue, and the API presented as
resource families rather than an endpoint dump. The hierarchy that those routes operate over
is its own page ([Case hierarchy](hierarchy.md)); this one is about the *write path*.

```mermaid
flowchart TB
    H["Human<br/>(Next.js board UI)"] -->|writes attributed<br/>actor: human| API
    A["Agent<br/>(board MCP, ~60 tools)"] -->|x-actor: agent<br/>actor: agent in body| API
    API["board HTTP API<br/>app/api/*  (the single seam)"] -->|mutate&#40;&#41;| STORE
    STORE["board/data/cases.json<br/>(single source of truth)"] -->|fs.watch → SSE| SSE["/api/stream"]
    SSE -.->|event: change {version}| H
    SSE -.->|live refresh| OTHER["every other open surface"]
```

The founding tenet, stated in the [hierarchy doc](hierarchy.md#parity-rule) and enforced in
practice: **every human gesture is the visual twin of an MCP verb.** There is no human-only or
agent-only mutation. One mutation path, two faces.

## The store is the source of truth

All board state lives in one JSON document, `board/data/cases.json` — cases (all three tiers),
messages, calendar events, reminders, and priorities. The store
([`board/lib/store.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/store.ts)) is the
only module that touches that file, and it imposes five guarantees that every route inherits
for free:

- **Schema-versioned, migrate-on-read.** Every read runs the on-disk document through
  `migrate()`, which stamps the current `SCHEMA_VERSION`, back-fills defaults (a missing
  `case.domain` becomes `"work"`, an absent `kind` is a leaf `"case"`), and then a cheap
  structural sanity check. Old documents load forward without a migration step; a malformed
  read is caught and the previous good state recovered.
- **The serialized `mutate()` critical section.** Every write goes through
  `mutate(fn)`, a promise chain that runs callers strictly one-at-a-time. The whole
  `readDB → mint ids → apply → writeDB` sequence cannot interleave with another writer, so
  there are no lost updates and no duplicate ids — the chokepoint that the three-tier hierarchy
  also relies on to enforce its invariants inside the lock.
- **Atomic temp-and-rename writes.** `writeDB` serializes to a `*.tmp` file and `rename`s it
  over the live file. On POSIX a rename is atomic, so a concurrent reader sees either the whole
  old document or the whole new one — never a half-written file.
- **Rolling local snapshots.** Each write first drops a timestamped snapshot into
  `data/backups/` and copies the live file to a one-level `.bak`. Retention is generational:
  **every** snapshot from the last 36 hours, then the newest per calendar-day for 30 days.
  These are crash-safety, not durable history — durable, encrypted, off-site history is the
  separate [backup subsystem](../reference/backup.md).
- **An optimistic version guard.** A monotonic `db.version` is bumped at the *start* of every
  `mutate()`, so every route returns the literal post-write version. A write that arrives
  stamped with a stale version raises `VersionConflictError`, which the shared route helper maps
  to **HTTP 409** — the UI can refetch and retry rather than clobber an intervening change.

!!! note "Live data never leaves the machine"
    `cases.json` and its snapshots are gitignored and never committed — the local-first,
    private-by-default tenet. The committed store is empty; your board is yours.

### SSE live-refresh keeps every surface honest

Because there are many faces on one store, a write by any face must reach all the others.
[`/api/stream`](https://github.com/philipyaz/cos/blob/main/board/app/api/stream/route.ts) is a
long-lived Server-Sent-Events feed: it `fs.watch`es the data file, debounces the
snapshot/`.bak`/rename burst into a single `change` event carrying the new `version`, and a
heartbeat keeps the connection warm. The agent updates a case over MCP; the SSE fires; every
open browser tab and the strategy view refetch — no polling, no stale board.

## Actor attribution and the do-not-undo contract

Two actors write: `human` and `agent`. The face declares itself, the store records
it. `resolveActor`
([`board/lib/route-helpers.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/route-helpers.ts))
defaults to `human`; an agent write flags itself **two redundant ways** — an `x-actor: agent`
request header *and* `{ "actor": "agent" }` folded into the JSON body (added even to bodyless
writes like a soft-delete) — so attribution survives either route convention. A caller never
passes `actor` for itself; the seam stamps it.

Every mutation appends a `CaseActivity` entry stamped with that actor onto the case's
**append-only activity log** (capped to the last 50 per case). That log is the board's audit
trail — the same feed the UI filters by `human` / `agent`.

The read side is the companion. `get_case` (and `GET /api/cases/{id}`) surface the case's
human-actor activity as a leading **"Manual actions by the user (human)"** block, also returned
as a `manualActions` array. This encodes the load-bearing **do-not-undo contract**: a human's
deliberate gestures — a lane move, a task completion, a field edit, a hand-archive or restore —
are **authoritative**, and an agent must **not** revert them. When an inbound email or an
inference conflicts with a manual action, the agent **adds a note** or **proposes** the change
for approval rather than silently overwriting it. This is the discipline the
[triage skills](triage-skills.md) ride on; "never undo a manual edit" is their headline
guardrail because the platform makes the manual edits *legible* to the agent in the first place.

### The approval queue — human-in-the-loop on demand

For changes that should keep a human in the loop, the agent doesn't act — it **proposes**.

```
propose(verb, payload, summary)  →  pending queue  →  approve / reject
                                          │
                                   on approve: committed through the matching verb
```

`POST /api/pending` lands an agent-proposed mutation in the queue with its `verb` (e.g.
`update_case`, `archive`, `restore`), its `payload`, and a one-line `summary`. A human reviews
it on the board; `approve` commits it **through that same verb** (so it flows through the
identical route and attribution path), `reject` discards it uncommitted. This is the
`propose → approve → commit` loop, and it is opt-in per change — the agent uses it for anything
that warrants sign-off, and writes directly otherwise.

## The API as resource families

The seam is best understood as a handful of resource families, not a flat endpoint list. Each
mutating route runs inside `mutate()`, resolves the actor, returns the post-write `version`, and
maps `BadRequestError → 400`, `NotFoundError → 404`, `VersionConflictError → 409`.

| Family | Routes (root) | What it is / the key contract |
|---|---|---|
| **Cases** | `/api/cases`, `/api/cases/{id}` | The three-tier `Initiative / Workstream / Case` tree — all one `CASE-<n>` id space, distinguished only by `kind` + `parentId`. Hierarchy invariants (strict tree, max depth 3) are asserted inside the lock before every write that touches `kind`/`parentId`; an illegal move is a 400. See [Case hierarchy](hierarchy.md). |
| **Tasks** | `/api/cases/{id}/tasks/...` | A case's checklist; drives the card's done/total counter. Completing a task stamps `completedAt`. |
| **Notes** | `/api/cases/{id}/notes` | Freeform context attributed to its author actor — the agent's channel for observations that aren't a task or a message. |
| **Messages** | `/api/cases/{id}/messages`, `/api/messages/{id}` | Linked emails/chats (id `M-<n>`). A `url` deep-link back to the original is **validated as an absolute http(s) URL** or dropped. Linking an *outbound* message deterministically auto-derives genuine two-way correspondents as `trusted` in the [Guard](../security/guard.md) whitelist (server-side, fail-open). |
| **Reminders** | `/api/reminders`, `/api/reminders/{id}` | Lightweight nudges (id `REM-<n>`) — richer than a note (catalog labels, a short checklist, linked emails) but lighter than a case (no lanes, no hierarchy). Optionally point at **one** board node of any tier via `caseId`, the single source of truth for that link. Board-native — **no new server, port, or bridge**. |
| **Priorities** | `/api/priorities`, plus `starred` on cases | "What matters most right now," read back to ground a sweep. Two mechanisms: free-text priority notes (id `PRI-<n>`) and a `starred` pin on any node. Also board-native. |
| **Labels & bundles** | `/api/labels`, `/api/labels/bundles` | The catalog-backed taxonomy. A case write with an **unknown label id is rejected** — callers must read `list_labels` first. Bundles are themed installable packs; install is idempotent, uninstall scrubs dangling references by default. The catalog is documented in the generated [labels reference](../reference/labels.md). |
| **Calendar events** | `/api/events`, `/api/events/{id}` | Board-stored events, linkable to cases. Surfaced to the agent through the separate [`calendar` MCP](mcp-servers.md). |
| **Tree (read model)** | `GET /api/tree` | The hierarchy as a forest with per-container rollups (`doneCases/totalCases` over non-archived descendant leaves) computed by the pure selectors in [`selectors.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/selectors.ts). The strategy view, the API, and the drawer read the *same* rollup definition. Trash is hidden unless `includeArchived`. |
| **Search** | `/api/search` | One read-only seam over cases, tasks, messages, and reminders; every hit flags its `type`. **Fail-safe**: semantic ranking when the sidecar is up, transparent keyword fallback (still `200`) when it isn't. See [Semantic search](../reference/search.md). |
| **Guard proxy** | `/api/guard`, `/api/trust`, `/api/quarantine` | The board's window onto the prompt-injection [Guard](../security/guard.md): classify/scan, the trust whitelist, the quarantine, and guard config. **Fail-closed** at the security boundary. |
| **Backups** | `/api/backups` | Status and on-demand trigger for the encrypted off-site [backup](../reference/backup.md). |
| **Small surfaces** | `/api/prefs`, `/api/views`, `/api/templates`, `/api/command`, `/api/unread-count`, `/api/pending` | Board preferences (incl. the operational/strategy view toggle), saved views, case templates, the command surface, the unread counter, and the approval queue. |

!!! tip "Search before create — one card per matter"
    `GET /api/tree` and `list_initiatives` **hide Trash**, but `search` surfaces soft-deleted
    cases. The dedup discipline is therefore: run `search` (several queries) *and* `get_tree`
    before any `create_*` — a hit carrying `archivedAt` means restore-and-relink, never create a
    duplicate. The platform exposes the state; the skills enforce the rule.

## The agent surface: ~60 tools, the twin of the routes

Agents never speak HTTP directly. The [MCP servers](mcp-servers.md) — `board`, `calendar`,
`guard`, `vault` — expose roughly **60 tools** that are the agent-facing twin of these routes;
the `board` server alone wraps the full case / task / note / message / reminder / priority /
label lifecycle over `fetch`, never shelling out. Each tool maps to a route, carries the
`agent` actor, and returns what that route returns.

Three of these families are deliberately **fail-safe**: `search`, the `guard` proxy, and
`backups` return a `200` envelope even when their sidecar is down — but with opposite polarity,
the system's defining duality. **Search fails open** (sidecar down → keyword scan, still a
useful answer), because a degraded ranker is better than a dark board. **Guard fails closed**
(classifier unreachable → `UNAVAILABLE / treat as UNTRUSTED`), because a false all-clear on
attacker-controlled content is worse than no guard at all. Availability where it's safe,
refusal where it isn't — chosen per surface, not by accident.

---

**See also:** [MCP servers](mcp-servers.md) · [Case hierarchy](hierarchy.md) ·
[Triage skills](triage-skills.md) · [Prompt-injection guard](../security/guard.md) ·
[Semantic search](../reference/search.md) · [Encrypted backup](../reference/backup.md) ·
board MCP source: [`mcp/board-server/README.md`](https://github.com/philipyaz/cos/blob/main/mcp/board-server/README.md)
