# tests/ — golden fixtures + invariants (SPEC §9)

The chief-of-staff loop is an autonomous LLM writing to two persistent stores
(the **vault** and the **board**). This suite is the deliberately-minimal safety
net from **SPEC §9**: a small corpus of golden fixtures asserted on **structure,
not prose**, plus property-test lints — all run against a **throwaway copy**,
never live data.

## The validation model

### 1. Golden fixtures + invariants (assert structure, not prose)

LLM output varies run-to-run, so we never diff prose. Each fixture is a
representative input paired with the **structural outcome** it must produce —
expressed as machine-checkable invariants:

| Fixture | Input | What it pins down |
|---|---|---|
| `voice-note-marco` | OpenWhispr transcript: follow up with Marco on the co-maintainer talk | a source page exists for the transcript; the `[[Marco Rivera]]` entity page links a board case; a case sits in domain **work**, lane **todo/urgent**; the case's `vaultLinks` include `"Marco Rivera"`; **no duplicate** case for the thread (reuse CASE-1) |
| `email-velastack` | Gmail message on the open VelaStack matter | the **existing** VelaStack case is **updated** — message linked, **not** a new case; case stays domain **work** / active lane; VelaStack `vaultLinks` retained; vault context for VelaStack updated |

Each `*.expected.json` lists invariants of a small, fixed vocabulary so they stay
machine-checkable:

- `page-exists` — a vault page exists in a given `wiki/` section.
- `entity-links-case` — an entity/concept page reciprocates a board case link
  (case `vaultLinks` ↔ vault `cases:` frontmatter).
- `case-in-domain-lane` — a case exists in the expected `domain` + one of `lane_in`.
- `vaultLink-present` — a case's `vaultLinks` array contains a given title.
- `message-linked` — a message is linked onto a case (both directions).
- `no-duplicate-thread` — exactly one case covers a thread (dedup / entity-resolution).

These map 1:1 to the routing contract: **knowledge → vault**, **action → board**,
**most inputs produce both, cross-linked**, **idempotent + de-duplicated +
entity-resolved**.

> **Every manual correction becomes a new fixture.** When the user fixes a
> routing mistake the loop made, drop a new `<name>.md` + `<name>.expected.json`
> here so the same mistake can't regress. The corpus compounds from real use,
> exactly as the knowledge base does.

### 2. Property-test lints

Two lints replace per-case golden diffs with invariants that must always hold:

- **`board-lint.mjs`** (this dir) — the board's structural invariants (below).
- **`second-brain-lint`** (the skill) — the vault's invariants: no orphan pages,
  no contradictions, no stray task checkboxes, broken-wikilink scan. `run.sh`
  bundles two grep-based slices of it (no `- [ ]` inside `wiki/`; no open
  `- [ ]` left in `life|work/reminders` once drained to the board).

### 3. Throwaway copy

`run.sh` `mktemp -d`s a sandbox, copies in `board/data` (enough to lint) and the
whole `vault/`, and runs every check against the **copy**. The live
`board/data/cases.json` and the live vault are never read for mutation and never
written. The runner echoes the sandbox path and that it is a throwaway copy.

### 4. Convergence criterion

Borrowed verbatim from SPEC §9 — the measurable "good enough" bar:

> The loop **has converged** when **golden fixtures pass**, **vault + board lint
> are clean**, and over the last **K** real cycles the user made **≤ N manual
> corrections**. Below the bar → tune the router prompt / schema. At or above →
> leave it alone. Every manual correction becomes a new fixture.

### 5. Concurrency safety (live board)

The board has **multiple concurrent writers** by design — UI clicks, the `board`
MCP, and overlapping voice/mail/calendar scheduled tasks all hit the same
read-modify-write JSON store. `concurrency.mjs` is the regression guard for the
store mutex (`board/lib/store.ts` `mutate()`): it fires **N parallel** `create_case`
and N parallel `add_task` at a **running** board and asserts no lost writes and no
duplicate ids (case count grows by exactly N; all case/task ids unique). It
snapshots and restores `board/data/cases.json`, so the live board is left exactly
as found. `run.sh` runs it as step **[4]** only when a board is reachable at
`CRM_BASE_URL`; otherwise it is **skipped** (so the suite stays headless).

