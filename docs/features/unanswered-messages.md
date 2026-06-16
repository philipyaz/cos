# Unanswered messages — what you still owe a reply to

Plenty of messages arrive over Gmail and WhatsApp that you simply **forget to answer**. The triage
reconcilers ([`mail-to-board`, `whatsapp-triage`](../architecture/triage-skills.md)) turn mail and
chats into **cases, reminders, and calendar events** — but a message that needs nothing more than a
**reply** generates *none* of those artifacts. It spins off no card to advance, no nudge to clear, no
appointment to keep, so it slips silently through every other sweep. The **Unanswered** surface is the
one place that catches exactly those: a low-friction view of *"messages I still owe a reply to,"* and a
skill that fills it and clears it for you.

## The one decision that makes this cheap: an unanswered message is a flag, not a new entity

An "unanswered message" is **not** a new record type, and it is emphatically **not** a reminder. It is
the **existing `MessageRecord`** — the same one a linked email/chat already is — carrying a status flag.
The message already links independently to a case (`caseId`), to a reminder (`reminderId`), or to
**nothing** (standalone), so *"awaiting a reply, attached to a case, a reminder, or nothing"* is free.
Three **additive-optional** fields on `MessageRecord` carry the whole feature:

- **`needsAnswer?: boolean`** — flagged as awaiting a reply (the "pin").
- **`answeredAt?: string`** — an ISO timestamp set when answered; **absent ⇒ still unanswered**.
- **`context?: string`** — the one-sentence context shown in the view.

The predicate is exactly:

> **Unanswered ⇔ `m.needsAnswer === true && !m.answeredAt`.**

**Marking answered** sets `answeredAt = now`; the row leaves the view because the predicate no longer
holds. That's the entire mechanism — a pure status flip, no cascade to reminders, lanes, or tasks.

!!! note "No schema bump, no migration"
    These three fields are **additive-optional**, exactly like `outbound` / `reminderId` / `url` before
    them — old store files read unchanged, so `SCHEMA_VERSION` does **not** bump and there is **no**
    `migrate()` step. See the [migration reference](../reference/migration.md) for the version history.

The fields also reuse what the message already holds, so there is no separate "who" / "when" surface:

| In the view | Where it comes from |
|---|---|
| **Who** owes the reply-to | the message's existing **`from`** (the resolved sender) |
| **When** | the message's existing **`receivedAt`** |
| **The message** | the message's existing **`body`** |
| **One line of context** | the new **`context`** field — *what* they're asking, *who* they are |

## The board surface: a button + a panel

The board toolbar gains an **Unanswered · N** button (beside the Operational/Strategy · Work/Life ·
Filter/Labels cluster), where **N** is the live count of messages matching the predicate. Clicking it
opens a right-side slide-over panel that **fetches its own list** — so a write from the skill or the MCP
shows up live over the board's SSE stream, not only on a manual reload. Each row shows the source icon,
the **`from`** (who) and **`receivedAt`** (when), the one-line **`context`** on top, a snippet of the
**`body`**, a deep-link back to the source (Open in Gmail / `wa.me`), and — when the message resolves to
a case — a small linked-case chip.

Every row carries a **Mark answered** button. In v1 the board UI is **view + mark-answered only** — there
is **no manual "needs answer" toggle**; flagging is done by the skill / MCP (below). Marking answered is
optimistic (the row drops immediately) and reverts with an inline error on failure, the house style.

!!! tip "Mark-answered respects you"
    When you clear a message by hand, the sweep **never reopens it**. A *fresh* inbound message on the
    same thread is a new reply-owed turn, not a reopen of the cleared record — the skill flags the new
    turn and leaves your hand-edit alone.

## The four MCP tools (for the Cowork desktop)

The board MCP ([`board-server`](../architecture/mcp-servers.md)) is a **thin HTTP proxy** over the
board's API routes — it never touches the store. It gains four intent-named tools so the Cowork desktop
skill can store and flag unanswered messages:

