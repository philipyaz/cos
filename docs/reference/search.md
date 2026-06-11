# Search — keyword always, semantic when the sidecar is up

The board is searchable across all four of its streams — **cases, tasks, messages, and
reminders** — from one read-only endpoint, and every hit flags **its nature** (`type`) so the caller
knows whether a match is a case, a task, an email, or a reminder. Search has two layers that share
one wire contract:

- a **keyword scan** that runs in-process against the loaded `cases.json` (no dependencies), and
- an **optional semantic accelerator** — a small local Python **sidecar** (`:8008`) that ranks
  the same content with embeddings.

The load-bearing rule: **the sidecar is a ranking accelerator, never a hard dependency.** On
*any* sidecar failure — absent, cold, crashed, a foreign process on its port, a garbage 200 —
the board route falls back to the keyword scan and still returns `200`. **Search never darks the
board.** Everything below is built so that fallback is invisible to the caller.

## How it works

There is **one seam: the board route** (`board/app/api/search/route.ts`). Every search — from
the UI's command palette and from the agent's MCP `search` tool — goes through it.

```
Agent (MCP search) ─┐                    Board UI (Cmd/Ctrl+K) ─┐
                    ▼                                            ▼
              board/app/api/search/route.ts   ← the single seam
                GET  ?q=   → keyword scan over readDB()        [ALWAYS in-process]
                POST       → try sidecar (800ms) else keyword  [FAIL-SAFE]
                    │ HTTP POST /search                 │ readDB()
                    ▼                                   ▼
        search sidecar (uv, :8008)            board/data/cases.json
          search/sidecar.py                    (single source of truth;
          Embedder(model2vec | hash)            the board is the only writer,
          in-memory index over the same docs    sidecar opens it READ-ONLY)
```

The sidecar **owns nothing on disk**: it reads `cases.json` read-only (path `COS_BOARD_DATA`),
builds its index in memory, and never persists it. The board remains the only writer of the
store (atomic tmp+rename), so the two processes never fight over the file.

## Data model

Search indexes one **doc** per board object — a small projection plus an embedded text blob:

| doc type | id format | blob fields (what's embedded) |
|---|---|---|
| `case` | `CASE-7` | title · summary · tags · labels |
| `task` | `CASE-3::CASE-3-T2` (`<caseId>::<task.id>`) | task title · detail |
| `message` | `M-1` | subject · from · preview |
| `reminder` | `REM-3` | title · detail · labels · task titles · domain |

Each doc carries a per-doc `hash` of its blob — that hash is what makes the staleness check free
(see *Sidecar* below). `caseId` is the owning case (it equals `id` for cases, the parent case for
tasks/messages, the **linked node** for a reminder, and is `null` for a message or reminder with no
case). Each hit carries its doc's `type` — its **nature** — so cases, tasks, messages, and reminders
are told apart in a mixed result list.

**Reminders are always indexed (incl. `done`).** Reminders have **no archive** — a `done` or
`dismissed` reminder is indexed and searchable just like an `open` one, regardless of
`includeArchived` (which only governs archived *cases*). The reminder doc projects
`{ id, title, status, dueAt, domain, caseId, labels, detail }` for the merged join.

## API contract

Two methods on `/api/search`, sharing the frozen wire contract.

**`GET /api/search?q=…` — keyword, back-compat.** Always an in-process substring scan; never
touches the sidecar. Returns the legacy shape so existing callers keep working:

```jsonc
GET /api/search?q=Marco
→ 200 { "cases": CaseRecord[], "tasks": [{ caseId, task }], "messages": MessageRecord[],
        "reminders": Reminder[] }   // "reminders" is additive — the three original arrays stay
GET /api/search?q=            // empty
→ 200 { "cases": [], "tasks": [], "messages": [], "reminders": [] }
```

The new `reminders` key is **additive**: existing callers reading `cases` / `tasks` / `messages`
keep working unchanged; the array is simply also present.

**`POST /api/search` — batch, semantic-ranked.** A batch of queries with optional filters; the
route tries the sidecar (800 ms timeout) and falls back to keyword on any failure:

```jsonc
POST /api/search
{
  "queries": ["Marco Rivera", "DevForge project", "CASE-3", "cli config schema"],
  "k": 5,                                 // optional, default 10, clamped [1,50]
  "types": ["case","task","message","reminder"], // optional subset ("reminder" is the v6 type)
  "domain": "work",                       // optional "work" | "life"
  "status": null,                         // optional CaseStatus
  "includeArchived": false,               // optional, default false
  "semantic": true                        // false forces the keyword path
}
// `queries` is clamped to the first 32, each trimmed, empties dropped.
// A single "q":"…" is also accepted (wrapped to ["…"]). Empty queries + empty q → 400 {error}.
```

This is the path the board's **Cmd/Ctrl+K command palette** uses: its spotlight calls
`searchBatch(q)` (a one-query `POST`) and renders `merged.cases/tasks/messages`, so the UI search
bar gets the same semantic ranking and keyword fail-safe as the agent — plus an instant local
id/title "jump" list on top for zero-latency exact matches.

The response envelope is shared (the sidecar returns everything except `merged`; the board adds
`merged`, rebuilt server-side from the in-hand db so the full records never come from the
sidecar's projection):

```jsonc
{
  "engine":        "semantic",                         // "semantic" | "keyword"
  "embedder":      "model2vec:minishlab/potion-base-8M", // "none" on keyword fallback
  "indexedDigest": "9f3c…",                            // sidecar's content digest ("" on keyword)
  "tookMs":        3.1,
  "results": [
    { "query": "Marco Rivera",
      "hits": [
        { "type": "case", "id": "CASE-7", "caseId": "CASE-7",
          "score": 7.42, "cosine": 0.41, "why": ["title-match","semantic"],
          "snippet": "DevForge Sponsorship — Marco Rivera …",
          "case": { /* projected CaseRecord fields */ } }
      ] }
  ],
  "merged": { "cases": [ /* full CaseRecord[] */ ],
              "tasks": [ /* { caseId, task } */ ],
              "messages": [ /* full MessageRecord[] */ ],
              "reminders": [ /* full Reminder[] */ ] }   // v6 — additive merged bucket
}
```

A reminder hit carries `type:"reminder"`, `id:"REM-<n>"`, `caseId` (the linked node or `null`), and
a `reminder` projection `{ id, title, status, dueAt, domain, caseId, labels, detail }`; `merged`
gains a `reminders` bucket reconstructed from `db.reminders` by id, the same join the other three
buckets use.

`merged` is the board's join: it takes the hits, drops any whose id isn't in the db (index/db
drift) and any with `score <= 0`, looks each surviving id up to a **full** record (a reminder hit
resolves back to its `db.reminders` record), dedupes by id keeping the max score, sorts descending,
and slices to `k`. So `merged` is "plausible matches", not the least-bad N. **Limits: max 32
queries, `k ≤ 50`.**

### Filter rules — reminders are partly exempt

The `domain` and `status` filters apply per the doc's nature, so a reminder's lighter model isn't
forced through the case-lane filters:

- **`domain` — a truthiness rule.** A doc is dropped only when `domain` is set *and the doc carries a
  domain* that doesn't match: `if (domain && doc.domain && doc.domain !== domain) drop`. Cases always
  carry a domain (so unchanged); messages have none (so stay exempt); a **reminder is honoured only
  when it carries a domain** — a domainless reminder is never dropped by the domain filter.
- **`status` — exempt for reminders.** The `status` filter narrows the **case lane** (`open` cases,
  tasks, etc.); a reminder's `open`/`done`/`dismissed` is a *different* status space, so a reminder is
  **never dropped by the case-lane `status` filter** — on a text match it's always included. (This is
  also why a `done` reminder still shows up under a case-lane status filter.)

**Keyword-fallback response** (sidecar down/garbage) is the *same envelope* with
`engine:"keyword"`, `embedder:"none"`, `indexedDigest:""`, and each hit `cosine:0` /
`why:["keyword"]` — scored by the route's local hybrid (id-exact > id-substring > title >
token-overlap). The caller can't tell structurally that it fell back, only that the ranking is
keyword-grade.