### 6. API lifecycle (live board)

`api-lifecycle.mjs` is the end-to-end guard for the **v3 HTTP API** — the single
mutation path that both the UI and the `board` MCP funnel through. It drives a
**running** board through the full lifecycle of a case and asserts the contract
holds at each step:

- **create_case (+`dueAt`)** → the create response carries the **bumped** `db.version`,
  *and* a re-read shows the persisted `version` advanced.
- **add_task → delete_task** → the task is added, shows on the case, then removed.
- **add_note** → the note lands in `case.notes`.
- **PATCH move lane** → the lane move takes effect *and* appends an `activity` entry.
- **expectedVersion mismatch** → a stale `expectedVersion` is rejected with **409**.
- **GET `/api/search?q=`** → finds the created case by a unique marker.
- **archive (soft `DELETE`)** → sets `archivedAt` and the case **drops from the
  default `GET /api/cases` list**.
- **restore (`PATCH { archivedAt: null }`)** → the case comes **back** into the list.
- **link_message (+`url`)** → a linked message's `url` deep-link round-trips on the case
  GET; `PATCH /api/messages/:id` retargets then clears it; an invalid `url` → **400** on
  both the link (POST) and the update (PATCH).

> **No `merge` here.** `merge_cases` is a `board` **MCP** tool, not a board HTTP route —
> `api-lifecycle.mjs` asserts no merge contract. The route→derive→push wiring that a
> merge triggers is covered by `api-trust-derive.mjs` (§11b in `run.sh`).

Like `concurrency.mjs` it snapshots `board/data/cases.json` and restores it in a
`finally`, so the run is **net-zero**. It prints **✓/✗ per check**, exits non-zero
on any failure, and prints a clear "is the board running?" message when no board is
reachable. `run.sh` runs it as step **[5]** only when a **healthy** board (a `2xx`
from `GET /api/cases`) is reachable; otherwise it is **skipped** (not failed) — a
half-built board returning `5xx` during a parallel build is skipped, keeping the
suite headless and honest.

### 7. Unit tests (pure logic — headless)

`board-lint`/`concurrency`/`api-lifecycle` assert the board *as data* or *over
HTTP*; the `unit/` suite instead exercises the **pure functions** that compute
that data directly — the read-projection engine (`selectors.ts`), the store
helpers (`store.ts`: migrate, id-minting, `apply*Update`, the
50-entry activity cap), the formatters (`format.ts`), and the **calendar-event
selectors** (`selectors.ts`: `eventsByCaseId` / `eventsForDay` / `eventsByDateRange`
/ `upcomingEvents` / `monthGrid` / `todayISO`). These previously had no unit
coverage despite being the most edge-case-dense code in the repo.

The files import the live `board/lib/*` modules but only run pure functions on
**in-memory object-literal fixtures** — they never read or write `board/data` — so
they run against the repo (not the sandbox copy) and stay deterministic by
**injecting a fixed `now`** into every time-relative function.

The lib modules use extensionless relative imports (`./types`) that Node's ESM
resolver won't follow on its own, so `unit/ts-resolve.mjs` registers a tiny
**zero-dependency** resolve hook that retries such specifiers with a `.ts` suffix;
Node ≥ 22 strips the TypeScript types itself. `run.sh` runs the whole suite as the
first, headless **hard gate** (step **[1]**); on Node < 22 it is **skipped** (not
failed) so the rest of the suite still runs.

### 8. API search (live board)

`api-search.mjs` is the end-to-end guard for the **search API**
(`board/app/api/search`) — both the back-compat keyword **GET** and the new
fail-safe semantic **POST**. It seeds a marker case and asserts:

- **GET `?q=`** → the HARD `{ cases:[], tasks:[], messages:[] }` shape (empty q ⇒
  three empty arrays); `?q=<marker>` finds the case with the shape preserved.
- **POST `{ queries, k }`** → the batch envelope: `results` echoes each query in
  order, `hits` respect `k`, and `merged.cases` (rebuilt server-side from the
  in-hand db) contains the marker.
