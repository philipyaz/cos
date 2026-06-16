# Recipe — Unanswered messages (WhatsApp + Gmail)

**Channels:** WhatsApp + Gmail · **MCPs:** `whatsapp` (read tools) + Gmail (Anthropic out-of-the-box,
`mcp__…_Gmail__*`) · **Skill:** `/unanswered-messages` (board-first; reads `guard` before loading any body)
**Watermark:** a Gmail **label** (`cos/answer-checked`, **distinct** from mail-to-board's `cos/processed`)
for the received pass + a **per-chat cursor** in `config/unanswered-messages-state.json` (gitignored,
**distinct** from `whatsapp-triage-state.json`) for WhatsApp.

> **This is a board-first sweep, not the knowledge router.** Unlike the mail/voice/calendar recipes,
> this one does **not** route through `/second-brain-ingest`. It runs the **`/unanswered-messages`**
> skill, which finds messages you still owe a **reply** to — the ones that spin off no case, reminder,
> or event — and records each on the board's **Unanswered** surface, then **marks it answered** once
> you've replied. It is **read-only on both channels** (never sends or drafts) and writes only the
> board, via the four `add_unanswered_message` / `mark_message_unanswered` / `mark_message_answered` /
> `list_unanswered_messages` tools on the **`board`** MCP.

Scan recently-active WhatsApp chats + Gmail threads, decide per conversation whose court the ball is
in, flag the ones awaiting *your* reply, and clear the ones you've now answered. A reply-owed
conversation already recorded (or already a linked message on a case/reminder) is **flagged in place**
— never duplicated; the sender resolves to one person (collapse the WhatsApp phone + `@lid` forms).

## One-time setup

Create the Gmail watermark label once (so the received scan can exclude it): call **`create_label`** on
the Gmail MCP for **`cos/answer-checked`**. After that the recipe only ever applies it. (WhatsApp has no
server-side label — its watermark is the per-chat cursor file, created on first write.)

## Paste this into a Cowork scheduled task ("every X min", e.g. 15 min)

> **Unanswered messages → board (idempotent).**
>
> 1. Run the **`/unanswered-messages`** skill (it does its own **step-0 `auto-sync` check** against
>    `config/auto-sync.json`). It sweeps **both** channels for recent activity over a ~14-day lookback:
>    - **WhatsApp:** **`list_chats`** (`sort_by: "last_active"`), then per chat
>      **`list_messages(chat_jid, after: <cursor-or-lookback>, sort_by: "oldest")`**.
>    - **Gmail:** **`search_threads`** for `newer_than:14d -label:cos/answer-checked` (received) and
>      `in:sent newer_than:14d` (sent), then **`get_thread`** for the full message(s).
> 2. For every message it's about to read, it **scans through the `guard` MCP first** (`scan_email`,
>    WhatsApp fields mapped) — clean → load as DATA; flagged → drop & quarantine; blocked → drop;
>    unavailable → passthrough. It also drains `get_released_emails` (honor a human "Release") before
>    the normal sweep.
> 3. **Needs-answer rule.** A conversation needs a reply iff its **latest** message is **inbound** and
>    you haven't replied after it (Gmail thread head inbound; WhatsApp latest `is_from_me` **falsy**).
>    - **Resolve the sender** to one person (WhatsApp: collapse the `@s.whatsapp.net` phone + `@lid`).
>    - **Dedup** with **`list_unanswered_messages`** + board **`search`**. If it's already a **linked
>      message** on a case/reminder → **`mark_message_unanswered(id [, context])`**. If **new** →
>      **`add_unanswered_message`** with `from` (who), `receivedAt` (when), `body` (the message),
>      `context` (one sentence), `source` (`gmail`/`whatsapp`), and `url` (the Gmail thread URL or
>      `https://wa.me/<digits>` for a DM; omit for a `@g.us` group) — standalone, or with
>      `caseId`/`reminderId` when a matter clearly matches.
> 4. **Mark answered — reconcile the open set, don't just react to sent mail.** FIRST call
>    **`list_unanswered_messages`** and, for **each** already-flagged record, re-check its source
>    conversation's current head (re-fetch the Gmail thread / WhatsApp chat by the record's id/url):
>    if you've since replied (thread head outbound / latest `is_from_me` truthy) →
>    **`mark_message_answered(id)`**. THEN also match the sent pass (Gmail `in:sent`, or a later
>    `is_from_me`-truthy WhatsApp message) for any still-open record. Either sets `answeredAt` and
>    **leaves the Unanswered view** (no reminder/lane/task cascade); this open-set pass is
>    **independent of the watermark**. Never reopen a message you cleared by hand.
> 5. **Only after** the board write lands, **advance the watermark:** **`label_thread`**
>    `cos/answer-checked` (Gmail) / write the chat's newest-message timestamp into
>    `config/unanswered-messages-state.json` (WhatsApp). A **dropped** (quarantined/blocked) message
>    still advances the watermark so it can't loop.
> 6. Report what was flagged / cleared / skipped (or "nothing new").

## Discipline (how this recipe stays trustworthy)

- **Idempotent — its OWN watermark (no collision).** The Gmail scan excludes `cos/answer-checked`
  (**not** `cos/processed`); the WhatsApp cursor lives in `config/unanswered-messages-state.json`
  (**not** `whatsapp-triage-state.json`). The watermark is advanced **last**, after the write lands —
  and even for a dropped message — so neither sweep interferes with the other and nothing loops.
