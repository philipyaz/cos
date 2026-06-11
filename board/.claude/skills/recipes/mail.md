# Recipe — Mail (Gmail)

**Channel:** Gmail · **MCP:** Gmail (Anthropic out-of-the-box, `mcp__…_Gmail__*`) · **Router:** `/second-brain-ingest`
**Watermark:** a Gmail **label** applied to the processed thread (e.g. `cos/processed`).

> **Sibling skill — `/mail-to-board`.** This recipe routes each thread for **knowledge + action**
> via `/second-brain-ingest`. The sibling `/mail-to-board` is a **board-first sweep** that reconciles
> email **STATE** onto the board, covering **BOTH received AND sent** mail. It respects manual board
> edits: it reads each case's manual-action history (`get_case` now surfaces a **"Manual actions by
> the user"** block) and will **not** undo a human's lane move, task completion, or field edit.

Scan important / unread mail, route each thread through the router, then label it processed. An email
on an **open matter updates the matching case** (don't spawn a duplicate); the sender resolves to a
single vault entity; context lands in the vault.

## One-time setup

Create the watermark label once (so the scan can exclude it): call **`create_label`** on the Gmail MCP
for **`cos/processed`**. After that the recipe only ever applies it.

## Paste this into a Cowork scheduled task ("every X min", e.g. 10–15 min)

> **Mail → second brain (idempotent).**
>
> 1. **`search_threads`** on the Gmail MCP for **unprocessed important/unread** mail. Use a query that
>    excludes the watermark, e.g. `is:unread (is:important OR in:inbox) -label:cos/processed`. If none,
>    stop — no-op.
> 2. For each matching thread (oldest first):
>    a. **`get_thread`** on the Gmail MCP for the full message(s) — sender, subject, body.
>    b. **Resolve the sender** to a vault entity (email address → entity; heuristic first, then the
>       vault **alias map**).
>    c. Hand the thread to **`/second-brain-ingest`**. After its **step-0 `auto-sync` check**, the
>       router:
>       - **Dedup first.** Look for an **open case for this matter** — match the resolved entity,
>         the thread (against case `messageIds`), or the subject against an existing case title.
>         - **Match found → UPDATE that case** (via the **`board`** MCP): **`link_message`** the email
>           onto it, then `update_task` / `complete_task` / move the lane as the email warrants
>           (e.g. a returned document → mark that task `done`; a reply needed → lane `todo`/`urgent`).
>           **Do not create a new case.**
>         - **No match → create** a new case (`create_case`), `work` or `life` domain, with
>           `vaultLinks` to the resolved entity.
>       - **Knowledge** in the email (a fact, a decision, new context about the sender) → **vault**:
>         re-synthesize the **source / entity / concept** pages; record the case id in the vault page's
>         `cases:` frontmatter (the reverse of `case.vaultLinks`).
>    d. **Only after** the router confirms the write, **`label_thread`** the thread with
>       **`cos/processed`**. This is the watermark.
> 3. Report what was linked / created / updated (or "nothing new").

## Discipline (how this recipe stays trustworthy)

- **Idempotent — watermark.** The search excludes `cos/processed`; the label is applied **last**, after
  the write lands. A thread already labelled never re-enters the scan. (If new mail arrives on a
  labelled thread, Gmail surfaces it as unread again — by design it gets re-routed, and **dedup** sends
  it to the *same* case rather than a new one.)
- **De-duplicated — the core of this recipe.** An email on an open matter **advances the existing
  case** — `link_message` + a task/lane change — instead of opening a new one. The match key is the
  resolved entity + thread + subject. This is what keeps the board from filling with one card per reply.
- **Entity-resolved.** The **sender's address** maps to one vault entity, the same entity a voice note
  or a board entity resolves to. New senders create a new entity page; known senders just update
  theirs. The resolved entity is the case's `vaultLinks` target.

## Routing intent (worked examples)

> Email from `marco@…`: *"Here's the signed sponsor agreement for the DevForge onboarding — logo asset to
> follow."*

- **Dedup** — a case *"Onboarding — DevForge sponsor"* is already open in **`waiting_for_input`** with
  tasks for each deliverable. The router **updates it**: `link_message` the email, `complete_task` on
  *"Signed sponsor agreement"*, leaves *"Logo asset"* open. No new case.
- **Vault** — `[[Marco Rivera]]` entity updated; the case's `vaultLinks` already point here.

> Email from a new contact proposing a partnership.

- **No match → new case** in `work`, lane `todo`, with a task to reply; vault gets a new **source** +
  **entity** page; `vaultLinks` set to the new entity.