- **POST with no `queries`/`q`** → **400**.
- **Graceful degradation as a PROPERTY** — GET and POST are **always `2xx`** (never
  `5xx`) and still find the marker, whether the sidecar is **up** (`engine:"semantic"`)
  or **down** (`engine:"keyword"`). The test never asserts the sidecar's state, so
  it passes in **both** modes (CI default = sidecar down). This is the load-bearing
  fail-safe invariant: the board searches with **no sidecar and no uv**.

Like the other live checks it snapshots `board/data/cases.json` and restores it in
a `finally` (net-zero). `run.sh` runs it as step **[8]** only when a **healthy**
board is reachable; otherwise it is **skipped** (not failed).

### 9. API events (live board)

`api-events.mjs` is the end-to-end guard for the **v4 calendar-events API**
(`board/app/api/events` + `…/events/[id]`) — the create/list/patch/link/delete
path for `CalendarEvent`s (which live in `db.events`, persisted in `cases.json`).
It drives a **running** board and asserts the contract using OUR field names:

- **create_event (`allDay`)** → **201**; the event id matches `EVT-<n>` and the
  create response carries the **bumped** `version` (a re-read confirms it advanced).
- **GET `/api/events`** → **200**, `events` is an array carrying the created id; the
  **`from`/`to`** window (half-open `[from, to)`) and the **`caseId`** filter narrow
  correctly.
- **PATCH `/api/events/:id` `{ title, description }`** → **200**, persisted on a
  re-GET, `version` bumps.
- **link flow** → an event created with `caseId` set to a **real** existing case id
  sticks the link, and the case `GET /api/cases/:id` lists the event in its
  **`events`** array (`event.caseId` is the link's single source of truth).
- **validation** → `caseId:"CASE-99999"` → **400** (error mentions the case);
  missing `title` → **400**; `date:"nonsense"` → **400**; `{ allDay:false,
  startTime:"9am" }` → **400** (bad `HH:MM`).
- **DELETE `/api/events/:id`** → **200**; the id no longer appears in `GET /api/events`.

Like the other live checks it snapshots `board/data/cases.json` and restores it in
a `finally` (net-zero). `run.sh` runs it as step **[9]** only when a **healthy**
board is reachable; otherwise it is **skipped** (not failed).

### 10. API reminders (live board)

`api-reminders.mjs` is the end-to-end guard for the **v5 reminders API**
(`board/app/api/reminders` + `…/reminders/[id]`) — the create/list/patch/link/delete
path for `Reminder`s (lightweight nudges which live in `db.reminders`, persisted in
`cases.json`). It drives a **running** board and asserts the contract using OUR field
names:

- **create reminder (`{ title, detail, status:"open" }`)** → **201**; the reminder id
  matches `REM-<n>` and the create response carries the **bumped** `version` (a re-read
  confirms it advanced).
- **GET `/api/reminders`** → **200**, `reminders` is an array carrying the created id;
  the **`status`** / **`caseId`** / **`domain`** filters narrow correctly.
- **PATCH `/api/reminders/:id` `{ detail }`** → **200**, persisted on a re-GET, `version`
  bumps; a **PATCH `{ status:"done" }`** sets a `completedAt` and on re-GET the status is
  `"done"`.
- **link flow** → a reminder created with `caseId` set to a **real** existing case id
  sticks the link, and the case `GET /api/cases/:id` lists the reminder in its
  **`reminders`** array (`reminder.caseId` is the node↔reminder link's single source of
  truth); a **PATCH `{ caseId: null }`** unlinks it (the case GET no longer lists it).
- **validation** → `caseId:"CASE-99999"` → **400** (error mentions the case); missing
  `title` → **400**; `status:"banana"` → **400**; `dueAt:"nonsense"` → **400**.
- **DELETE `/api/reminders/:id`** → **200**; the id no longer appears in
  `GET /api/reminders`.

Like the other live checks it snapshots `board/data/cases.json` and restores it in a
`finally` (net-zero). `run.sh` runs it as step **[10]** only when a **healthy** board is
reachable; otherwise it is **skipped** (not failed).

### 11. API trust whitelist (live board + guard sidecar)

`api-trust.mjs` is the end-to-end guard for the **guard sender-trust WHITELIST API**
as exposed by the board's thin **PROXY** routes (`board/app/api/trust` +
`…/trust/[email]`) — which proxy the guard **sidecar** on `127.0.0.1:8009`
(`COS_GUARD_URL`). It is the management surface behind **Settings > Whitelist**. It
drives a **running** board and asserts the contract the UI consumes:

