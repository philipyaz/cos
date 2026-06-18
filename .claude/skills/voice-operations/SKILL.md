---
name: voice-operations
description: Drive the `openwhispr` MCP — read OpenWhispr voice transcripts (text + `.webm` audio) and own the idempotency watermark. `list_transcripts` returns only UNPROCESSED notes; `mark_processed` (LAST, after a note is fully handled) advances the watermark so it is never re-emitted. Use for any voice-note read, audio fetch, or processing loop.
---

# Voice operations — read OpenWhispr notes & own the watermark

The `openwhispr` MCP exposes your **OpenWhispr** voice transcripts (a local SQLite DB + per-note
`.webm` audio) **read-only**, and owns the **watermark** that makes voice processing idempotent. It is
the read + watermark layer; it does **not** route anything (turning a note into a vault page or a board
case is **`/second-brain-ingest`**'s
job). Four tools: `list_transcripts`, `get_transcript`, `get_watermark`, `mark_processed`.

## The tools

- **`list_transcripts(limit?, since?, includeProcessed?)`** — lists `{ id, created, preview }`, with a
  `🎙 <file>` marker per note's audio. **By default returns only UNPROCESSED notes** (those sorting
  after the watermark). `includeProcessed: true` ignores the watermark and returns everything (browse
  mode). `since` filters to notes created strictly after a time (interpreted on the **local** clock — a
  trailing `Z`/offset is ignored). `limit` caps the count: when the watermark is honored it keeps the
  **oldest** unprocessed notes (so a backlog drains *in order*); when browsing it keeps the most-recent.
  Watch for the integrity flags `⚠ audio file missing` and `⚠ orphan audio (no transcript row)`.
- **`get_transcript(id)`** — the full `text` plus metadata: `created`, `has_audio`, **`audio_path`** (the
  absolute path to the `.webm`, so you can fetch the real audio), `audio_duration_ms`, `provider`,
  `model`, `status`, and `audio_missing: true` if the recording is gone. Also reports whether the note is
  already processed. An unknown `id` returns a clean tool error.
- **`get_watermark()`** — `{ id, created }` of the last note marked processed (both `null` if the loop has
  never run), plus the state-file path. Use it to see where the cursor sits.
- **`mark_processed(id)`** — advances the watermark to that note's `{ id, created }`. After this,
  `list_transcripts` skips that note **and anything older**. This is the only state-changing tool — the
  whole reason the server exists (OpenWhispr has no native "mark read").

## The watermark is the point (idempotency)

`mark_processed` is the **only** write. The watermark is a single `{ id, created }` JSON file the server
owns (`state/watermark.json`, override `OPENWHISPR_STATE`); `list_transcripts` returns only notes sorting
**strictly after** it (by `created`, with `id` as the tiebreaker for monotonic ids like
`vn-2026-05-29-1705-…`).

So the correct way to process notes is the loop:

1. **`list_transcripts`** → the unprocessed notes (the watermark already excludes anything handled).
2. For each, **`get_transcript(id)`** → the full text (and `audio_path` if you need the audio), then
   **fully handle it** (e.g. hand it to `/second-brain-ingest` to route knowledge → vault and action →
   board).
3. **`mark_processed(id)`** — **LAST**, only after the note is fully handled.

**Advance the watermark LAST.** Because `mark_processed` runs only after a note is done, the loop is
**at-least-once**: crash mid-loop and the next run simply reprocesses from the last successfully-marked
note forward — nothing is skipped. Marking *before* you finish would silently drop a note. With **no
watermark file yet**, nothing is processed, so every note is "new".

## Reading the audio, not just the text

`get_transcript` gives `audio_path` — the absolute path to the note's `.webm`. The DB is the source of
truth for text; audio lives as `audio/OpenWhispr-<timestamp>-<id>.webm` (the integer before `.webm` is
the transcript `id`). If `audio_missing` is set (or `list_transcripts` flagged `⚠ audio file missing`),
the DB claims audio the file no longer has — handle the text alone.

## Where the notes come from (source resolution)

The server resolves its source in order — **real store first, degrades gracefully**:

1. **`OPENWHISPR_FIXTURES=<dir>`** — `*.json` / `*.md` fixture files (an explicit test override; highest
   precedence).
2. **SQLite (the real store)** — `OPENWHISPR_DB`, or the auto-detected macOS path
   `~/Library/Application Support/open-whispr/transcriptions.db`, read **read-only** via the `sqlite3`
   CLI (WAL-safe — fine while the app is running). **The production default.**
3. **`openwhispr` on PATH** — legacy CLI fallback.
4. **None** — every tool returns a clean error telling you to set `OPENWHISPR_DB` / `OPENWHISPR_FIXTURES`.

Soft-deleted rows (`deleted_at`) are hidden; every other note is kept (even non-`completed` / empty-text
ones) so a recording is never silently dropped — `status` / `has_audio` are surfaced in metadata instead.
If `list_transcripts` is stuck on fixtures instead of your real notes, that's `OPENWHISPR_FIXTURES` set —
see **`/openwhispr-mcp-setup`**.

## Practical notes

- **Read-only on your notes.** This MCP never writes the transcripts DB or the audio; the only thing it
  writes is its own watermark file. It cannot delete or edit a note.
- **Routing is not this skill's job.** This is the read + watermark layer; classifying a note and writing
  the vault/board is `/second-brain-ingest` (the router) + the `board` MCP. Keep the two concerns
  separate — drive the reads/watermark here, hand the content to the router.
- **Setup vs operation.** Standing the server up on a new machine (the launchd bridge on `:8002`, the
  Cowork stdio entry, `OPENWHISPR_DB`) is **`/openwhispr-mcp-setup`**;
  this skill is for *using* it once it's wired.