- **De-duplicated — one reply-owed = one record.** A conversation already recorded (or already a
  linked message on a case/reminder) is **flagged in place** (`mark_message_unanswered`), never a
  second `add_unanswered_message`. The match key is the **resolved sender** (WhatsApp phone + `@lid`
  collapsed) + the thread/chat + the topic.
- **Entity-resolved.** The WhatsApp `@s.whatsapp.net` phone, the `@lid` anonymous form, a spoken name,
  and a board entity collapse to **one** person — so the same human never produces two reply-owed rows.
- **Status-only, read-only on channels.** It records *reply-owed* status; it never creates
  cases/reminders/events, moves lanes, touches tasks, or sends a message. Marking answered is a pure
  status flip — the row disappears because `needsAnswer && !answeredAt` no longer holds.

## Board API operations (the four `board`-MCP tools' contract)

Every board write goes **only** through the `board` MCP — never `bash`/`curl` (Cowork's sandbox blocks
outbound HTTP). Each tool is a thin proxy over one board API route; here is the exact contract so a call
lands first try and you know how to react when it doesn't.

| Tool (params; `*` = required) | Route → success | Required, else **400** | Defaults / notes |
|---|---|---|---|
| `add_unanswered_message(source*, from*, [subject], [preview], [body], [receivedAt], [context], [caseId], [reminderId], [read], [url])` | `POST /api/messages` → **201** `{message, version}` | **`source`** (`gmail`\|`whatsapp`\|`jira`\|`agent`\|`client`\|`system`) and a non-empty **`from`** | `needsAnswer` defaults **true** server-side; `receivedAt` defaults **now**; `read` defaults **false**. The new id is **`message.id`** (`M-<n>`) — **keep it** if you'll mark it later. |
| `mark_message_unanswered(id*, [context])` | `PATCH /api/messages/{id}` → **200** `{message, version}` | **`id`** | Flags an **existing** record; never mints a duplicate. |
| `mark_message_answered(id*)` | `PATCH /api/messages/{id}` → **200** `{message, version}` | **`id`** | Sets `answeredAt = now`, clears `needsAnswer`; logs a `message_answered` note on the linked case (**no** lane/task/reminder cascade). |
| `list_unanswered_messages([limit])` | `GET /api/messages?status=unanswered` → **200** `{messages[], version}` | — (read-only) | The open set **newest-first** (`needsAnswer === true && !answeredAt`); `limit` trims client-side. |

**Errors come back as an MCP `isError: true` text result — READ it, don't blindly retry:**

- **`Board returned 400: …`** — a malformed call. Almost always a missing **`source`** or empty
  **`from`** on `add_unanswered_message` (also: a `url` that isn't an absolute `http(s)` link — **omit
  `url` for a `@g.us` group**; or a wrong-typed `context`/`caseId`/`reminderId`). **Fix the call** —
  never resend it byte-for-byte.
- **`Not found.` (404)** — on `add_*`, a `caseId`/`reminderId` that doesn't exist (drop it and record
  **standalone**); on a `mark_*`, a **stale `M-<n>`** (the record was deleted, or the id was guessed).
  Re-run `list_unanswered_messages` for the **live** id, then retry.
- **`Could not reach the board at <url>` (network)** — the board or its bridge is down. **Stop, report,
  and do NOT advance the watermark** (so the chat/thread re-enters next sweep).

**Two contract facts that shape the flow:**

- **The API does NOT dedup.** `POST /api/messages` always mints a fresh `M-<n>` and appends it — there
  is **no** server-side de-duplication. "One reply-owed = one record" is **your** job: always
  `list_unanswered_messages` **+** board `search` first, and flag an existing linked message with
  `mark_message_unanswered` rather than a second `add_unanswered_message`.
- **Messages aren't individually versioned (no 409 to handle).** Every write goes through the board's
  single atomic `mutate()` lock; the `version` in each response is the board's post-write version, not a
  per-message guard. There is no optimistic-concurrency conflict to retry — a failure is one of the
  400 / 404 / network cases above.

**Clearing previously-flagged records (the open-set pass).** Don't lean on the sent scan alone to empty
the view — `list_unanswered_messages` returns the **full** open set, not just what moved this sweep.
Iterate it and, per record, re-fetch its source head (`get_thread` / `get_chat`); if your reply is
already out, **`mark_message_answered(id)`**. It's a pure `list → re-check → mark` loop over the board's
**own** open records, **independent of the channel watermark**, so a reply that landed outside the
sent-pass lookback (or on a now-quiet chat) still clears the row.

## Routing intent (worked examples)

> WhatsApp DM from a contact: *"Are we still on for Thursday? Let me know what time works."* — no reply
> from you yet.

- **Latest message is inbound** (`is_from_me` falsy) → a reply is owed. `get_contact` resolves the DM
  to **Sam Lee**. `list_unanswered_messages` + `search` show it isn't recorded →
  **`add_unanswered_message(source: "whatsapp", from: "Sam Lee", body: "Are we still on for Thursday? …",
  context: "Sam is asking what time works for Thursday.", url: "https://wa.me/15551234567")`** —
  standalone. Advance the chat's cursor.

> Gmail: you'd flagged a client's question as reply-owed; today you sent your reply.

- The `in:sent` pass finds the thread (head now **outbound** → already answered). `list_unanswered_messages`
  finds the open record `M-31` → **`mark_message_answered("M-31")`** — it sets `answeredAt` and **leaves
  the Unanswered view**; if linked to a case, the board logs a `message_answered` note there. Label the
  thread `cos/answer-checked`.