- **GET `/api/trust`** → **always `200`** with the render-ready
  `{ online, senders, count, guardUrl }` shape. When `online:false` (the sidecar is
  down — legitimately possible in CI) the test **SKIPs** the lifecycle gracefully
  (clear message, exit `0`), so it passes whether or not the guard sidecar is up.
- **POST `/api/trust` `{ email }`** → **`200` `{ record }`**, `record.trust == "trusted"`
  (the default tier); the upsert stamps a `provenance` audit line.
- **GET `/api/trust`** → now lists the sender (keyed by the lowercased email).
- **POST again `{ trust:"blocked" }`** → flips the tier **in place**; a re-GET shows the
  persisted `"blocked"`.
- **POST `{ trust:"unknown" }`** → **`400`** (you **DELETE** to clear a sender; `"unknown"`
  is the implicit absent tier, never a persisted write).
- **POST `{ }` / `{ email:"not-an-email" }`** → **`400`** (email required + a basic shape,
  rejected before it ever reaches the sidecar).
- **DELETE `/api/trust/{email}`** → **`200` `{ email, removed:true, trust:"unknown" }`**;
  a final GET no longer lists the sender.

Unlike the other live checks there is **no `cases.json` to snapshot** — the whitelist
lives in the **sidecar** (`guard/data/trusted-senders.json`), not in the board's data
file. Net-zero is achieved instead with a **unique throwaway email**
(`cos-trust-test+<pid>-<ts>@example.test`) that is removed in a `finally`, leaving the
live whitelist exactly as found. `run.sh` runs it as step **[11]** only when a
**healthy** board is reachable; otherwise it is **skipped** (not failed).

### 12. Guard quarantine release / replay (live guard sidecar)

`guard-quarantine-release.mjs` is the end-to-end guard for the quarantine
**RELEASE / REPLAY** contract — "**Release re-admits a quarantined email to triage**".
Unlike `api-trust.mjs` (which drives the trust whitelist through the board **proxy**),
this test drives the **guard sidecar** (`:8009`, `COS_GUARD_URL`) **directly**, because
the release/replay source of truth lives entirely in the sidecar: the quarantine store,
the release→trust side-effect, and the `GET /quarantine/released` queue that the MCP
`get_released_emails` / `mark_email_replayed` tools call. It seeds **flagged** records
(a strong injection sample that flags under **both** the real Prompt-Guard model and the
heuristic fallback) and asserts:

- **(a) Release ≠ dismiss** — `PATCH /quarantine/{id} { status:"released" }` flips the
  status **and** upserts the record's sender into the **trust** store as `"trusted"`
  with `if_absent` (a re-`GET /trust/{sender}` now reads `"trusted"`); a second record
  `PATCH`ed `{ status:"dismissed" }` flips status but leaves its sender `"unknown"` —
  **dismiss is inert** (no trust write).
- **(b) Released queue + replay flag** — `GET /quarantine/released` lists records where
  `status=="released" && replayed!=true` (the released record appears; the dismissed one
  does **not**). After `PATCH { replayed:true }` the record **drops off** the queue.
- **(c) Thread linkage** — `POST /scan { …, threadId }` on flagged content stores
  `threadId` on the created record (`GET /quarantine/{id}.threadId`), and the
  released-queue row for that record **exposes `threadId`** so the replay loop can
  re-admit the Gmail thread.

There is **no `cases.json` to snapshot** — the quarantine + trust stores live in the
**sidecar** (`guard/data/*.json`). Net-zero is achieved instead with **unique throwaway
senders/subjects** (so the content-hash ids can never collide with a real record) that
are `DELETE`d — both the minted quarantine ids and the throwaway trust senders — in a
`finally`, leaving both sidecar stores exactly as found. The test **SKIPs gracefully**
(exit `0`) when the sidecar's `/healthz` is unreachable (no `:8009` in CI), mirroring
`api-trust.mjs`'s `online:false` skip; `run.sh` runs it **unconditionally** as step
**[12]** (it self-skips when the sidecar is down).