| Tool | Route | What it does |
|---|---|---|
| `add_unanswered_message(source*, from*, …, [context], [caseId], [reminderId], …, [url])` | `POST /api/messages` | Create a message and flag it — `needsAnswer` defaults **true** server-side; **standalone** unless a `caseId`/`reminderId` is passed. |
| `mark_message_unanswered(id*, [context])` | `PATCH /api/messages/{id}` `{ needsAnswer: true, context? }` | Flag an **existing** linked message (don't mint a duplicate). |
| `mark_message_answered(id*)` | `PATCH /api/messages/{id}` `{ answered: true }` | Clear it — sets `answeredAt = now`; the row leaves the view. |
| `list_unanswered_messages([limit])` | `GET /api/messages?status=unanswered` | Read the current open set, newest-first (a read tool — no actor). |

These are the human face's twin: the panel's **Mark answered** button and the agent's
`mark_message_answered` call resolve to the **same** `PATCH /api/messages/{id}` route — one mutation
path, two faces, through the single atomic, version-guarded `mutate()` store path.

## The skill (and how to schedule it)

The [`/unanswered-messages`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/unanswered-messages/SKILL.md)
operator skill runs in **Claude Cowork** and is the engine behind the surface. It is an **independent
sweep**, built on the same skeleton as the two reconcilers but with its own job: it **scans both
channels for recently-active conversations, records the ones awaiting your reply, and marks them
answered once you've replied**. Trigger it by saying *"what haven't I answered,"* *"show my unanswered
messages,"* *"go through my messages for unreplied ones,"* or let the scheduled sweep fire it.

What it does, step by step:

- **Read-only on both channels.** It uses only the **read** tools of the `whatsapp` and Gmail MCPs and
  **never** sends or drafts a message — *you* reply, in WhatsApp or Gmail, and the next sweep notices.
  It writes only the **board**, via the four tools above.
- **Guard-first.** Before any body is read as meaning, every message goes through the
  [prompt-injection guard](../security/guard.md)'s `scan_email` (WhatsApp fields mapped into the email
  envelope) — clean → load as DATA; **flagged → drop & quarantine**; blocked → drop; **unavailable →
  passthrough** (process unscanned during an outage rather than lose the message). It also drains the
  released queue first, honoring a human "Release."
- **The needs-answer rule.** A conversation needs a reply iff its **latest** message is **inbound** and
  you haven't replied after it — the Gmail thread head is inbound, or the WhatsApp latest `is_from_me`
  is **falsy** (tested truthy/falsy, since the `whatsapp` MCP returns `1`/`0`, never a JSON boolean). A
  trailing outbound / `is_from_me`-truthy message means **already answered**.
- **Resolve, dedup, then flag.** It collapses the WhatsApp `@s.whatsapp.net` phone and `@lid` forms to
  one person, dedups against **both** `list_unanswered_messages` **and** the board `search`, then either
  `mark_message_unanswered` on an existing linked message or `add_unanswered_message` for a new one —
  one reply-owed conversation, one record. The minimal fields are `from` (who), `receivedAt` (when),
  `body` (the message), a one-sentence `context`, the `source`, and a `url` deep-link (the Gmail thread
  URL or `https://wa.me/<digits>` for a DM; omitted for a `@g.us` group).
- **Its own watermark.** Idempotency uses a Gmail label **`cos/answer-checked`** (distinct from
  `mail-to-board`'s `cos/processed`) and a dedicated gitignored cursor
  `config/unanswered-messages-state.json` (distinct from `whatsapp-triage-state.json`), so the two
  sweeps never collide. The watermark advances **last**, even for a dropped message.

**Scheduling.** There's no separate recipe file — the skill is self-contained, so you schedule it by
pasting **`Run /unanswered-messages`** into a **Claude Cowork** scheduled task (a sensible default is
~15 min, over a ~14-day lookback). Like every Cos sweep there is no host-side cron; you set the cadence
by hand in Cowork. See the [scheduled-skills guide](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/README.md).

## How mark-answered works (and why it doesn't cascade)

When you reply — in WhatsApp or Gmail — the next sweep notices on its **sent-direction pass** (a Gmail
`in:sent` thread match, or a later `is_from_me`-truthy WhatsApp message), finds the open record, and
calls `mark_message_answered(id)`. That sets `answeredAt = now`, and the record **leaves the Unanswered
view** because the predicate `needsAnswer && !answeredAt` no longer holds.

It deliberately does **not** cascade: no reminder is created or closed, no lane moves, no task changes.
The single side effect is that when the message is linked to a case, the board logs a `message_answered`
history note on that case. A reply-owed message is a **status on a message**, not a unit of work — so
clearing it is a status flip and nothing more.

## See also

- [Cos Board](board.md) — the board this surface lives on, and the parity tenet it obeys.
- [Triage skills](../architecture/triage-skills.md) — the `mail-to-board` / `whatsapp-triage`
  reconcilers this sweep runs *alongside*, sharing the guard-first / dedup / watermark skeleton.
- [Prompt-injection guard](../security/guard.md) — the fail-closed scanner every body passes through
  before it is read as meaning.
- [Reminders](reminders.md) — the *other* lightweight surface; an unanswered message is **not** one (no
  status enum, no due date, no node link of its own — just a flag on a message).
