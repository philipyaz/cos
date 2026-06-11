# Migration — consolidation into the monorepo

This records the one-time restructuring that pulled the two existing foundations into a single
monorepo at `~/Code/cos`. **It is non-destructive:** the originals in `~/Code` were left
untouched, and nothing outside this repo was moved or overwritten.

## What moved where

| Part | From | To | How |
|---|---|---|---|
| Board (kanban app) | repo root (was at `./`) | `board/` | `git mv` — **history preserved** (same repo) |
| Vault (knowledge base) | `~/Code/notes-vault/my-personal-thoughts-vault` | `vault/my-personal-thoughts-vault` | **copied** non-destructively (original untouched) |
| Second-brain skills | `~/Code/notes-skills/skills` | `.claude/skills/second-brain-{ingest,query,lint}` | **copied** non-destructively (original untouched) |
| Board MCP server | `mcp/create-case-server` | `mcp/board-server` | `git mv` — **history preserved** (same repo) |

The externally-copied parts (vault, second-brain skills) were **copied, not moved**, so their full git
history still lives in their **origin repos** (`~/Code/notes-vault`, `~/Code/notes-skills`). The
two in-repo relocations (board → `board/`, `create-case-server` → `board-server`) used `git mv`, so
their history follows them here.

### Grafting full history later (optional)

If you ever want the externally-copied parts to carry their original git history *inside* this repo,
graft it with `git subtree` (run from the monorepo root). This is optional — the originals remain the
source of truth for history.

```bash
# Vault — graft history from the notes-vault repo
git remote add notes-origin ~/Code/notes-vault
git fetch notes-origin
# After removing the plain copy at vault/my-personal-thoughts-vault and committing that removal:
git subtree add --prefix=vault/my-personal-thoughts-vault notes-origin main

# Second-brain skills — graft history from the notes-skills repo
git remote add second-brain-origin ~/Code/notes-skills
git fetch second-brain-origin
git subtree add --prefix=.claude/skills second-brain-origin main
```