### 12c. MCP server lifecycle (headless — no board / LLM / key)

Two stdio MCP tests run without a live board, an LLM call, or a key — they spawn a server
process directly and speak newline-delimited JSON-RPC to it:

- **`api-vault.mjs`** (`run.sh` step **[13b]**) drives the **vault** server's pre-agent contract
  (initialize → `serverInfo.name=="vault"`; `tools/list` = exactly `{ingest, query}`;
  `ingest{content:""}` and `ingest{files:["/etc/passwd"]}` → `isError` validation), so no Agent
  SDK call is made and no `ANTHROPIC_API_KEY` is needed.
- **`mcp-kit-idle.mjs`** (`run.sh` step **[13b2]**) is the regression guard for the shared
  child-lifecycle contract in `packages/mcp-kit/index.mjs` `start()`. Spawning the **board**
  server (mcp-kit + only `@modelcontextprotocol/sdk`) it asserts: the idle-exit is **off by
  default** (a long-lived direct stdio client — Cowork, by-hand — never self-terminates on idle,
  the *"MCP not responding"* bug); the always-on **stdin-close backstop** reaps a real
  disconnect; the supergateway bridges' **`COS_MCP_IDLE_EXIT_MS` opt-in reaper** self-exits an
  idle child; an **in-flight request disarms** the timer; and a **cancelled** in-flight request
  (via a hanging upstream + `notifications/cancelled`) still lets the child idle-exit — the
  regression guard for the inflight-id-Set fix (a counter would leak the cancelled request and
  never re-arm). Both **SKIP gracefully** (exit `0`) if the server's deps aren't installed.

### 13. Search sidecar (python — headless, deterministic)

`../search/test_search.py` covers the semantic search sidecar **without a board and
without a network**. It imports `SearchIndex` directly (not over HTTP), forces the
deterministic **hash** embedder (`COS_SEARCH_EMBEDDER=hash` — no model download, no
API key), and asserts: every doc is indexed; top-k is ordered and capped; a
multi-query batch is per-query; the embedder is stable across fresh instances; and
delete-then-reindex drops/restores a doc. It is **parametrized over both index
backends** — `brute` always runs (monkeypatching `import turbovec` to fail), and
`turbo` runs only when the `turbovec` wheels are present (`importorskip`) — so the
suite is offline and arch-portable. `run.sh` runs it as step **[14]**, **uv-gated**:
**skipped** (not failed) when `uv` is absent, mirroring the Node ≥ 22 gate of step
**[1]**.

### 14. Guard sidecar (python — headless, hermetic)

`../guard/test_guard.py` covers the prompt-injection **guard sidecar** **without a
board, without a model, and without a network**. It imports `sidecar` directly (not
over HTTP) and forces the dependency-free regex classifier
(`COS_GUARD_CLASSIFIER=heuristic` — no torch, no transformers, no gated-model download,
no HF token, no API key), so the **engine** half of `sidecar.py` runs with zero heavy
deps. It asserts:

- **`HeuristicClassifier` scoring** — a clear injection lands in the high band and
  flags; benign mail scores the floor; the strong/weak band calibration holds; and an
  **adversarial evasion corpus** pins the regex's **actual** behavior — the obfuscation /
  leetspeak / base64 / non-English override payloads it really **catches** are asserted
  flagged, while its **documented blind spots** are marked `xfail(strict=False)` so the
  gaps are recorded (and announce themselves as an **XPASS** if the heuristic ever
  improves) **without reddening the suite**. A realistic **benign weak-signal corpus**
  (everyday mail merely containing "from now on" / "act as" / "you are" / "system") is
  asserted **not** flagged at the 0.5 default — the false-positive guardrail that keeps
  the gate usable.
- **`assess()` windowing** — a long body with one buried malicious paragraph flags
  (take-the-MAX); all-benign windows stay clean; the threshold boundary flips a
  single-weak-signal hit.
- **`scan_segments` decomposition** — named `subject` / `body#k` / `extra#k` segments,
  empty parts skipped, long bodies numbered.
