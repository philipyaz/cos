# Recipes — the scheduled-task playbook

These are **recipes**, not a scheduler. The build supplies *what each periodic task pulls and
how it routes*; **you** set the cadence by hand in **Claude Cowork Desktop** (Scheduled Tasks →
"every X min"). There is deliberately **no host-side cron / launchd / shell script** — at the end
of the build nothing runs on our side. Cowork's scheduled tasks are the only periodic trigger.

Each file below is a tight, copy-pasteable instruction block you paste into one Cowork scheduled
task, plus a short explanation of the intent.

- [`voice.md`](./voice.md) — OpenWhispr voice transcripts (the `openwhispr` MCP).
- [`mail.md`](./mail.md) — important / unread email (the Gmail MCP). Board-reconciliation companion:
  the `/mail-to-board` skill (sweeps **received + sent** mail onto the board, respecting manual board edits).
- [`calendar.md`](./calendar.md) — meeting prep + Google Meet recaps (the Google Calendar MCP).
- [`unanswered.md`](./unanswered.md) — messages still awaiting **your reply**, across WhatsApp + Gmail
  (the `whatsapp` + Gmail MCPs) via `/unanswered-messages`: flag the reply-owed ones onto the board's
  **Unanswered** surface, mark them answered once you reply. **Not the knowledge router** — it's a
  board-first sweep (no `/second-brain-ingest`), read-only on both channels, with **its own** watermark
  (`cos/answer-checked` + `config/unanswered-messages-state.json`, distinct from the reconcilers').
- [`board-organize.md`](./board-organize.md) — periodic board housekeeping (the `board` MCP) via
  `/board-organize`: cluster the flat cases the reconcilers leave into Initiatives ▸ Workstreams,
  grounded in priorities, never re-homing what a human placed. **Not a channel-ingest recipe** — it
  pulls from no channel, has **no watermark**, and writes only the board (idempotent by construction).

## The loop every recipe runs

```
channel  ──MCP pull──▶  /second-brain-ingest  ──▶  vault + board, cross-linked  ──▶  watermark
(voice/mail/cal)        (the router)                (knowledge ↔ action)            (mark processed)
```

1. **Pull** new items from the channel through its **local-or-bridged MCP** (never a raw
   `curl` / HTTP call — Cowork's sandbox blocks outbound HTTP, which is why the MCPs exist).
2. **Route** each item through **`/second-brain-ingest`** — the single classify-and-route entry
   point. It does not decide cadence and it is not channel-specific; it just takes an item and
   writes it to the right place(s).
3. **Watermark** every item the moment it is handled, so the next cycle never reprocesses it.

## The auto-sync switch (the router reads it first)

Before anything is written, the router checks **`config/auto-sync.json`** → `{ "autoSync": true }`.

- **`true` (default)** — process and write to the vault and board **automatically**, and **log every
  action** so you can review and ask for changes after the fact.
- **`false`** — **approval mode**: prepare the changes but **confirm outward actions** (drafting/sending
  mail, creating/moving cases) before committing.

You don't touch this per-recipe; the recipes just hand items to the router and the router obeys the
switch. Flip it in `config/auto-sync.json`.

## The routing contract (what the router does with each item)

- **Knowledge** (a fact, context, who / what / why) → **vault**: re-synthesize the affected
  **entity / concept / source** pages.
- **Action** (a to-do, a state change) → **board**: create / update a **case**, add / update **tasks**,
  move a **lane**, tagged with a **`work` | `life`** domain — via the **`board`** MCP.
- **Most inputs produce both**, cross-linked: a vault **source** page *and* a board **case**, linked each
  way (`case.vaultLinks[]` holds the vault page titles ↔ the vault page's `cases:` frontmatter holds the
  case id).

## Shared discipline (the same three rules in every recipe)

These are what make an autonomous loop writing to two persistent stores trustworthy. Every recipe
states them concretely; here they are once, in full:

- **Idempotent — per-channel watermark.** Each channel owns a "last processed" marker so nothing is
  handled twice. The marker differs by channel (OpenWhispr's `mark_processed`, a Gmail label, a
  Calendar-event flag); each recipe names its own. Always pull **unprocessed only**, and watermark
  **after** the router confirms the write — never before.
- **De-duplicated.** The same thread / topic **updates the existing case** instead of spawning a
  duplicate. Before creating, the router looks for an open case for the same person/matter
  (by `messageIds`, `vaultLinks`, or title) and **advances it** — `link_message`, change a
  task, move a lane — rather than opening a new one.
- **Entity-resolved.** An email address, a spoken name, and a board entity all resolve to **one**
  vault entity. Resolution is heuristic first, backed by a **manual alias map in the vault**; the
  resolved entity is what the case's `vaultLinks` point at, so card → person → all-open-work stays
  one hop in both directions.

## Cadence — set by hand in Cowork

We don't ship intervals. Reasonable starting points (tune to taste in the scheduled-task UI):

| Recipe | Suggested cadence |
|---|---|
| Voice | every 5–15 min |
| Mail | every 10–15 min |
| Calendar | every 30–60 min |
| Unanswered | every 15 min |
| Board organize | every 2–6 h (or daily) |

Because every recipe is idempotent, running them more often is cheap and safe — extra cycles that
find nothing new simply no-op.
