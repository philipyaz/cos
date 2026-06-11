# openwhispr MCP server

A local **stdio** MCP server that exposes [OpenWhispr](https://openwhispr.com) voice
transcripts to the chief-of-staff router, and owns the **watermark** that makes voice
ingestion idempotent. Registered in `.mcp.json` under the server name **`openwhispr`**.

OpenWhispr has no native "mark read" — so once the router has turned a voice note into a
vault page and/or a board case, it calls `mark_processed` here, and that transcript stops
showing up as unprocessed. That marker is the whole reason this server exists.

## Where OpenWhispr stores things (macOS)

OpenWhispr keeps everything under its Electron `userData` dir,
**`~/Library/Application Support/open-whispr/`**:

| What | Where |
| --- | --- |
| **Transcript text** | `transcriptions.db` — a SQLite DB. The `transcriptions` table (`id, text, raw_text, created_at, has_audio, audio_duration_ms, provider, model, status, deleted_at, …`) is the source of truth. |
| **Audio recordings** | `audio/OpenWhispr-<YYYY-MM-DD-HH-MM-SS>-<id>.webm` — one `.webm` per note. The integer right before `.webm` is the `transcriptions.id`, which is how this server maps each note to its recording. |

There is **no plain-text file per note** — the text lives in the SQLite DB, and the audio lives
as `.webm` files. (The app also runs a loopback "CLI bridge" on a random port in 8200–8219 with a
per-launch token in `~/.openwhispr/cli-bridge.json`, but that bridge exposes **no endpoint to read
the audio** — it can only *delete* it — and disappears when the app quits. So this server reads the
DB + audio dir directly: complete, and works whether or not the app is running.)

## Tools

**`list_transcripts(limit?, since?, includeProcessed?)`**
- Lists transcripts as `{ id, created, preview }`, most-recent first, with a `🎙 <file>` marker for
  each note's audio recording. Two integrity flags keep "fetch every audio" honest: `⚠ audio file missing`
  (the DB claims audio but the `.webm` is gone) and `⚠ orphan audio (no transcript row)` (a `.webm` whose
  transcript row was hard-deleted/pruned — surfaced as a synthetic `orphan:<file>` entry rather than dropped).
- **By default returns only UNPROCESSED transcripts** — those newer than the watermark.
- `since` further filters to transcripts created strictly after that time (AND'd with the watermark).
  Interpreted on the **local** clock to match the DB's local timestamps (a trailing `Z`/offset is ignored).
- `includeProcessed: true` ignores the watermark and returns everything.
- `limit` caps the count — when the watermark is honored it keeps the **oldest** unprocessed notes (so the
  backlog drains in order); when browsing (`includeProcessed`) it keeps the most-recent.

**`get_transcript(id)`**
- Full transcript `text` plus metadata: `created`, and from the real store `has_audio`,
  **`audio_path`** (absolute path to the `.webm` recording, so a caller can fetch the actual audio),
  `audio_duration_ms`, `provider`, `model`, `status` (and `audio_missing: true` if the recording is gone).
- Reports whether the transcript is already processed. Unknown id → clean tool error.

**`get_watermark()`**
- Returns `{ id, created }` of the last transcript marked processed (nulls if the loop has never run), and the state-file path.

**`mark_processed(id)`**
- Advances the watermark to that transcript's id + created timestamp.
- After this, `list_transcripts` skips that transcript and anything older. This is the idempotency primitive.

## Watermark / idempotency model

The watermark is a single `{ id, created }` JSON file this server owns
(`state/watermark.json` by default, override with `OPENWHISPR_STATE`):

- `list_transcripts` sorts all transcripts by `created` (then `id` as a tiebreaker) and, unless
  `includeProcessed` is set, returns only those that sort **strictly after** the watermark.
- `mark_processed(id)` writes that transcript's `{ id, created }` as the new watermark.
- So the voice loop is naturally **idempotent**: re-running `list_transcripts → route → mark_processed`
  never re-emits an already-routed note. Crash mid-loop and you simply reprocess from the last
  successfully-marked transcript forward — at-least-once, advancing only after a transcript is fully routed.
- No watermark file yet ⇒ nothing processed ⇒ every transcript is "new".

Ordering prefers the ISO `created` timestamp; if timestamps are missing or equal it falls back to a
string compare on `id` (so monotonic, sortable ids like `vn-2026-05-29-1705-...` work too).

## Source resolution (real store first; degrades gracefully)

In order:
1. **`OPENWHISPR_FIXTURES=<dir>`** — read `*.json` / `*.md` transcript files from that directory.
   Highest precedence (an explicit test override), and how `test-client.mjs` runs without OpenWhispr installed.
2. **SQLite (the real store)** — `OPENWHISPR_DB` (or, if unset, the auto-detected macOS path
   `~/Library/Application Support/open-whispr/transcriptions.db`). Read **read-only** via the `sqlite3`
   CLI — safe while the app is running (WAL allows concurrent readers) — and each note is mapped to its
   recording in `OPENWHISPR_AUDIO_DIR` (default `audio/` next to the DB). **This is the default in production.**
3. **`openwhispr` on PATH** — legacy fallback: shell out to `openwhispr --local transcriptions list|get`.
4. **None** — every tool returns a clean error telling you to set `OPENWHISPR_DB` / `OPENWHISPR_FIXTURES`.

Soft-deleted rows (`deleted_at`) are hidden; every other note is kept (even non-`completed` / empty-text
ones) so a recording is never silently dropped — `status` / `has_audio` are surfaced in metadata instead.

### Fixture format
- `*.json`: an object with at least `text` (or `transcript`); optional `id`, `created`, and any extra keys become metadata.
- `*.md`: optional `--- ... ---` frontmatter (`id:`, `created:`, plus any meta), then the transcript body.
- If `id` / `created` are omitted they fall back to the filename and file mtime.

The bundled `fixtures/` has three notes, including `vn-2026-05-29-1705-rivera.json` — a **work**
voice note about the Marco Rivera / DevForge sponsorship engagement that maps cleanly to a board
case (urgent, scope doc + fixed-price quote + kickoff tasks, vaultLinks to the entity/concept pages) —
plus a **life** errands note and a knowledge-only idea note, to exercise all routing paths.

## Config

| Env | Purpose | Default |
| --- | --- | --- |
| `OPENWHISPR_FIXTURES` | Directory of `*.json` / `*.md` fixtures (overrides the real store) | unset |
| `OPENWHISPR_DB` | Path to OpenWhispr's `transcriptions.db` | auto-detect `~/Library/Application Support/open-whispr/transcriptions.db` |
| `OPENWHISPR_AUDIO_DIR` | Directory of `*.webm` recordings | `audio/` next to the DB |
| `OPENWHISPR_STATE` | Watermark file path | `state/watermark.json` next to `server.mjs` |

## `.mcp.json` entry

```json
{
  "mcpServers": {
    "openwhispr": {
      "command": "node",
      "args": ["./mcp/openwhispr-server/server.mjs"]
    }
  }
}
```

With no `env`, the server auto-detects the real macOS store. Set `"env": { "OPENWHISPR_DB": "…" }`
to point at a non-default DB, or `"env": { "OPENWHISPR_FIXTURES": "./mcp/openwhispr-server/fixtures" }`
to run off fixtures while OpenWhispr isn't installed.

> In this repo the server runs behind a launchd-managed HTTP bridge on `:8002` (see
> `~/Library/LaunchAgents/com.chiefofstaff.mcp-openwhispr.plist`), which is where `OPENWHISPR_DB` /
> `OPENWHISPR_AUDIO_DIR` are set for production. After changing that plist, reload with
> `launchctl bootout … && launchctl bootstrap gui/$UID …` (see the `mcp-bridge-setup` skill).

## How the voice recipe uses it

The scheduled voice recipe (and the `second-brain-ingest` router) runs the idempotent loop:

1. **`list_transcripts`** → get the unprocessed voice notes (watermark already filters out anything routed before).
2. For each, **`get_transcript(id)`** → full text → the **router** classifies it:
   - knowledge → re-synthesize the affected vault entity/concept/source pages;
   - action → create/update a board case via the **`board`** MCP, tagged `work` | `life`, with `vaultLinks` back to those pages;
   - most notes produce **both**, cross-linked.
3. **`mark_processed(id)`** → advance the watermark so the next run won't see it again.

## Verify

```bash
cd mcp/openwhispr-server && npm install
npm test            # runs both suites below
npm run test:fixtures   # stdio against fixtures/: list → get → mark_processed → list (watermark drops by one)
npm run test:sqlite     # builds a throwaway transcriptions.db + audio/ and asserts the SQLite source:
                        #   real rows load, each maps to its .webm by trailing -<id>, audio_missing is
                        #   flagged, soft-deleted rows are hidden, watermark advances. Never touches real data.
```

To eyeball the **real** store read-only (your live notes, without disturbing the watermark):

```bash
OPENWHISPR_STATE=$(mktemp) node -e 'import("./server.mjs")'   # or just check the bridge:
# the launchd bridge on :8002 already serves the real DB once OPENWHISPR_DB is set in its plist.
```
