# Cos skills — run them on demand, or on a schedule

This directory holds the Cos **operator skills**. You can invoke any of them on demand (just ask — *"what
haven't I answered?"*, *"organize my board"*), **and** most of them are designed to run **unattended** as
**Claude Cowork** *scheduled tasks* (Cowork Desktop → **Scheduled Tasks** → "every X min").

There is deliberately **no host-side cron / launchd / shell script** — Cowork's scheduled tasks are the
only periodic trigger, and **you** set the cadence. To schedule a skill you don't paste its body; you
paste a **one-line trigger** (`Run /<skill> …`), and the skill loads from disk — so the skill *is* the
procedure. (Loading from disk means a skill can split its depth into `references/` and still be
one-line-triggered; see **[Authoring a skill](#authoring-a-skill--best-practice)** below.)

This page indexes the skills that make good recurring automations, with **use-case ideas** to spark your
own — because a scheduled task is just a prompt that happens to run on a timer.

## Installing a skill into Cowork

Cowork installs a skill from a **`.zip`**, not from a folder on disk — so every skill here is also
packaged as a ready-to-upload bundle in **[`../skill-bundles/`](../skill-bundles/)**, one zip per
skill (its `SKILL.md`, its `references/`, and any other supporting file, with the skill folder at
the archive root).

1. **Cowork Desktop → Settings → Capabilities → Skills → Upload skill.**
2. Pick `board/.claude/skill-bundles/<skill>.zip`.
3. The skill is now invocable as `/<skill>` — on demand, or as the trigger of a scheduled task
   (below).

The bundles are **generated**, never hand-edited. After changing any skill, rebuild and commit:

```bash
node scripts/pack-skills.mjs          # rewrite the bundles that changed + regenerate the catalog below
node scripts/pack-skills.mjs --check  # what CI runs — fails if a bundle OR the catalog is stale
```

CI enforces this on every PR, because a stale zip silently keeps running last month's version of a
procedure. See **[`../CLAUDE.md`](../CLAUDE.md)** for the full authoring + packaging philosophy.

<!-- BEGIN GENERATED: automation-catalog — the classes/cadences live in automation.json; edit THAT and run node scripts/pack-skills.mjs. Hand-edits inside this block are overwritten. -->

## The skills worth scheduling

Paste the trigger into a new Cowork Scheduled Task at the suggested cadence — the cadence is a suggestion, yours to adjust in Cowork; the trigger is what makes the task run the skill's actual procedure.

| Skill | What a scheduled run does | Trigger to paste | Suggested cadence |
|---|---|---|---|
| **[`/unanswered-messages`](./unanswered-messages/SKILL.md)** | Surfaces the WhatsApp + Gmail messages still **awaiting your reply** on the board's **Unanswered** panel, and clears them once you've replied. Read-only on both channels. | `Run /unanswered-messages` | ~15 min |
| **[`/mail-to-board`](./mail-to-board/SKILL.md)** | Reconciles your Gmail (received **and** sent) onto the board — links messages to cases, advances tasks, moves lanes, dedups — and **never** undoes your manual edits. | `Run /mail-to-board` | ~10–15 min |
| **[`/whatsapp-triage`](./whatsapp-triage/SKILL.md)** | The same reconciliation for **WhatsApp** (DMs **and** groups), turning chats into tracked cases on the board. | `Run /whatsapp-triage` | ~15 min |
| **[`/board-organize`](./board-organize/SKILL.md)** | Tidies the case tree into a clean **Initiative ▸ Workstream ▸ Case** hierarchy, grounded in your starred / priority items — never re-homing what you placed by hand. | `Run /board-organize` | every 2–6 h / daily |
| **[`/board-organize`](./board-organize/SKILL.md)** | The STALENESS LENS on top of the normal tidy: reads the starving rank (get_needs_attention), researches the top 3 (vault first, web only as fallback), writes the concrete next step into each case's task, and places a linked timed chase block via the board's own placement. | `Run /board-organize — include the weekly staleness lens` | weekly |
| **[`/reminders-review`](./reminders-review/SKILL.md)** | Reviews every **open reminder** and **closes** the ones already done or past their moment — auto-closing only what's *proven* done (finished checklist, linked case closed, delivery date passed) and **proposing** the rest (cold job-alerts, lapsed RSVPs) — so the reminders list stays a live to-do surface, not a graveyard. | `Run /reminders-review` | daily / every few hours |
| **[`/nutrition-chef`](./nutrition-chef/SKILL.md)** | Takes stock of the pantry — what's fresh, what's low, what's expiring — and drafts the weekend **shopping list**, after the standing meal-plan reconcile. | `Run /nutrition-chef take stock of the pantry and draft the shopping list` | Friday (before the weekend shop) |
| **[`/nutrition-chef`](./nutrition-chef/SKILL.md)** | Plans the week's meals from what's on hand (preferring what's expiring), honoring allergies + diet, optionally onto the calendar — after the standing meal-plan reconcile. | `Run /nutrition-chef plan this week's meals, preferring what's expiring` | Sunday |
| **[`/fitness-pre-workout-brief`](./fitness-pre-workout-brief/SKILL.md)** | Reads the board's deterministic **form score** (HRV / sleep / resting-HR / load breakdown), last night's sleep, recent training load, the athlete profile and today's planned session, then authors + persists **today's go / caution / rest brief** — upserted by date, one per day. | `Run /fitness-pre-workout-brief` | daily (morning) |
| **[`/fitness-training-plan`](./fitness-training-plan/SKILL.md)** | Authors + persists the **new week's training plan** — grounded in the athlete profile, the body goal, the recovery state and the last ~4 weeks of workouts, varied against the last few plans with progressive overload toward the goal date — upserted by ISO week. | `Run /fitness-training-plan` | weekly (Sunday evening / Monday morning) |
| **[`/fitness-weekly-review`](./fitness-weekly-review/SKILL.md)** | The look-back over the training week — planned vs done, sleep / HRV / resting-HR trends, the daily form scores — authored into a scored review with 3–5 recommendations and a next-week focus, persisted per ISO week. | `Run /fitness-weekly-review` | weekly (end of week, before the new plan) |

## Called skills — installed, invoked by other skills

Not every skill here is meant to be scheduled on its own — but install its bundle all the same: a delegation to a skill that is not installed is a **silent no-op**, not an error.

- **[`/vault-operations`](./vault-operations/SKILL.md)** — called by `/mail-to-board`, `/whatsapp-triage`, `/fitness-health-data` — The submit-then-poll procedure for the vault MCP's async `ingest` and synchronous `query`. It has a bundle and installs like every other skill — it's just never scheduled standalone: the sweeps invoke it for the vault half of their runs, and you can call it directly ("ingest this into my vault").

## On demand only — deliberately not on a timer

These respond to a moment — a question asked, a circumstance changed, data handed over — so absence from the table above is a decision, not an omission:

- **[`/body-profile`](./body-profile/SKILL.md)** — The body add-on's state editor — set your goal / identity, log a weigh-in, read BMR / maintenance / trend. It runs when something changed or you step on the scale — a conversation, not a timer.
- **[`/fitness-athlete-profile`](./fitness-athlete-profile/SKILL.md)** — The training-focus editor — goal + goal date, weekly availability, sports, equipment. You change it when your circumstances change; nothing rots if it never runs on a timer.
- **[`/fitness-coach`](./fitness-coach/SKILL.md)** — The fitness router — fires on a generic "help me with my fitness" and points at the right focused skill. A router has nothing for a timer to trigger.
- **[`/fitness-correlations`](./fitness-correlations/SKILL.md)** — Interprets the board's sleep ↔ performance correlations when you ask the question (the board computes + persists the stats deterministically at that moment). Nothing accumulates unread between runs.
- **[`/fitness-health-data`](./fitness-health-data/SKILL.md)** — The fitness data plane — ingests the Apple-Watch data you hand it, answers reads, fixes bad rows, pushes the health report to the vault. Ingestion is user-initiated by construction (the agent has no path into Apple Health), so a timer would only ever find nothing new.

<!-- END GENERATED: automation-catalog -->

## Use-case ideas (steal these)

- **"What do I owe a reply to?"** — `/unanswered-messages` every 15 min keeps a live list of the DMs and
  emails you haven't answered, so nothing slips.
- **Inbox → board on autopilot** — `/mail-to-board` and `/whatsapp-triage` every ~15 min keep the board
  in sync with your conversations, no manual data entry.
- **Wake up to a tidy board** — `/board-organize` overnight (or every few hours) files the orphan cases
  the reconcilers leave behind into a clean hierarchy.
- **A reminders list that doesn't rot** — `/reminders-review` daily closes the parcels that arrived, the
  events that passed, and the job-alerts gone cold, and *asks* you about the deadlines it can't verify —
  so the open list stays things you actually still need to do.
- **Sunday meal prep** — `/nutrition-chef plan this week's meals, preferring what's expiring` once a week
  turns your pantry into a plan (optionally onto the calendar).
- **A Friday shopping run** — `Run /nutrition-chef take stock of the pantry and draft the shopping list`
  before the weekend shop turns what's fresh/low/expiring into a list before you're standing in the aisle.
- **A Sunday reset chain** — one scheduled task, *"Run /fitness-weekly-review, then /fitness-training-plan"*,
  closes the old training week and authors the new one, in the right order.
- **A morning readiness check** — `/fitness-pre-workout-brief` each morning gives you the go / caution /
  rest call before you've decided what today's session looks like.
- **A morning digest** — chain skills in one task: *"Run /mail-to-board and /whatsapp-triage, then give
  me a 5-bullet digest of what changed and what needs me today."*
- **A Friday wrap-up** — *"Summarize the cases I closed this week and what's still open per initiative."*

The pattern: anything you'd ask Cos to do **on demand**, you can ask it to do **on a timer**. Start from a
skill above, or write your own prompt — Cowork runs it unattended.

## How to set up a scheduled task in Cowork

1. **Cowork Desktop → Scheduled Tasks → new task**, set "every X min" (or a specific time).
2. Paste a **trigger prompt** — `Run /unanswered-messages`, or a custom instruction like the digests
   above.
3. Pick a cadence (suggestions above). Because the sweeps are **idempotent**, running one more often is
   cheap and safe — a cycle that finds nothing new simply no-ops.

## The auto-sync switch (every write-skill reads it first)

Before anything is written, a sweep checks **`config/auto-sync.json`** → `{ "autoSync": true }`:

- **`true` (default)** — process and write **automatically**, and **log every action** so you can review
  and ask for changes after the fact.
- **`false` (approval mode)** — prepare the changes but **confirm outward actions** (creating / moving
  cases, flagging / clearing messages, sending) before committing.

Flip it once in `config/auto-sync.json`; you don't touch it per-task.

## Authoring a skill — best practice

These skills started life as single self-contained `SKILL.md` files — the fastest way to get the first
sweeps working. That flat shape is still **allowed**, but the **preferred** pattern (as skills grow) is
the one the [skill-creator](https://docs.claude.com/en/docs/claude-code/skills) standards describe:

- **Progressive disclosure.** Keep `SKILL.md` to the *workflow* — the steps a run always follows —
  and push depth (exhaustive tool catalogs, worked examples, per-variant detail) into a
  `references/` subfolder the model reads only when it needs them. Aim to keep the body lean (the
  guideline is under ~500 lines) so the important path stays legible.
- **A pushy `description`.** The frontmatter `description` is the trigger — say both *what* the skill
  does and *when* to use it, with the phrases a user would actually type, so it fires when it should.
- **Explain the why, don't just shout.** Reasoned prose ("do X because Y") lands better than a wall
  of `ALWAYS` / `NEVER`. Reserve emphasis for the few genuinely load-bearing guardrails so they
  actually stand out.
- **Declare its automation class.** A new skill must add an entry to
  **[`automation.json`](./automation.json)** — `scheduled` (with a trigger + suggested cadence),
  `called` (by whom), or `on-demand` (why a timer adds nothing). `pack-skills` refuses to build
  without it, and the catalog table above regenerates from it — never hand-edit between the
  `<!-- BEGIN/END GENERATED -->` markers.

**[`mail-to-board`](./mail-to-board/SKILL.md)** is the reference example of this shape — a lean
workflow that points into
[`references/case-management.md`](./mail-to-board/references/case-management.md) and
[`references/worked-examples.md`](./mail-to-board/references/worked-examples.md). Follow it when you
write a new skill or grow an existing one.

## What makes an unattended run trustworthy

- **Idempotent** — re-running is safe: each sweep pulls only what's new (a per-channel watermark) or
  no-ops over already-settled state, so a tight cadence never double-processes or thrashes.
- **De-duplicated** — the same thread / topic **updates** its existing case / record instead of spawning
  a duplicate.
- **Never undoes your edits** — a lane, parent, title, or "answered" flag **you** set by hand is
  respected; the sweeps refine only their own prior work.