!!! tip "Try it — the runnable demo"

    [`scripts/search-demo.mjs`](https://github.com/philipyaz/cos/blob/main/scripts/search-demo.mjs)
    is a narrated, **read-only** walkthrough of this API: it `POST`s a batch of queries at a
    running board and prints the ranked hits (id, type, score, and the `why` signals), so you can
    watch the hybrid scoring and the keyword fail-safe in action without touching any data. With
    the board up (`cd board && npm run dev`), run `node scripts/search-demo.mjs` (point it
    elsewhere with `CRM_BASE_URL`).

## MCP — the `search` tool

The `board` MCP server exposes a read-only **`search`** tool (in `mcp/board-server`). It accepts
either a single `q` or a `queries[]` array plus `k` / `types` (incl. the v6 `"reminder"`) / `domain`
/ `status`, calls the board route, and returns ranked `cases`, `tasks` (each with its `caseId`),
`messages`, and `reminders`. Each hit **flags its nature** — the batch render tags a reminder hit
`[reminder]` (with its status), and the single-`q` GET render adds a `Reminders:` block — so the
agent can tell a matched nudge from a case. It inherits the fail-safe: an unreachable board maps to
an error result, and a reachable board's `POST` never 5xxes (it always falls back to keyword), so the
tool degrades gracefully too.

**Search-before-create mandate.** Both ingest skills (`second-brain-ingest` and the
developer-tooling skill) call `search` with **several queries at once** — the resolved
entity name and the topic — *before* opening a case. If a strong
match comes back they **update** that case instead of spawning a duplicate. This is how the
"one case per thread/topic" dedupe tenet is enforced from the agent side (see each `SKILL.md`).

## Sidecar (`search/sidecar.py`, `:8008`)

A FastAPI app run by **`uv`** (`uv run --directory search uvicorn sidecar:app --port 8008`). No
torch, no Rust — it uses **model2vec** (static embeddings) for vectors and **turbovec** for the
index, with a brute-force NumPy fallback for the tiny corpus here.

- **Embedder** — `COS_SEARCH_EMBEDDER ∈ { auto (default), model2vec, hash }`. `model2vec` loads
  `minishlab/potion-base-8M`; `hash` is a **deterministic** hashing embedder that needs no model
  (ideal for tests / offline); `auto` prefers `model2vec` and degrades to `hash` if the model
  isn't available. Both are 256-d but **semantically incompatible**, so switching invalidates the
  index.
- **Corpus** — read from `COS_BOARD_DATA` (the **absolute** path to `cases.json`). It's opened
  read-only; the sidecar never writes the store.
- **Reindex is content-DIGEST-gated, not `db.version`-gated.** `INDEX.ensure(db)` runs at the top
  of every `POST /search` against a fresh snapshot; it rebuilds only when the content digest
  changed (or the embedder changed):

  ```
  digest = blake2b( "\n".join(sorted(f"{id}:{hash}" for each doc)) )
  ```

  **Why not `db.version`?** The version is *not trustworthy* as a cache key: `migrate()` resets it
  to `0` for any file lacking the field (hand-edits, `git checkout`, restore-from-backup);
  `readDB()` silently falls back to the older `cases.json.bak` on a parse failure; and a hand-edit
  bumps content without bumping the in-memory version. So the version can **decrease or repeat**
  with *different* content — a version-keyed cache would serve stale vectors forever. The per-doc
  `hash` already exists, so the digest is free at this scale.
- **Endpoints** — `POST /search` (the ranking call); `POST /reindex` (force a full rebuild
  regardless of digest — cold start / embedder swap / ops); `GET /stats` (doc counts, digest,
  embedder); `GET /healthz` (`{"ok":true,…}` only **after** the embedder is warmed at startup, so
  a cold sidecar never reports healthy).

The index is rebuilt by clearing the backend and re-adding all docs; the same digest ⇒ identical
docs ⇒ identical index (idempotent), and the str-id ↔ uint64 map is preserved across rebuilds so
external ids stay stable. No file watcher — the digest is strictly correct, with none of the
mtime/inotify TOCTOU pitfalls. (Upgrade path past thousands of docs: swap the full rebuild for an
`upsert` of just the changed docs, keyed on the same per-doc `hash`.)

## Hybrid scoring

Ranking is a **hybrid**, not pure cosine — exact/structural signals boost over semantics so that
typing an id or a title lands the obvious hit first:

```
exact-id  >  id-substring  >  title match  >  semantic cosine  >  token overlap
```

`score` is the hybrid number (higher = better; `> 1` from boosts; it *can* be `< 0` for a pure
dot product). `cosine` is the raw semantic cosine (`0` on the keyword path) kept only as a
diagnostic. `why` lists the signals that fired, drawn from
`{ exact-id, id-substring, title-match, semantic, keyword }`.

## Fail-safe + Ops

- **Boot.** `mcp/ensure-bridges.sh` (chained from `board/package.json` `dev`/`start`) nudges the
  sidecar alongside the two MCP bridges: `launchctl bootstrap` + `kickstart`
  `com.chiefofstaff.mcp-search`, then a lenient `/healthz` probe. A cold/absent sidecar only
  **WARNs** (`search starting … keyword search works meanwhile`) and the script still `exit 0`s,
  so a missing sidecar or missing `uv` can never block `next dev`.
- **launchd.** `~/Library/LaunchAgents/com.chiefofstaff.mcp-search.plist` runs the sidecar with
  `KeepAlive` + `RunAtLoad`, `COS_BOARD_DATA` set to the **absolute** `cases.json` path, and
  `HF_HUB_OFFLINE=1` after a one-time model prefetch. Full plist + prefetch command live in the
  **mcp-bridge-setup** skill.
- **First boot needs the network once** — to fetch the ~30MB `potion-base-8M` model into
  `~/.cache/huggingface` (~30s to green `/healthz`). After that the sidecar starts fully offline.
  The `hash` embedder needs no model at all.
- **Absent-safe end to end.** No sidecar, no `uv`, a foreign process on `:8008`, a slow cold
  start — every case degrades to keyword and returns `200`. The sidecar is a pure accelerator
  over the same `cases.json`.

## Tests

- **`tests/api-search.mjs`** (live) — drives `GET ?q=` + `POST /api/search` against a running
  board and asserts the wire contract (envelope shape, fallback, `merged` rebuild, clamps, and that
  `merged.reminders` is present as an array while `GET ?q=` still returns the three original
  arrays). Like the other live suites in `tests/run.sh`, it **SKIPs (not FAILs)** when no board is up
  at `CRM_BASE_URL`, so the headless suite stays green.
- **`search/test_search.py`** (hermetic) — exercises the sidecar in isolation with the
  deterministic `hash` embedder (no model download, no network): digest-gated reindex,
  idempotent rebuild, hybrid scoring, the `/search`+`/reindex`+`/stats`+`/healthz` surface, and the
  v6 reminder doc type (reminder docs built incl. a `done` one, a reminder is searchable, the
  `"reminder"` type filter, and that the case-lane `status` filter doesn't drop reminders).

Run everything via [`tests/run.sh`](https://github.com/philipyaz/cos/blob/main/tests/run.sh); each live step gates on a healthy board and
SKIPs rather than FAILs when one isn't present.
