# Async vault ingest

The vault's `ingest` is **asynchronous**: a tool call submits a job and returns immediately, and a
separate launchd-supervised runner performs the multi-minute synthesis **detached** from the request.
`query` stays **synchronous** (it's fast on Haiku). This page documents the lifecycle, the tools, and
the runner. For the agent itself (the embedded session, the nesting safeguards), see
[The vault agent](../architecture/vault-agent.md).

## Why async

Each `ingest` runs a full headless Claude Code session that re-synthesizes 10–15 wiki pages — seconds
to minutes. A synchronous tool call can't survive that: **Claude Cowork Desktop hard-caps a tool call
at ~4 minutes** (unconfigurable, and it ignores progress notifications), so a substantial ingest was
cancelled mid-synthesis and never landed. Submitting a job and polling decouples the work from the
client's tool-call timeout entirely — the ingest runs to completion regardless of whether the client
is still waiting.

## The submit-then-poll lifecycle

```mermaid
flowchart LR
  C["client (Cowork / Code)"] -->|ingest| S["vault MCP server"]
  S -->|enqueue (content-hash dedup)| J[(".cos/jobs.json")]
  S -->|"job_id (immediately)"| C
  R["jobs-runner (launchd sidecar)"] -->|claim working job| J
  R -->|run Sonnet synthesis, detached| V[("vault wiki")]
  R -->|"setStatus(completed | failed)"| J
  C -->|ingest_status job_id| S
  S -->|"status (+ result on completed)"| C
```

1. **`ingest`** validates the input, enqueues a job, and returns a `job_id` in `structuredContent`
   (with `poll_interval_ms` and `ttl_ms`). It does **not** run the agent.
2. The **runner** (`com.chiefofstaff.mcp-vaultjobs`) claims the oldest `working` job, runs the agent,
   and writes a terminal status with the result.
3. **`ingest_status({ job_id })`** is polled until the status is terminal.
4. **`ingest_cancel({ job_id })`** requests a cooperative stop (already-written pages stay).

MCP clients should drive this via the [`vault-operations` skill](https://github.com/philipyaz/cos/blob/main/.claude/skills/vault-operations/SKILL.md),
which encodes the loop and the never-re-submit rule. **Claude Code** auto-loads it from the repo's
`.claude/skills/`; **Claude Cowork Desktop** adds custom skills through its UI — package the skill
folder as a ZIP (`vault-operations/SKILL.md` at the ZIP root) and upload it via **Customize → `+`
(Skills) → Create skill** (the [`setup-vault`](https://github.com/philipyaz/cos/tree/main/.claude/skills/setup-vault)
skill scripts the `zip` step). Even without the skill, the `ingest` / `ingest_status` tool
**descriptions** carry the same submit-then-poll guidance, so it reinforces rather than gates correctness.

## Job states

| Status | Meaning |
| --- | --- |
| `working` | Enqueued, awaiting the runner. |
| `running` | Claimed by the runner; synthesis in progress (`status_message` shows progress). |
| `completed` | Done — `structuredContent.result` holds the ingest summary. **Terminal.** |
| `failed` | Errored — `structuredContent.error` (`.retryable` hints whether to re-submit). **Terminal.** |
| `cancelled` | Cancelled cooperatively; pages already written stay. **Terminal.** |
| `interrupted` | The runner restarted mid-ingest and abandoned the work — re-submit to retry. **Terminal.** |

Terminal states are absorbing (a late write from a reaped agent can't resurrect a finished job).

## Deduplication (the anti-fan-out fix)

The job id is a content hash of `{content, files, domain, cases}` (files/cases sorted). Submitting the
**same** material while a job for it is in flight returns the **same `job_id`** (`dedup: true`) and
does **not** start a second agent — so a client retrying after a perceived timeout, or a doubled poll
loop, collapses to one job plus a submission count instead of fanning out duplicate sessions.

## The runner

`jobs-runner.mjs` is a launchd runner (like the guard/search sidecars), whose plist is generated
from its descriptor [`mcp/vault-server/vaultjobs.service.json`](https://github.com/philipyaz/cos/blob/main/mcp/vault-server/vaultjobs.service.json)
by `scripts/gen-launchd.mjs` (see [`mcp/CLAUDE.md`](https://github.com/philipyaz/cos/blob/main/mcp/CLAUDE.md))
and supervised by `ensure-bridges.sh`. It owns execution: on boot it requeues jobs orphaned by a
previous crash (a dead-pid `running` job → back to `working`), then claims and runs jobs one at a
time. It needs `ANTHROPIC_API_KEY` (sourced by `jobs-runner-launch.sh` from `config/secrets.env`) and
`COS_VAULT_DIR`. It has **no HTTP port** — liveness is `launchctl list | grep com.chiefofstaff.mcp-vaultjobs`
plus the `runner up` banner in `mcp/logs/vaultjobs.err.log`.

The job store lives at `$COS_VAULT_DIR/.cos/jobs.json` (gitignored with the rest of the live vault;
override with `COS_VAULT_JOBS_FILE`). Writes are atomic (temp + rename) and serialized across the
server and runner processes by an `O_EXCL` lockfile.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `COS_VAULT_JOBS_FILE` | `$COS_VAULT_DIR/.cos/jobs.json` | Absolute path of the job store (override). |
| `COS_VAULT_POLL_INTERVAL_MS` | `8000` | Runner poll cadence + the `poll_interval_ms` surfaced to clients. |
| `COS_VAULT_JOBS_TTL_MS` | `3600000` | Retrievability window for a job + its result; terminal records are purged after it. |
| `COS_VAULT_INGEST_TIMEOUT_MS` | `600000` | Per-ingest session ceiling in the runner (no longer clipped by the client). |
| `COS_VAULT_FAKE_RUN` | _(unset)_ | Test seam — the runner returns a canned summary instead of calling the agent. |

## Relation to the MCP Tasks extension

This is a **bespoke** async surface deliberately shaped like the MCP **Tasks extension**
(`io.modelcontextprotocol/tasks`). Today's clients negotiate protocol `2025-11-25` and don't advertise
the extension (which targets the unreleased `2026-07-28` RC), and the Tasks spec forbids returning a
`CreateTaskResult` to a client that didn't advertise it — so a `job_id` in an ordinary tool result is
the correct, spec-compatible interim. The field names (`job_id`→`taskId`, `poll_interval_ms`→
`pollIntervalMs`, `ttl_ms`→`ttlMs`, …) map 1:1 to the Tasks shape, so when a client advertises the
extension the server can emit a real `CreateTaskResult` from a single wire-adapter (`shapeJobResult`)
without touching the store, the runner, or the dedup logic.
