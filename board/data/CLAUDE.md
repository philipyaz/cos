# `board/data/` — the LIVE persistent store. DO NOT DELETE OR OVERWRITE.

**STOP.** This directory holds the user's **real, irreplaceable work+life data** — the running
board's persistent state. Everything here except this file is **gitignored on purpose** (see the
repo-root `.gitignore`: `board/data/*` + a single `!board/data/CLAUDE.md` exception). Treat every
file here as **production user data**, not scratch.

## What lives here
- **`cases.json`** — THE store: cases, messages, reminders, events, priorities, labels, settings,
  **and the add-on data** (`foodLogs` / `pantryItems` / `mealPlanEntries` / `weights` for Nutrition;
  `healthEntries` / `athleteProfile` / `coachingArtifacts` for Fitness). Written through the single
  `mutate()` chokepoint in `board/lib/store.ts`, with a monotonic `version`.
- **`prefs.json`** — small UI/board prefs.
- **`backups/`** — the board's own rolling auto-snapshots (`cases-<ISO>.json`), written on writes.
  This is the recovery source of last resort.

## Hard rules
- **NEVER delete, truncate, or `cp`/`>` over `cases.json`** (or `prefs.json`). It is not a fixture or
  a placeholder — it is the user's live data. There is no "it'll regenerate": the app only recreates
  an **empty** store, and a running board will then mutate *forward from whatever you put there*,
  compounding the loss.
- **NEVER run the test "seed" step against this directory.** CI and a fresh checkout seed an empty
  `board/data/` with `cp tests/fixtures/board-seed.json board/data/cases.json` — that is correct
  **only when the dir is empty**. On a machine with live data (i.e. here, whenever `cases.json`
  already exists), that command **destroys the real store**. This has actually happened.
- **Before any test run that touches the store:** `tests/run.sh` drives a *throwaway* board in a
  sandbox (`COS_DATA_DIR=<tmp>`), so the real file is not needed. `board-lint` is **read-only and
  takes a path arg** — lint the real file in place (`node tests/board-lint.mjs board/data/cases.json`)
  or point it at the fixture. If you genuinely must seed this dir, **back `cases.json` up first**.
- **Edit the data only through the running board's API / the `board` MCP** (the validating `mutate()`
  path), not by hand-writing JSON — hand edits skip validation, id-minting, and SSE versioning.

## If data is lost anyway — recover, don't panic
The board snapshots to `backups/` on every write. Find the newest snapshot with a **high `version`**
(the real data; a wiped/seed store resets `version` to ~1) and restore it. If the live store has
*newer* legitimate items than that snapshot, graft them onto the restored base with re-id'd ids and
**validate with `node tests/board-lint.mjs <candidate>` before swapping it in.** The off-site daily
encrypted backup (`/backup-recovery` skill) is the secondary source.

> This is a **component guardrail doc**, deliberately the one committed file in an otherwise
> data-only, gitignored directory. It is not MkDocs site content.
