---
name: board-organize
description: >
  The board's housekeeper — a periodic maintenance sweep that REORGANIZES the case
  tree into a clean Initiative ▸ Workstream ▸ Case hierarchy. It clusters orphans
  under Initiatives, splits grown ones into Workstreams, and renames and describes
  its own containers — ALWAYS grounded in the user's stated priorities (starred
  nodes, P0/P1, priority notes) and NEVER renaming, re-homing, or archiving
  anything a human placed or named by hand. It does not triage messages, move
  lanes, set labels, or send anything. Weekly it also runs the STALENESS LENS —
  chasing the most starved obligations with researched next steps and
  board-placed time blocks ("chase what's slipping"). Use when the user says
  "organize my board", "tidy / clean up the board", "group my cases into
  initiatives", "rename / merge my initiatives", "re-balance the hierarchy",
  "file my orphan cases", or when the scheduled board-organize sweep runs.
---

# Board → Organize (the hierarchy housekeeper)

This skill **reorganizes the existing board** into a clean three-tier tree. The
reconcilers (`/mail-to-board`, `/whatsapp-triage`) deliberately create every new
matter as a **flat standalone case** — one clean card per matter — and leave the
*structure* to this sweep. This skill is the only owner of hierarchy: it clusters
related cases under **Initiatives**, splits a grown Initiative into **Workstreams**,
dedups duplicate containers, and keeps the user's priorities visible. It writes to
the board **only** through the **`board`** MCP — never `bash`/`curl` (Cowork's
sandbox blocks outbound HTTP; the tools exist for exactly this).

It owns **only the shape of the tree** — `kind`, `parentId`, container lifecycle,
and the **title / `summary`** of the containers *it* created (so it can rename a
sloppy Initiative to the canonical entity name and give it a one-line description).
It does **not** triage messages, create cases from channels, move lanes, add/close
tasks, set labels, edit a case's body, or send anything. Reconciliation is the
reconcilers' job; knowledge is the vault's job (the reconcilers submit it via
`/vault-operations`); this skill files and labels the *structure* of what already
exists.

The sweep also runs a **weekly staleness lens** (cos-ops#24) — the one deliberate
exception to "never touch tasks / events": it ranks the board's most-starved
obligations, fills a researched next step into a starving case's task
(`detail`/`dueAt`), and places one linked *timed* chase block. It still never
triages messages, moves lanes, sets labels, or sends anything — see STEP 7.

> **Guardrail 1 — the human's hand wins.** The board is a *shared* surface. **Never
> re-home a node a human placed by hand.** Only an `agent`-placed or never-placed
> case is yours to move; a human's `parentId` is frozen, exactly like any other
> manual edit. STEP 3 is the contract — read it before any `set_parent` /
> `regroup_cases`.

> **Guardrail 2 — never bury or drop a priority.** A starred node, a `P0`/`P1`
> case, or a case named by a priority note is *pinned intent*. Surface it, anchor
> Initiatives on it, keep it shallow — and **never `archive_case` a starred node**
> (archiving silently drops it off the Priorities surface even though the star is
> still set). STEP 1 grounds the whole sweep in `get_priorities`.

---

## STEP 0 — Read the auto-sync switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON** if the file
or key is missing). State the mode once at the start of the run.

- **`autoSync: true` (auto mode).** Apply the **safe, deterministic** re-homes
  automatically (STEP 6 defines exactly which), and **`propose`** every judgment
  call. Report every write so the user can review.
- **`autoSync: false` (approval mode).** Apply **nothing** directly. Prepare the
  whole reorganization and route **every** consequential move through **`propose`**
  (→ `list_pending` → the human `approve`/`reject`s). Read-only context-gathering
  (`get_priorities`, `get_tree`, `list_initiatives`, `search`, `get_case`) needs no
  confirmation.

## STEP 1 — Ground in the user's priorities (`get_priorities` FIRST)

Before touching the tree, call **`get_priorities`** (the `board` MCP). It returns,
in one shot, the user's stated focus:

- **Starred nodes** — the user's pinned Initiatives / Workstreams / Cases.
- **Priority notes** (`PRI-…`) — free-text lines in the user's own words. They link
  to **no** case id, so you must **match them by meaning** to the cases on the
  board (a note *"close the Acme onboarding"* → the Acme case).
- Plus, on every case you load later, the per-case **`priority`** enum (`P0`–`P3`).

Treat the starred set, the note-matched cases, and every `P0`/`P1` as **pinned
intent** for the rest of the sweep:

- **Surface, don't bury.** When you form an Initiative around an entity that has a
  pinned case, make that case the **anchor** and keep it directly visible — never
  tuck a pinned case three levels deep inside a new Workstream.
- **Never archive a starred node** (Guardrail 2). If a starred node looks stale or
  empty, **flag it** — don't archive it.
- Reorganizing is otherwise **safe** for priorities: notes reference nothing, the
  star is a field on the case keyed by its own id, and a re-parent patches only
  `parentId` — so `set_parent` / `regroup_cases` / `create_initiative` never break
  a star or a note. The *only* trap is archiving a starred node.

## STEP 2 — Enumerate the board, partitioned by domain

Build the working picture per **`domain`** (`work` and `life` are organized
independently — never group a `work` case under a `life` Initiative or vice versa).
For each domain:

1. **`get_tree`** (and **`list_initiatives`**) — the current Initiative ▸ Workstream
   ▸ Case outline with rollups. This is the structure you dedup against, so you
   **reuse** an existing container instead of minting a near-duplicate.
2. **`search`** — the **only** read that surfaces **Trash** (`get_tree` /
   `list_initiatives` hide soft-deleted nodes). Run it before creating any
   container so you don't duplicate a soft-deleted Initiative or matter.

From this, identify the two things the sweep acts on:

- **The orphans** — top-level **leaf cases** with no `parentId` (the flat cards the
  reconcilers dropped). These are your filing candidates.
- **The containers** — existing Initiatives / Workstreams, and **who authored
  each** (STEP 3). Human-created containers are authoritative: reuse them, never
  duplicate, rename, or dissolve them.

## STEP 3 — The manual-action guard (FREEZE human placements) — before any move

This is the answer to *"the agent reshuffled cards the user had filed on purpose."*
It must not. The board attributes every edit as `human` or `agent`; that
attribution is what licenses a move.

Before you re-home **any** case, **`get_case`** it and read its **"⚠ Manual actions
by the user (human)"** block (the `manualActions` field over HTTP). Then:

1. **A `parentId` a human set by hand is FROZEN.** If the case's placement (or
   detachment to top-level) appears in its manual actions, **never** `set_parent` /
   `regroup_cases` it — treat `parentId` like any other human-set field. A case a
   human deliberately parked at top-level is *not* an orphan; leave it.
2. **You may freely revise your OWN prior agent placements.** A `parentId` set by
   `agent` (you, on an earlier sweep) is yours to refine — that is how re-runs
   converge instead of fighting themselves.
3. **An unplaced case (no `parentId`, no manual action on it) is fair game.** Filing
   a never-placed orphan into a container is *not* re-homing a human placement — it
   is exactly the sweep's job.
4. **Human-created containers are authoritative; agent-created ones are yours.** File
   agent-/unplaced orphans *into* a human's Initiative when they belong, but **never
   re-title, re-parent, archive, or re-summary a container the human built or
   renamed** — at most `propose` a suggestion. A container *you* created on an earlier
   sweep, by contrast, is yours to rename, re-summary, merge, or retire (STEP 5). When
   `get_case` shows the human edited a container's `title`/`summary` by hand, that
   field is frozen even if the container itself was agent-created.
5. **When in doubt, `propose` — don't move.** A message is evidence; a manual action
   is law. If you can't tell who placed a case, leave it and surface it.

> You only need `get_case` on cases you actually intend to move — not the whole
> board. Cluster first (STEP 4), then `get_case` the move candidates.

## STEP 4 — Cluster & file (the organizing rules)