- **the writable stores** — `TrustStore`, `QuarantineStore` (incl. content-id dedup,
  body cap, released-TTL auto-purge), and the `ConfigStore` master toggle — full
  round-trips on `tmp_path` files (never the real `guard/data`), plus `probe_deps`,
  `resolve_model_config`, and the `make_classifier` auto→heuristic fail-soft.
- **a FastAPI HTTP smoke** — `/healthz` · `/classify` · `/scan` · `/trust` · `/quarantine`
  · `/config` · `/models` via a `TestClient`, **`importorskip`ped** so the suite still
  runs where `fastapi`/`httpx` are absent; the disabled-toggle passthrough is covered too.

The **full guard suite must stay green** (xfails are allowed; an XPASS is a signal, not a
failure). `run.sh` runs it as step **[15]**, **uv-gated**: **skipped** (not failed) when
`uv` is absent, mirroring the search step **[14]** + the Node ≥ 22 gate of step **[1]**.

## What `board-lint.mjs` enforces

Reads a `cases.json` (`DBShape = { cases, messages }`) and asserts:

1. **case domain** — every case has `domain ∈ {work, life}` (REQUIRED).
2. **case status** — every case status ∈ `{urgent, todo, in_progress, waiting_for_input, done}`.
3. **case ids** — unique and matching `/^CASE-\d+$/` (the `PIC-` prefix is retired).
4. **task ids** — unique within a case and shaped `CASE-<n>-T<k>`.
5. **task status** — every task status ∈ `{open, in_progress, blocked, done}`.
6. **task completion** — `done` tasks carry `completedAt`; non-`done` tasks do not.
7. **task counters** — done count ≤ total (the card's done/total is derivable & sane).
8. **message links** (case → message) — every `messageIds` entry references an
   existing message whose `caseId` points back to that case (no dangling, no
   duplicate listing).
9. **message orphans** (message → case) — every message with a `caseId` points to
   an existing case that lists it in `messageIds` (no orphan).
10. **message ids** — unique, well-formed.
11. **vaultLinks** — when present, an array of non-empty strings.

### v3 invariants (additive — tolerant of optional fields)

The board schema is now **v3** (`board/lib/types.ts` `SCHEMA_VERSION = 3`). All new
fields are **optional**, so these checks only fire when a field is **present-but-malformed**:

12. **db envelope** — the root has a numeric `schemaVersion` and a numeric `version`
    (the monotonic write counter). A `schemaVersion` other than `3` is a **WARN**
    (the lint keeps running across a bump); a missing/non-numeric envelope is an ERROR.
13. **case dates (v3)** — `dueAt`, `startDate`, `snoozeUntil`, `archivedAt` (case-level),
    when present, are ISO-8601-parseable strings.
14. **case priority (v3)** — `priority`, when present, ∈ `{P0, P1, P2, P3}`.
15. **case activity (v3)** — `activity`, when present, is an array of
    `{ ts (ISO), actor ∈ {human, agent, system}, verb (non-empty) }`.
16. **case notes (v3)** — `notes`, when present, is an array of
    `{ id, author ∈ actor, body (string), createdAt (ISO) }`.
17. **task dates (v3)** — `task.dueAt`, when present, is an ISO-8601 string.
18. **task subtasks (v3)** — `task.subtasks`, when present, is an array of
    `{ id, title, done (boolean) }`.

### v4 invariants (calendar events — additive; tolerant when `db.events` is absent)

The board schema is now **v4** (`board/lib/types.ts` `SCHEMA_VERSION = 4`), which
added `db.events` (`CalendarEvent[]`) — **purely additive**, so a v3 file (no
`events`) still lints clean. The calendar block is **guarded by `Array.isArray(db.events)`**
and only fires when an event is **present-but-malformed**:

19. **calendar events (v4)** — when `db.events` is present it is an array of
    `CalendarEvent`: ids unique and matching `/^EVT-\d+$/`; `title` non-empty;
    `date` a parseable `YYYY-MM-DD` calendar day; `allDay` a boolean when present;
    `startTime`/`endTime` `HH:MM` (24h) when present; `domain ∈ {work, life}` when
    present; and `caseId`, when present, references an **existing case** (the
    case↔event link's single source of truth — a dangling caseId is an ERROR).

### v5 invariants (reminders — additive; tolerant when `db.reminders` is absent)

The board schema is now **v5** (`board/lib/types.ts` `SCHEMA_VERSION = 5`), which
added `db.reminders` (`Reminder[]`) — **purely additive**, so a v4 file (no
`reminders`) still lints clean. The reminders block is **guarded by `Array.isArray(db.reminders)`**
and only fires when a reminder is **present-but-malformed**:

20. **reminders (v5)** — when `db.reminders` is present it is an array of `Reminder`
    (lightweight nudges): ids unique and matching `/^REM-\d+$/`; `title` non-empty;
    `status ∈ {open, done, dismissed}` when present; `dueAt` an ISO-8601-parseable
    string when present; `domain ∈ {work, life}` when present; and `caseId`, when
    present, references an **existing case** (the node↔reminder link's single source of
    truth — a dangling caseId is an ERROR).

Exit code: `0` on PASS, `1` on any invariant violation (grouped report), `2` on
unreadable / malformed input. **WARN-level advisories** (e.g. a `schemaVersion`
drift) are printed but never change the exit code.

## Running

```bash
# Full suite. The api-* steps run against an AUTO-STARTED, isolated THROWAWAY board
# (own .next, seeded from tests/fixtures/board-seed.json, sidecars dead-ended) — the
# live board/data is NEVER touched. Needs board/node_modules (else api-* steps skip):
tests/run.sh

# unit tests directly (pure logic; needs Node >= 22, no board, no deps):
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --import ./tests/unit/ts-resolve.mjs --test tests/unit/*.test.ts

# board-lint directly against any cases.json (defaults to ../board/data/cases.json):
node tests/board-lint.mjs
node tests/board-lint.mjs /path/to/cases.json

# Running an api-* test by hand — NEVER point it at your live board. Either let
# run.sh spin up the throwaway board, or point CRM_BASE_URL at a DISPOSABLE board
# whose store you've isolated with COS_DATA_DIR, e.g.:
COS_DATA_DIR=/tmp/throwaway-data cp tests/fixtures/board-seed.json /tmp/throwaway-data/cases.json
( cd board && COS_DATA_DIR=/tmp/throwaway-data PORT=3999 node_modules/.bin/next dev )  # other shell
CRM_BASE_URL=http://localhost:3999 node tests/api-lifecycle.mjs
```

`run.sh` exits non-zero only when a **board invariant** is violated (the hard
gate). The vault grep checks are reported as **WARN** because the vault-migration
(draining `life|work/reminders` into board cases) is owned by other streams and
may still be in flight; once migration lands they read clean and stay that way.

## Files

- `board-lint.mjs` — board invariant checker (Node ESM, zero deps).
- `unit/` — headless `node:test` unit suite over the pure `board/lib` modules:
  - `ts-resolve.mjs` + `ts-resolve-hooks.mjs` — zero-dep resolve hook so `node --test` loads the TS lib modules.
  - `selectors.test.ts` / `store.test.ts` / `format.test.ts` — edge-case coverage per module.
  - `hierarchy.test.ts` — the Initiative > Workstream > Case selector + store layer.
  - `calendar.test.ts` — the v4 calendar-event selectors (`eventsByCaseId`, `eventsForDay`, `eventsByDateRange`, `upcomingEvents`, `monthGrid`, `todayISO`) over in-memory fixtures with a fixed `now`.
  - `reminders.test.ts` — the v5 reminder selectors (`remindersByCaseId`, `openReminders`, `sortReminders`, `upcomingReminders`) over in-memory fixtures with a fixed `now`.
  - `due-status.test.ts` / `format-guards.test.ts` / `store-helpers.test.ts` — focused regression tests pinning specific fixes.
- `fixtures/voice-note-marco.md` + `.expected.json` — voice→both golden case.
- `fixtures/email-velastack.md` + `.expected.json` — email→update-existing golden case.
- `concurrency.mjs` — parallel-write safety check (needs a running board; net-zero).
- `api-lifecycle.mjs` — v3 HTTP API end-to-end lifecycle check (needs a running board; net-zero).
- `api-prefs.mjs` — persisted view-state API check (`/api/prefs` → `prefs.json`): round-trip, query canonicalisation, lane filtering, partial merge, 400 (needs a running board; net-zero).
- `api-search.mjs` — search API check (`/api/search`): keyword GET back-compat, semantic POST batch envelope, 400 guard, and the always-2xx-finds-the-marker fail-safe property (needs a running board; net-zero).
- `api-events.mjs` — v4 calendar-events API check (`/api/events[/:id]`): create→`EVT-<n>`+version bump, list + `from`/`to`/`caseId` filters, PATCH persist, the case↔event link (case GET lists it), the bad-case/missing-title/bad-date/bad-`HH:MM` 400s, and delete (needs a running board; net-zero).
- `api-reminders.mjs` — v5 reminders API check (`/api/reminders[/:id]`): create→`REM-<n>`+version bump, list + `status`/`caseId`/`domain` filters, PATCH persist (`status:done` sets `completedAt`), the node↔reminder link (case GET lists it) + unlink, the bad-case/missing-title/bad-status/bad-`dueAt` 400s, and delete (needs a running board; net-zero).
- `api-trust.mjs` — guard sender-trust **whitelist** API check via the board's thin PROXY routes (`/api/trust[/:email]` → the guard sidecar `:8009`): GET always-200 online shape (SKIPs the lifecycle when `online:false`), add (default `trusted`) → list → tier-flip (`blocked`) → delete lifecycle, and the `unknown`-tier / bad-email 400s. Uses a unique throwaway email and removes it in a `finally` — the whitelist lives in the sidecar, not `cases.json`, so net-zero is via that cleanup (needs a running board + a live guard sidecar).
- `api-trust-derive.mjs` — **end-to-end AUTOMATIC trust DERIVATION** check across every trigger that writes the whitelist as a side effect of a board mutation: `link_message` (case handshake + origination incl. **Cc**), `link_reminder_message` (a **reminder is a first-class trust source**), and relink (`PATCH /api/messages/:id`) — plus the **security** property that a reply-all to a thread someone else started does **not** trust the room. Complements the pure-rule unit suite (`unit/trust-derive.test.ts`) by proving the route→`deriveTrustTargets`→`pushDerivedTrust`→sidecar **wiring**. Snapshots+restores `cases.json` and `DELETE`s every throwaway sender in a `finally` (net-zero on both stores); SKIPs gracefully when the guard is `online:false` (needs a running board + a live guard sidecar; `run.sh` step [11b]).
- `guard-quarantine-release.mjs` — quarantine **release/replay** contract check, driven **directly** against the guard sidecar (`:8009`, `COS_GUARD_URL`): (a) `PATCH status=released` upserts the sender as `trusted` ifAbsent while `status=dismissed` is **inert** (no trust write); (b) `GET /quarantine/released` = `status==released && !replayed`, and `replayed=true` drops the record; (c) `POST /scan` with `threadId` stores it and the released row exposes it. Seeds a strong injection so records flag under both classifiers; uses unique throwaway senders + `DELETE`s every minted record + sender in a `finally` (net-zero across both sidecar stores). SKIPs gracefully when `/healthz` is unreachable (needs a live guard sidecar; run unconditionally as step [12]).
- `../search/test_search.py` — headless, offline tests for the semantic search sidecar (index/top-k/batch/determinism/reindex over both backends; uv-gated in `run.sh` step [14]).
- `../guard/test_guard.py` — headless, hermetic tests for the prompt-injection guard sidecar (HeuristicClassifier scoring + adversarial evasion corpus, `assess` windowing, `scan_segments`, the Trust/Quarantine/Config stores, FastAPI smoke; `COS_GUARD_CLASSIFIER=heuristic`, uv-gated in `run.sh` step [15]).
- `run.sh` — runner: unit (hard) + board-lint (hard) + vault grep checks (warn) + concurrency + api-lifecycle + api-prefs + api-labels + api-search + api-events + api-reminders + api-trust + api-trust-derive (if a healthy board is up) + guard-quarantine-release (self-skips when the guard sidecar is down) + search-sidecar + guard-sidecar (if uv is present).
- `README.md` — this file.
