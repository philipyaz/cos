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

## The skills worth scheduling

| Skill | What a scheduled run does | Trigger to paste | Suggested cadence |
|---|---|---|---|
| **[`/unanswered-messages`](./unanswered-messages/SKILL.md)** | Surfaces the WhatsApp + Gmail messages still **awaiting your reply** on the board's **Unanswered** panel, and clears them once you've replied. Read-only on both channels. | `Run /unanswered-messages` | ~15 min |
| **[`/mail-to-board`](./mail-to-board/SKILL.md)** | Reconciles your Gmail (received **and** sent) onto the board — links messages to cases, advances tasks, moves lanes, dedups — and **never** undoes your manual edits. | `Run /mail-to-board` | ~10–15 min |
| **[`/whatsapp-triage`](./whatsapp-triage/SKILL.md)** | The same reconciliation for **WhatsApp** (DMs **and** groups), turning chats into tracked cases on the board. | `Run /whatsapp-triage` | ~15 min |
| **[`/board-organize`](./board-organize/SKILL.md)** | Tidies the case tree into a clean **Initiative ▸ Workstream ▸ Case** hierarchy, grounded in your starred / priority items — never re-homing what you placed by hand. | `Run /board-organize` | every 2–6 h / daily |
| **[`/reminders-review`](./reminders-review/SKILL.md)** | Reviews every **open reminder** and **closes** the ones already done or past their moment — auto-closing only what's *proven* done (finished checklist, linked case closed, delivery date passed) and **proposing** the rest (cold job-alerts, lapsed RSVPs) — so the reminders list stays a live to-do surface, not a graveyard. | `Run /reminders-review` | daily / every few hours |
| **[`/nutrition-chef`](./nutrition-chef/SKILL.md)** | Food, pantry & meal-planning operator — e.g. plan the week's meals from what's on hand (preferring what's expiring), or check how you're tracking to your calorie target. | `Run /nutrition-chef plan this week's meals` | weekly / daily |

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