The heart of the sweep. Cluster the **non-frozen** orphans, then file them with
**concrete, firing triggers** — not vibes.

**Cluster key (in priority order):** the resolved **entity** (`vaultLinks`) first —
it is the single strongest signal and the same key the reconcilers stamp — then the
topic / title, shared **labels**/`tags`, and a shared counterpart on linked
messages. Everything about one person, client, or relationship is one cluster.

| Situation | Action | Tier |
|---|---|---|
| **A lone orphan with no kin** on the board | Leave it **standalone** (top-level case). Don't mint a container for one case. | — |
| **≥2 active cases share an entity / relationship** and an Initiative for it **already exists** | `regroup_cases(ids, parentId)` the agent-/unplaced ones **under the existing Initiative** (reuse, don't duplicate). | **auto** |
| **≥2 active cases share an entity / relationship** and **no** Initiative exists | `create_initiative` named for the entity/relationship, then `regroup_cases` the agent-/unplaced siblings under it. | **auto** if the entity match is unambiguous; else **propose** |
| **An Initiative has grown ≥2 distinct sub-threads**, and a sub-thread holds **≥2** cases | `create_workstream(title, initiativeId)` for the sub-thread, then `regroup_cases` those leaves under it. | **propose** |
| **An Initiative has one coherent thread** | Keep its cases **directly under the Initiative** — no Workstream. (Don't make single-case Workstreams.) | — |
| **An orphan clearly belongs under a human-built Initiative** | File it there with `set_parent` / `regroup_cases` (it's unplaced, so allowed — STEP 3.3/3.4). | **auto** |

**The two thresholds, stated plainly:** a **2nd** related case is what earns an
**Initiative** (one orphan stays flat); a **Workstream** is earned only when an
Initiative carries **≥2 distinct multi-case threads** (otherwise cases hang straight
off the Initiative — the model allows it).

**Naming convention (keeps future sweeps deduping cleanly):**

- **Initiative** = the canonical **entity / relationship / program** name — reuse
  the exact `vaultLinks` entity title where one exists (`Acme Corp`, not
  `acme stuff`). Consistent names are what let the next run reuse instead of
  duplicate.
- **Workstream** = the **sub-thread / phase** (`Contract renewal`, `Onboarding`,
  `Support escalation`).
- Always **reuse over near-duplicate**: if a fuzzy match to an existing container
  exists, file under it (or `propose` the merge) rather than minting a sibling.

**Priority overlay:** if a cluster contains a starred / `P0` / note-matched case,
**anchor** the Initiative on it and keep it shallow (STEP 1).

**Legality is the board's job, not yours.** `set_parent` / `regroup_cases` /
`create_workstream` reject illegal moves with a **400 and a reason** — depth ≤ 3,
parent must be a container, no cycles, a Workstream must sit under an Initiative and
hold only leaf cases, and a Workstream can't detach to top-level (convert it to an
Initiative instead). `regroup_cases` is **batch-atomic**: one bad id rejects the
whole batch. So you don't pre-check tier rules — you **do** pre-check human
authorship (STEP 3), which the board does *not* enforce.

## STEP 5 — Normalize & tidy containers (propose-only; agent-created only)

The reconcilers never make containers, so every Initiative/Workstream was created
either by a **human** (authoritative — at most `propose` a suggestion, never
overwrite) or by **you** on a prior sweep (yours to clean up). All of the below are
lossy or judgment calls, so **`propose`** them — never auto-apply — and
**flag-don't-guess** when the least bit unsure.

**A. Rename a sloppy container** → `update_case(id, { title })`. An agent-created
Initiative whose title isn't the canonical entity (`acme stuff`, `Untitled`, `Misc
client work`) should be renamed to the exact `vaultLinks` entity title (`Acme Corp`)
so future sweeps reuse it instead of spawning a duplicate. A Workstream should read as
its sub-thread / phase. **Never rename a human-named container** (STEP 3.4).

**B. Give a container a one-line description** → `update_case(id, { summary })`. An
agent-created container with no `summary` gets a single factual line naming the
entity / relationship and what it spans (*"Acme Corp — renewal, support, and billing
threads."*). Don't rewrite a `summary` a human wrote.

**C. Merge duplicate Initiatives for the same entity.** Pick the **survivor** (prefer
the human-created, the starred, or the better-named one), then — in this exact order,
because archiving a container does **not** cascade to or detach its children:
1. `regroup_cases(childIds, survivorId)` — move every child out of the shell;
2. optionally `update_case(survivorId, { title, summary })` — canonicalize it;
3. `archive_case(shellId)` — retire the now-empty duplicate.
**Never archive a starred shell** — if the duplicate is starred, flag the collision
and let the human choose the survivor.

**D. Flatten a single-case Workstream** → `regroup_cases([caseId], initiativeId)` to
lift the lone case up to its Initiative, then `archive_case` the empty Workstream
(same regroup-before-archive order).

**E. Retire an empty agent-created container** (no children, not starred, stale) →
`archive_case`. Deletion is **soft** everywhere (`archive_case` ≡ `delete_case` — both
just stamp `archivedAt`, restorable with `restore_case`; permanent removal is an
automatic retention sweep, never an API call), so a wrong call is always reversible —
but still `propose` it.

**F. Surface a buried or archived priority** (a starred / `P0`/`P1` / note-matched case
tucked deep or soft-deleted) → propose lifting it shallow / `restore_case`; never
silently archive one.

> **Order matters (the soft-delete nuance).** `archive_case` only stamps the target —
> it does **not** detach or hide its children. An archived parent simply drops out of
> the visible tree, so its orphaned children pop back to **top-level** until refiled.
> Always `regroup_cases` the children to their new home **first**, then archive the
> empty shell — never the reverse.

## STEP 6 — Auto vs propose (the two-tier action policy)

In **auto mode**, only these are safe to apply directly — everything else is a
`propose`:

- **AUTO-APPLY** — deterministic and unambiguous: grouping **≥2** orphans that share
  an **exact `vaultLinks` entity** (all `agent`-placed or unplaced) under an
  **existing** Initiative for that entity, or under a **new** Initiative named for
  that exact entity. Filing an unplaced orphan under a clearly-matching human-built
  Initiative.
- **PROPOSE** — every judgment call: a new Initiative for a **fuzzy / thematic**
  cluster, **splitting** an Initiative into Workstreams, **renaming** or
  **re-summarising** a container, **merging** Initiatives, **flattening** a single-case
  Workstream, **archiving** any container, anything touching a node that *might* be
  human-placed or human-named, and **anything the least bit ambiguous**.

In **approval mode**, *everything* consequential is a `propose`.

## STEP 7 — The staleness lens (weekly): chase starving obligations

The one deliberate exception to "never touch tasks / events" (see the intro above).
It ranks the board's most-starved obligations, researches the concrete next step,
writes it into the obligation's own record, and places one linked *timed* chase
block — never triaging messages, moving lanes, or setting labels.

1. **Cadence — and the gate.** Run STEP 7 **only** when the invocation names the
   lens — the `automation.json` catalogue's dedicated weekly row, *"Run
   /board-organize — include the weekly staleness lens"* — or when the user asks
   for it in so many words. On **every other** run of this skill (the 2–6-hourly /
   daily tidy, a plain "organize my board") **skip straight to STEP 8**: the lens
   is not idempotent on a frequent cadence — each pass chases the *next* three
   entries (a chased entry leaves the rank once its block is placed), so an
   ungated 2-hourly task would carpet the calendar with chase blocks by evening.
   Within one week a re-run no-ops only for the three already chased.

2. **Read, then sweep your own leftovers.** Call **`get_needs_attention`** (the
   `board` MCP) and take its `starving` list — the worst-first aging rank across
   cases, open reminders, and unanswered messages. Work the **top 3** unresolved
   entries; the *whole* list still goes into the report (STEP 8) regardless.

   **Orphan-block hygiene, before chasing anything new.** The daily
   `reminders-review` sweep can dismiss a reminder whose chase block *this* lens
   placed yesterday, and it knows nothing about calendar events. So `list_events`
   over the next 7 days and look for a FUTURE block this lens placed —
   recognisable **only** by the lens marker in its title: the `(CASE-n)` /
   `(REM-n)` / `(MSG-n)` suffix every chase block carries (step 5 below) — whose
   obligation is no longer live (the reminder is no longer open, the message is
   no longer unanswered, the case is done/archived). That is a stale artifact of
   your **own** prior run: `delete_event` it (auto mode: delete and report;
   approval mode: into the batch). **A linked event WITHOUT the marker is never
   touched** — a `caseId` link alone proves nothing (a human's "closing meeting
   with Acme" is linked exactly the same way), `delete_event` is permanent (no
   trash), and Guardrail 1 says the human's hand wins. Clean up only what *this
   lens* minted, proven by the marker — never someone else's event.

3. **Research — vault first, web only as a fallback.** For a **case** entry:
   `get_case` (its tasks, `vaultLinks`, and the manual-actions block, per STEP 3),
   then query the **vault** (the `vault` MCP `query` tool, per `/vault-operations`
   — a vault answer is knowledge-as-recorded; verify any board claim in it against
   the `board` MCP before acting on it); fall back to a **web search only when the
   vault does not know**. The deliverable is the concrete next physical action — a
   phone number, the portal path, "they open 08:00" — not advice.

4. **Write the step back.** `update_task` on the case's first open task —
   `detail` = the researched step, `dueAt` when a real deadline exists; if the
   case has no open task, `add_task` with the action as title and the same
   fields. **Never overwrite a human-written task text** (the manual-actions
   check from STEP 3) — a human-authored task gets the research as a `propose`d
   `update_case` note instead, or is flagged in the report.

   For a **reminder** entry, the reminder *is* the step: `update_reminder` its
   `detail` with the researched specifics **only when `detail` is empty**. A
   reminder carries no authorship trail (unlike a case's activity log), so a
   non-empty `detail` must be assumed human-written — leave the record untouched
   and put the research in the chase block's description and the report instead.
   Precedence with the daily `reminders-review` sweep is **one-directional** —
   that sweep owns the open/close/dismiss verdict; this lens **never** closes or
   dismisses a reminder, and it **skips the chase** on any reminder carrying a
   pending close/dismiss proposal (`list_pending`) — never allocate time for
   something awaiting a "still relevant?" human call.

   For a **message** entry, the chase *is* the reply: put it in the report and
   the proposed block. Never mark it answered — only a real reply does that
   (that's `unanswered-messages`' watermark, not this lens's).

5. **Allocate — the board places; you choose when and within what.** One block
   per chased obligation via the **calendar** MCP's **`create_event`** with
   **`place`** — never explicit `startTime`/`endTime`, never `allDay`:
   - **You own the judgment inputs**: the `date` (the soonest sensible day within
     the next 7, honouring what the research found — office hours, urgency) and
     the candidate `windows` in preference order, reflecting the obligation's
     real-world constraint. Default for an admin/office chase: a wide business
     window (e.g. `09:00`–`17:00`, clipped tighter when the research names
     opening hours) with **`policy: "within"`**. Only for a chase that genuinely
     cannot happen in business hours (a home errand): evening/morning windows
     with **`policy: "margins"`**.
   - **The board owns the arithmetic**: the earliest free gap, overlap against
     its own events AND your `busyWindows`, same-evening stacking, working-hours
     enforcement. Don't eyeball free slots from `list_events` — that is
     placement logic, and this skill adds none of its own.
   - **Pass `busyWindows`** for the target date from your own read of the user's
     REAL calendar when the session has a calendar connector (per-call, used and
     discarded — never stored). Without one, say so in the report — the board
     still avoids its own events, and the proposal degrades honestly (it
     proposes; it does not assert the slot is free).
   - `durationMin` 30–60 by the action's size; `caseId` links the block (for a
     reminder/message chase, link its case when one exists, else standalone);
     title = the action, **suffixed with the lens marker — `(CASE-n)` /
     `(REM-n)` / `(MSG-n)` — on EVERY chase block** (the only thing the hygiene
     sweep in step 2 may delete by; a `caseId` link is not a marker — a human's
     linked event has one too); **description = the payload**
     (the researched step verbatim — the lock-screen test: doable in the ninety
     seconds before a meeting).
   - On **409 `no_free_slot`** → retry the next preferred date inside the 7-day
     horizon. On **409 `outside_working_hours`** → try the next working day.
     Nothing fits in the horizon → the obligation goes in the report as
     unallocatable this week — never silently dropped.

6. **Auto vs approval** (STEP 0's contract, extended). Auto mode: write the task
   details and place the blocks directly, and report every write. Approval mode:
   prepare everything and present **one** batched confirmation (obligation →
   researched step → proposed day/window), then apply. (The `propose` queue
   carries no calendar verbs, so batch-confirm is the approval-mode mechanism
   here, as the fitness push skills do.)

7. **Escalation framing.** An entry carrying "block passed N d ago" was chased
   before and was not acted on — say so plainly in the report (*"placed Tue
   10:30, passed untouched — re-ranked higher"*), because that phrasing is the
   nudge working.

## STEP 8 — Report (consolidated & idempotent)

Close with one report, grouped **by domain**, then by class:

- **Applied** (auto mode only) — each: *what moved / where / why* (`CASE-12` → under
  `Acme Corp`: shares `[[Acme Corp]]` with `CASE-7`).
- **Proposed** — the pending judgment calls, with the same *what / where / why*, and
  the `propose` ids so the user can `approve`/`reject`. Offer: *"Want me to apply any
  of these?"*
- **Surfaced** — priorities that need attention (a buried/empty starred node).
- **Starving (worst first)** — the ranked list STEP 7 read, what was researched and
  placed for the top 3, what could not be resolved (vault empty AND web empty → say
  so; a human-frozen task → flagged; unallocatable within the horizon → named), any
  entry that returned **escalated** (a passed, unactioned block), and any orphaned
  chase blocks the hygiene sweep removed.

Then stop. The sweep is **idempotent by construction**: an already-well-filed case
is no longer an orphan and is skipped; your own prior placements are refined, not
re-thrashed; proposals stay inert until approved; **a clean board no-ops**. Running
it more often is cheap and safe.

---

## Conventions (guardrails recap)

- **Board only, via the `board` MCP** (plus `calendar` for STEP 7's chase blocks and
  `vault` for its research). Never `bash`/`curl`. This skill owns **hierarchy**
  (`kind`, `parentId`, container lifecycle) and nothing else — no lanes, labels,
  messages, or sending — with ONE stated exception: the weekly staleness lens
  (STEP 7) fills a starving obligation's task fields and places a linked chase block.
- **`get_priorities` first; never archive a starred node.** Pinned cases (starred /
  `P0`/`P1` / note-matched) are surfaced and anchored, never buried.
- **Human placements are frozen.** `get_case` → `manualActions` before any move;
  only `agent`-placed or unplaced nodes are yours. Reuse human-built containers;
  never re-title/dissolve them.
- **Thresholds:** 2nd related case → Initiative; ≥2 multi-case threads → Workstream.
  A lone orphan stays flat; never a single-case Workstream.
- **Name Initiatives for the entity** (reuse the `vaultLinks` title); **reuse over
  duplicate**.
- **Normalize only your OWN containers (propose-only).** Rename sloppy agent-created
  Initiatives/Workstreams to the canonical entity name, give them a one-line `summary`,
  merge duplicates (regroup children **then** archive the shell), flatten single-case
  Workstreams, retire empty ones. Never rename / merge / archive a human-built or
  human-renamed container; never archive a starred one. Deletion is soft everywhere
  (restorable).
- **Trust the board for legality** (depth ≤ 3, container parents, no cycles,
  batch-atomic 400s); **you** enforce human authorship.
- **Auto-apply only deterministic same-entity grouping; `propose` every judgment
  call.** In approval mode, `propose` everything consequential.
- **Staleness lens ONLY when the invocation names it (weekly); vault before web;
  fill only empty fields — never overwrite human text** (a reminder's non-empty
  `detail` counts as human text). Blocks are timed, never all-day, placed by the
  board's `place` (you pick date + windows + `busyWindows`; it picks the slot),
  and every one carries the `(CASE-n)`/`(REM-n)`/`(MSG-n)` marker — the hygiene
  sweep deletes marked blocks only, never a bare linked event. Allocation is
  derived from the calendar — never store a "chased" flag.
- **Idempotent.** Re-runs converge; a clean board no-ops.

## Worked examples

> Three flat cases sit at top level in `work`: `CASE-7` *"Acme — contract redlines"*,
> `CASE-12` *"Acme — kickoff scheduling"*, `CASE-15` *"Acme — invoice question"*. All
> three carry `vaultLinks: ["Acme Corp"]`, all placed by `agent`, none starred.

- Same exact entity, ≥2 cases, no Initiative yet → **auto**: `create_initiative`
  *"Acme Corp"* (`work`), then `regroup_cases([CASE-7, CASE-12, CASE-15], <id>)`.
  They're one coherent thread → no Workstream. Reported under *Applied*.

> The *"Acme Corp"* Initiative now holds 8 cases spanning a **renewal negotiation**
> (3 cases) and a **support escalation** (3 cases), plus 2 one-offs. `CASE-7` is
> starred.

- Two distinct multi-case threads → **propose** two Workstreams, *"Renewal"* and
  *"Support escalation"*, and `regroup_cases` each thread under its Workstream — but
  **keep starred `CASE-7` directly under the Initiative** as the anchor, not buried.
  Reported under *Proposed*.

> `CASE-20` *"plumber — confirm Thursday"* sits flat in `life`, no kin, `vaultLinks:
> ["Marco the plumber"]`, no other Marco cases.

- A lone orphan with no kin → **leave it standalone.** Don't invent a container for
  one case.

> `CASE-31` is filed under Initiative *"Side project"* and its `manualActions` block
> shows the **human** moved it there.

- Frozen (STEP 3.1). Even if it looks like it belongs elsewhere, **don't move it** —
  at most `propose` and let the human decide.

> Two agent-created Initiatives sit in `work`: *"Acme Corp"* (5 cases, has a `summary`)
> and *"acme stuff"* (2 cases — `CASE-40`/`CASE-41`, both `vaultLinks: ["Acme Corp"]`,
> no `summary`). Neither is starred; both placed by `agent`.

- Same entity, duplicate shells → **propose a merge** (STEP 5.C), survivor *"Acme
  Corp"*: `regroup_cases([CASE-40, CASE-41], "Acme Corp"-id)` → `update_case` to keep
  the survivor's `summary` current → `archive_case` the empty *"acme stuff"* shell.
  Children moved **before** the archive. Reported under *Proposed*.

> An agent-created Initiative is titled *"misc"* with no description; its 3 cases all
> carry `vaultLinks: ["DevForge OSS Project"]`. Not human-named.

- **Propose a normalize** (STEP 5.A/B): `update_case(id, { title: "DevForge OSS
  Project", summary: "DevForge OSS sponsorship — onboarding + asset delivery." })`.
  No re-homing needed; just rename + describe. Reported under *Proposed*.

## What's Next

The reconcilers feed this sweep: **`/mail-to-board`** and **`/whatsapp-triage`**
create flat cases (one clean, entity-tagged card per matter) and leave structure to
this job. Run them on their channel cadence; run **`/board-organize`** on a slower
cadence (every few hours / daily) to file what they drop, and its **staleness lens**
(STEP 7) separately on a **weekly** cadence to chase what's starving. Schedule both
as Cowork tasks (`Run /board-organize`, and `Run /board-organize — include the
weekly staleness lens`); see the [skills README](../README.md) for the scheduling
playbook.