(Adjust the branch name and the `--prefix` subpath to match each origin repo's layout.)

## Retired: the old host-side git auto-sync

The previous setup synced the notes vault to git from the host via a `sync.sh` script driven by a
**launchd** job (`com.example.notes-sync`). **That mechanism is not part of this monorepo.** Periodic
work is now triggered **only** by **Cowork scheduled tasks** (see `recipes/` and [Spec](../architecture/spec.md) §5) — there
is no host-side cron, launchd, or shell script in this repo, and at the end of the build nothing runs
on our side.

The old launchd job lives on the user's machine, outside this repo, so it must be stopped there by
hand. On the machine that had it loaded:

```bash
# Modern macOS (preferred):
launchctl bootout gui/$(id -u)/com.example.notes-sync

# Older macOS (equivalent):
launchctl unload ~/Library/LaunchAgents/com.example.notes-sync.plist

# Then remove the plist so it doesn't reload at next login:
rm ~/Library/LaunchAgents/com.example.notes-sync.plist
```

(The original `sync.sh` and the old notes repo are likewise untouched by this migration — remove them
on your own machine only if you no longer want them.)

## Board persistence — durability decision

**Decision: accept single-machine durability for now.** The board persists to a **single JSON file**,
`board/data/cases.json` (read/written by `board/lib/store.ts` at `process.cwd()/data/cases.json`). This
is the simplest durable store for a local-first, single-machine product and is good enough today.

**Trade-off accepted:** the data is local to one machine and is not multi-device synced; concurrent
writers are not coordinated beyond the single Next.js process.

**Upgrade path (if/when multi-device is needed):** swap the file-backed store in `board/lib/store.ts`
for a **durable store** (e.g. SQLite/Postgres) or place `cases.json` in a **synced location** (an
iCloud/Dropbox-backed path, or the same git auto-sync pattern the vault uses). The HTTP API and case
model stay the same; only the store implementation changes. Revisit this when a second device enters
the picture.

## Store schema versions (`schemaVersion`)

The on-disk store carries a `schemaVersion` (`board/lib/types.ts`, `SCHEMA_VERSION`); `readDB`
migrates older files up to the current version on read (`store.ts` `migrate()`). All bumps to date are
**additive + back-compatible** — an older file always reads fine, with any new field defaulting empty.

- **v3 → v4 — `db.events[]` (calendar events).** Adds the optional `db.events?: CalendarEvent[]`
  array (calendar appointments; an event's `caseId` is the single source of truth for the case↔event
  link). **Purely additive:** old v3 files still read unchanged — a missing `events` defaults to `[]`,
  so a board with no appointments is indistinguishable from a pre-calendar board. **No new enums** —
  `CalendarEvent.domain` reuses `CaseDomain` / `VALID_DOMAIN`. Full design:
  [Calendar](../features/calendar.md).
- **v4 → v5 — `db.reminders[]` (reminders).** Adds the optional `db.reminders?: Reminder[]` array
  (lightweight nudges to CHECK / DO something; a reminder's `caseId` is the single source of truth
  for the node↔reminder link, pointing at any tier). **Purely additive + back-compatible:** old v4
  files still read unchanged — a missing `reminders` defaults to `[]`, so a board with no reminders
  is indistinguishable from a pre-reminders board. The only new enum is `ReminderStatus` /
  `VALID_REMINDER_STATUS`; `Reminder.domain` reuses `CaseDomain` / `VALID_DOMAIN`. Full design:
  [Reminders](../features/reminders.md).
- **v5 → v6 — reminders enriched + the reminder↔email link.** Adds three optional fields, **no
  structural store change** (`db.reminders[]` already arrived in v5): `Reminder.labels?: string[]`
  (catalog-backed `db.labels` ids — validated like a case's labels) and `Reminder.tasks?:
  ReminderTask[]` (a short `id`/`title`/`done` checklist, store-minted `REM-<n>-T<k>` ids) on the
  reminder, plus `MessageRecord.reminderId?: string` (the single source of truth for the
  reminder↔email link — a message may link to a case *and* a reminder). **Purely additive +
  back-compatible:** old v5 (and v4) files still read unchanged — a reminder with no `labels`/`tasks`
  and a message with no `reminderId` are exactly what you had. **No new enums:** `labels` are
  validated against `db.labels` (`assertKnownLabels`), and `ReminderTask` carries no status. The
  enrichment lets minor matters (a billing notice with two emails, a small check) land as a
  well-formed *reminder* instead of a case. Full design: [Reminders](../features/reminders.md).
- **v6 → v7 — `db.priorities[]` + `CaseRecord.starred`.** Adds the optional `db.priorities?:
  PriorityNote[]` array (free-text "what matters most right now" notes, lighter than a reminder —
  store-minted `PRI-<n>` ids, an optional `position` manual rank) and the optional
  `CaseRecord.starred?: boolean` favorite/pin flag (the star, settable on any tier). **Purely
  additive + back-compatible:** old v6 files still read unchanged — a missing `priorities` defaults
  to `[]` and an absent `starred` reads as not-starred, so a board with no priorities is
  indistinguishable from a pre-priorities board. **No new enums** (`PriorityNote` has no enum fields;
  `starred` is a boolean). Full design: [Priorities](../features/priorities.md).
- **v7 → v8 — `MessageRecord.url` (original-message deep-link).** Adds the optional
  `MessageRecord.url?: string` — the direct deep-link back to the **original** message (for Gmail the
  thread URL `https://mail.google.com/mail/u/0/#all/<threadId>`), captured at link time so the board/UI
  can jump straight to the source email. **Purely additive + back-compatible:** old v7 files still read
  unchanged — `migrate()` is a no-op for it (the `messages[]` array rides through verbatim), and an
  absent `url` simply means no deep-link. **No new enums.** Validated server-side by
  `board/lib/message-url.ts` (`normalizeMessageUrl`) as an absolute http(s) URL on every message write
  path (so the stored value is always safe to render as an `<a href>`). Full design:
  [board features](../features/board.md).
