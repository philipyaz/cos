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
work is now triggered **only** by **Cowork scheduled tasks** (see [Spec](../architecture/spec.md) §5) — there
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

**Decision: single-machine durability — the settled choice.** The board persists to a **single JSON
file**, `board/data/cases.json` (read/written by `board/lib/store.ts` at `process.cwd()/data/cases.json`).
This is the simplest durable store for a local-first product, and multi-device did NOT change it — it
stays one store on the hub (see the resolved multi-device note below).

**Trade-off accepted:** the store lives on one machine (the hub) and is not multi-device *synced* —
other machines are stateless clients, not replicas; concurrent
writers are not coordinated beyond the single Next.js process.

**Multi-device — decided: hub & spoke (not a synced store).** When the second device arrived, the
answer was **not** to swap the store for SQLite/Postgres or a synced `cases.json` — every such design
inherits merge conflicts and schema skew between two live stores. Instead the single file-backed store
**stays on one machine (the hub)**, reached over a private Tailscale network; a machine that runs
**agents** against it becomes a **spoke** (a stateless client whose board-facing wrappers point at the
hub's `BOARD_URL`), while a device that only **views** the board installs nothing (see below). Nothing syncs
because there is nothing to sync. The store implementation is unchanged; the HTTP API is the seam that
already made this possible.

A **spoke** is needed only where you want **agents** (Claude Code / Cowork) to act on the board — those
clients accept only *local* stdio MCP servers, so the wrappers run locally and forward tool calls to the
hub. To merely **view** the board from any other tailnet device you install nothing: the hub serves the
production board behind `tailscale serve`, and you open the portless `https://<hub>.<tailnet>.ts.net` in a
browser (full read/write UI — the browser writes through the same HTTP API). So a machine demoted in a hub
swap (`hub-handover`) can stay a **pure browser viewer** of the new hub — add `spoke-setup` to it only if
you also want agents there. See [Multi-device (hub & spoke)](../architecture/multi-device.md).

## Store schema versions (`schemaVersion`)

The on-disk store carries a `schemaVersion` (`board/lib/types.ts`, `SCHEMA_VERSION`); `readDB`
migrates older files up to the current version on read (`store.ts` `migrate()`). All bumps to date are
**additive + back-compatible** — an older file always reads fine, with any new field defaulting empty.

**The safe direction is one-way: code ≥ store.** The reverse — a board whose code is *older* than the
file on disk — is the one configuration that can destroy data: `migrate()` only knows the collections
of *its* version, so a write from old code would persist the reduced shape and silently drop every
newer collection. The store therefore **fails closed** (`store.ts` `SchemaAheadError`): when the
on-disk `schemaVersion` is ahead of the code's `SCHEMA_VERSION`, every write — any route, any caller —
is refused with `503 { error: "store-newer-than-code", disk, code, fix: "git pull" }`, while reads
keep serving as a **named degraded mode** (the reduced view; the SSE stream broadcasts
`degradedRead: true` and the board shows a full-width banner). The fix is always on the machine,
never the data: update the code (`git pull`) and restart the board.

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
- **v10 → v11 — the unanswered-messages fields** (`MessageRecord.needsAnswer?` / `answeredAt?` /
  `context?`). A message you still owe a reply to is the **same** `MessageRecord` carrying a status flag —
  `needsAnswer` (awaiting a reply), `answeredAt` (ISO; absent ⇒ still unanswered, set on mark-answered),
  and `context` (the one-sentence line shown in the view). **Purely additive + back-compatible:** old v10
  files read unchanged — `migrate()` is a no-op for them (the `messages[]` array rides through verbatim),
  and an absent `needsAnswer` reads as not-flagged. **No new enums.** The unanswered set is the pure
  predicate `needsAnswer && !answeredAt` (`board/lib/inbox.ts` `selectUnansweredMessages`), filled by the
  `/unanswered-messages` sweep and the board MCP tools, and cleared the moment you reply. Full design:
  [Unanswered messages](../features/unanswered-messages.md).
- **v13 → v14 — the Body add-on + the context-first nutrition redesign.** Introduces the foundational
  **[Body](../features/body.md)** add-on as the single owner of body identity (`db.bodyProfile` —
  sex / date-of-birth / height / training status / resistance-trains), the weight + body-composition
  series (`db.weights`, **re-homed** off nutrition, now carrying optional body-fat % / lean mass / waist),
  and a **free-text** objective (`db.bodyObjective` — `goalText` + a `targetWeightKg` anchor, **no**
  pick-list). On the nutrition side it adds `db.dietProfile` (allergies / dietType / notes / the
  "views on diet" philosophy) and `db.nutritionTargets[]` (the **agent-authored** daily targets,
  modelled on `coachingArtifacts`). **`migrate()` is clock-free + idempotent:** it **synthesizes**
  `bodyProfile` + a prose `bodyObjective` from the legacy `db.nutritionGoal` (the date of birth is
  fabricated from the legacy `age` via a frozen anchor year, so no `new Date()` is ever read), keeps
  `db.weights` verbatim (ownership moves to `body` — a manifest change only), and **stops carrying
  `db.nutritionGoal` forward** (it is dropped on the next write — downgrade-safe on read). The
  deterministic nutrition targets **engine** (`board/lib/nutrition-targets.ts`) is **retired** — the
  board no longer computes a recommendation; the agent authors it. The Fitness `AthleteProfile` **drops**
  its duplicated `level` / `currentWeightKg` / `targetWeightKg` (training status now lives on
  `bodyProfile`, weight/target on the body add-on). **New enums:** `TrainingStatus`,
  `NutritionTargetKind`; **removed:** `AthleteLevel`, `NutritionGoal`. Body **hard auto-enables** under
  Nutrition or Fitness. Full design: [Body](../features/body.md) + [Nutrition](../features/nutrition.md).
- **v14 → v15 — the per-case vault-ingest RECEIPT.** Adds the optional
  `CaseRecord.vaultIngestedAt?: string` — an ISO timestamp set **only** by
  `POST /api/cases/vault-receipt`, after the agent confirms the vault MCP reports a
  `completed` ingest that named the case (never on a `failed`/`cancelled`/`interrupted` job —
  the field means *landed*, never *attempted*). **Purely additive + back-compatible:** old v14
  files read unchanged — `migrate()` is a no-op for it (the optional rides through
  `migrateCase`'s spread verbatim, exactly like `starred` (v7) and `MessageRecord.url` (v8)),
  and an absent receipt reads as *the vault has never been told about this case* (fail-closed).
  **No new enums.** The coverage read (`GET /api/cases/vault-coverage` / `get_vault_coverage`)
  answers *"what has the vault never been told?"* — cases carrying `vaultLinks` whose receipt
  is absent or older than the case's own `updatedAt` — the deterministic alarm for a capture
  pipeline that fails silently. Full design: [vault-async](vault-async.md).
- **v15 → v16 — `db.shoppingItems[]` (the persistent shopping list).** Adds the optional
  `db.shoppingItems?: ShoppingItem[]` array (store-minted `SHOP-<n>` ids; `category` deliberately
  includes non-food `household` / `personal-care`; `status` `needed` → `bought` stamps `boughtAt`
  server-side on the transition, any other status clears it; `source` + a soft `sourceRef`). **Purely
  additive + back-compatible:** old v15 files read unchanged — `migrate()` carries the array forward
  when present and a missing key defaults to `[]`, no backfill. **New enums:** `ShoppingCategory`,
  `ShoppingStatus`, `ShoppingSource`. The candidates read (`GET /api/nutrition/shopping/candidates`
  / `get_shopping_candidates`) is computed on read, never persisted. Full design:
  [Nutrition](../features/nutrition.md#the-shopping-list-v16).
- **v16 → v17 — `db.triageDecisions[]` (the mail-triage drop record).** Adds the optional
  `db.triageDecisions?: TriageDecision[]` array — the store's first **policy** collection: one row per
  `(sender, source, reason)` (store-minted `TD-<n>` ids; the sender is normalised to its addr-spec), a
  fact ("this sender's mail was judged noise") rather than a log of dropped emails; a repeat drop bumps
  `count`, a human `confirm` stamps `reviewedAt` (sender-scoped: every reason row of that sender is
  settled), a `reverse` sets `status: "reversed"` and fails every later drop of that sender closed
  (403 `sender-reversed`). **Purely additive + back-compatible:** old v16 files read unchanged —
  `migrate()` carries the array forward when present and a missing key defaults to `[]`, no backfill.
  **New enums:** `TriageDropReason`, `TriageDecisionStatus`. The dropped:promoted ratio and the
  first-time-dropped set are computed on read, never persisted. Full design:
  [Triage skills](../architecture/triage-skills.md).
- **v17 → v18 — `CalendarEvent.status` (the event lifecycle).** Adds the optional
  `status?: "confirmed" | "tentative" | "cancelled"`; absent ≡ `confirmed` so every pre-v18 event
  keeps its meaning; no backfill (`migrate()` is a no-op — the `events[]` array rides through
  verbatim). A `"cancelled"` event stops blocking `planPlacement` (and the starving-obligations
  allocation) and renders struck-through; `"tentative"` still blocks. **Purely additive +
  back-compatible:** old v17 files read unchanged. **New enum:** `EventStatus`. Full design:
  [Calendar](../features/calendar.md), [Placement](../features/placement.md#the-engine-contract).

!!! note "Payload-internal keys never bump the schema"
    Some records carry a `payload` the board stores **verbatim** (a `CoachingArtifact`'s training plan,
    for instance). Keys the board itself writes *inside* such a payload — `eventId` (the calendar-push
    receipt, #81) and `status` / `movedTo` (the per-day outcome, #94) on a training plan's `days[i]` —
    ride along without a `SCHEMA_VERSION` bump: an older board round-trips the payload unchanged on a
    targeted write. The consequence the guard cannot catch: a **pre-#94 board that re-saves a whole
    week** (`save_training_plan`) carries only `eventId` forward and silently drops every recorded
    outcome, while the store's `schemaVersion` still reads current. The rule stays the same —
    [never run older code against this store](upgrading.md) — the ledger just names the keys.
