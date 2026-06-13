---
name: vault-operations
description: Drive the `vault` MCP — `ingest` is async (submit, then poll `ingest_status` to a terminal state; never re-submit an in-flight job); `query` is synchronous. Use for any vault ingest or query.
---

# Vault operations — the submit-then-poll lifecycle

The `vault` MCP exposes four tools: `ingest`, `ingest_status`, `ingest_cancel`, and `query`. Two of
them behave very differently, and getting the difference right is the whole point of this skill.

## query is SYNCHRONOUS — just call it

`query` runs a fast read-only session and returns the answer directly. Call it once and use the
result. **Do not poll it.** It declines purely-open-work questions ("what's overdue?") with a board
pointer — that's expected.

## ingest is ASYNCHRONOUS — submit, then poll to a terminal state

`ingest` does NOT do the work before it returns. It validates the input, enqueues a background job,
and returns **immediately** with a `job_id` in `structuredContent`. A separate runner process then
performs the multi-page synthesis (seconds to minutes). **A returned `job_id` means "submitted",
not "done."**

The loop you MUST follow:

1. Call `ingest` with `content` (and/or `files`, `domain`, `cases`). Read `job_id` and
   `poll_interval_ms` from the result's `structuredContent`.
2. Call `ingest_status({ job_id })`. Repeat every `poll_interval_ms` while `status` is `working` or
   `running`.
3. Stop only when `status` is **terminal**: `completed`, `failed`, `cancelled`, or `interrupted`.
4. Then report to the user:
   - `completed` → `structuredContent.result` holds the ingest summary (pages synthesized, sources
     created). Report what landed.
   - `failed` → `structuredContent.error.message` says why. If `error.retryable` is true, you may
     re-submit.
   - `cancelled` → the job was cancelled; already-written pages stayed (no rollback).
   - `interrupted` → the vault process restarted mid-ingest and the work was abandoned. **Re-submit
     the same material** to start a fresh job.

Never announce "I've added that to your vault" off the `ingest` response alone — that only means the
job was queued. Wait for `completed`.

## Never re-submit an in-flight job

`ingest` dedups by a content hash. If you submit the same material while a job for it is still in
flight, you get back the **same `job_id`** (with `dedup: true`), and no second agent runs. That is
the signal to **poll**, not to retry. Re-submitting identical content burns a turn and tells you
nothing new — call `ingest_status` instead.

## Cancelling

`ingest_cancel({ job_id })` requests a cooperative stop: the job halts at its next checkpoint and any
pages already written stay (there is no rollback). Acking a job that already finished is harmless. Use
it when the user aborts or the ingest is no longer wanted — then poll `ingest_status` to confirm it
reaches `cancelled`.

## Practical notes

- **Heavy ingests are fine now.** Because the work runs detached in the runner, a long synthesis is
  no longer bounded by the client's tool-call timeout (Cowork's ~4-min cap). Submit it and poll.
- **One unknown/expired `job_id`** from `ingest_status` means the job aged out of its retention
  window (default ~60 min) — re-submit the material rather than treating it as a hard failure.
- **The vault is knowledge-only.** It never writes the board; a board case id you pass to `ingest` is
  recorded by reference only. Open-to-do questions belong on the board, not in a `query`.
