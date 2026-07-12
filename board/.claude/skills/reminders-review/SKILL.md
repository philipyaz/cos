---
name: reminders-review
description: >
  The reminder janitor — a periodic sweep that reviews every OPEN reminder on the
  board and CLOSES the ones whose job is already done or whose moment has passed, so
  the reminders list stays a live to-do surface instead of a graveyard of stale
  nudges. For each open reminder it reads the full context via the `board` MCP (the
  nudge, its due date, HOW LONG it has been sitting, its checklist, its linked emails,
  and — when it links a case — that case's current state), then takes a CRITICAL look
  and sorts each into CLOSE (the thing happened / got done → complete), DISMISS (no
  longer relevant / the decision window lapsed / superseded → dismiss), KEEP-OPEN
  (still live, or pinned by a star / priority), or NEEDS-YOU (a passed deadline it
  can't prove is settled). It AUTO-closes ONLY what is PROVEN done (a finished
  checklist, a linked case now closed, a delivery whose date clearly passed); every
  judgment call — a lapsed job-alert, an old "decide whether to" nudge, a cold FYI,
  anything tied to a starred node — it PROPOSES for your approval, and it NEVER
  deletes. Use when the user says "review my reminders", "check my reminders", "what
  reminders can I close", "clean up / clear out / tidy my reminders", "close the old /
  stale / done reminders", "which reminders are still relevant / worth keeping", "go
  through my reminders", or when the scheduled reminders-review sweep runs.
---

# Reminders → Review (the open-reminder sweep)

This skill keeps the board's **reminders** list honest. Reminders are lightweight
nudges — *CHECK this, DO that, be READY for the parcel* — and unlike messages or
cases they have **no channel that clears them**: nothing marks a reminder done just
because the parcel arrived, the deadline passed, or you quietly decided not to apply.
So they pile up. This sweep is the counter-force: it walks **every open reminder**,
works out whether the nudge has served its purpose, and **closes the ones that have**
— by **completing** (it got done / happened) or **dismissing** (it's no longer
relevant) — so what's left is genuinely still-actionable.

It writes to the board **only** through the **`board`** MCP — never `bash`/`curl`
(Cowork's sandbox blocks outbound HTTP; the tools exist for exactly this). **The board
is a state machine; YOU are the intelligence.** The board just lists, reads, and flips
the status of reminders deterministically — it has *no* notion of "this one is stale."
Judging closeability is entirely **your** job here, from the context the reads give
you. The only writes this skill makes are `complete_reminder` and
`update_reminder {status:"dismissed"}`; it never creates, links, or **deletes** a
reminder (that's the reconcilers' job, and hard-delete is nobody's job in this sweep).

> **Guardrail 1 — overdue is NOT the same as done.** A passed due date, or a nudge
> that's sat for weeks, is a prompt to **ASK**, not a licence to close. *"Submit the
> meter readings by Fri"* going overdue might mean you did it — **or** that you still
> owe it and it's now urgent. Only **auto-close** when the completion is **PROVEN** by
> concrete state (a checklist fully checked, a linked case in a done/closed lane, a
> one-shot delivery/event whose date has clearly passed). When "done" is merely
> **inferred** from age, **propose** it or leave it as **NEEDS-YOU** — never silently
> flip it.

> **Guardrail 2 — the human's hand wins, and a reminder carries no author.** Unlike a
> case, a reminder has **no `human`/`agent` attribution and no manual-actions block**,
> so you *cannot* tell whether the user is deliberately keeping one open. Treat that
> uncertainty conservatively: **auto-close only the PROVEN-done set** (Guardrail 1);
> route **every inferred-stale close** — age, a lapsed decision, a cold FYI — through
> **approval** so the user confirms. And **never `delete_reminder`** in this sweep:
> complete/dismiss is the **reversible** close (a done/dismissed reminder is restorable
> from Trash for ~30 days); a hard delete is not yours to make here.

---

## STEP 0 — Read the auto-sync switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON** if the file or
key is missing). State the mode once at the start of the run.

- **`autoSync: true` (auto mode).** **Auto-close** the **PROVEN-done** set (STEP 4
  defines exactly which) and **log every close**. Still **present** the inferred-stale
  candidates (lapsed job-alerts, past-dated plans, cold FYIs) as a **single batch** for
  a quick confirm before closing them.
- **`autoSync: false` (approval mode).** Close **nothing** directly. Gather the whole
  picture and **present every proposed close** (id · title · age · verdict · one-line
  reason) for the user to `approve`/`reject`, then close only the approved ones.

**Approval here is conversational, not the board `propose` queue.** The board's pending
queue only accepts **case** verbs (`update_case`, `move`, `archive`, `add_task`, …) —
it has **no** reminder verb, so `propose {verb:"complete_reminder"}` **400s**. So
"propose" in this skill means: **show the batch in chat, get the go-ahead, then call
`complete_reminder`/`update_reminder`.** Read-only context-gathering (`list_reminders`,
`get_reminder`, `get_case`, `get_priorities`, `search`) never needs confirmation.

## STEP 1 — Ground in priorities, then pull the open set

1. **`get_priorities` FIRST.** It returns the user's **starred** nodes and free-text
   **priority notes** (`PRI-…`). A reminder linked to (or clearly about) a starred /
   `P0`/`P1` matter is **pinned intent** — handle it conservatively (STEP 3, KEEP-OPEN
   row): surface it if it looks stale, but **never auto-close** it.
2. **`list_reminders {status:"open", verbose:true}`** — the working set **with every
   reminder's full content in ONE call**: the `detail` text, `created`/`updated` (the
   age signal — a dateless *"review X, decide whether to Y"* nudge has only its created
   date to tell you how long it's been rotting), the `dueAt`, the **task checklist with
   done-flags**, labels, domain, and linked `caseId`. This is what lets you triage the
   whole set for staleness up front **without a `get_reminder` per reminder** — pull it
   once and reason over the lot.
3. **`list_reminders {status:"done"}`** (a light pass) — learn the **recent lifecycle
   patterns** so you can match them. Example: if a prior order shows the *parcel
   delivered → reminder completed* pattern, a new *"parcel in transit"* nudge whose
   window has passed almost certainly followed suit.

## STEP 2 — Fill the two gaps the verbose list doesn't cover

The `verbose` list from STEP 1 already handed you **every reminder's own record** —
detail, age, due, checklist with done-flags, labels, `caseId` — so most of the triage
happens right there, in memory, with **no per-reminder round-trip**. You only reach for
a second read to cover the two things a reminder record can't carry:

- **The linked case's state → `get_case {caseId}`** (only for reminders that have a
  `caseId`). This is the join the board **deliberately does not do for you** — the list
  gives you the raw `caseId`, not the case. Read the case's **status / lane / tasks**:
  if the matter is in a **done/closed lane or archived**, the nudge's job is finished →
  a clean **complete**; if it's still active, the reminder is probably still live — keep
  it.
- **The linked emails → `get_reminder {id}`** — the *one* thing not on the reminder
  record. Fetch it only for the handful where an email's content would actually change
  your verdict (the `detail` usually already summarizes it).
- Use board **`search`** when a reminder might be **superseded** by a newer reminder or
  case covering the same thing (→ dismiss the duplicate).

## STEP 3 — The closeability rubric (take a CRITICAL look)

Sort every open reminder into one verdict. Be **critical** — the default failure mode
is timidity that lets 60 dead nudges rot — but obey the two guardrails: PROVEN-done
auto-closes; inferred-stale gets proposed; a maybe-still-owed deadline is NEEDS-YOU.

**First, the deeper cut — does this even pass the five tests of a real reminder?** Much
of an overgrown list isn't *stale* so much as it **never should have been a reminder**:
the reconcilers minted it from a notification, a watch, or a want. A reminder earns its
place only if **all five** hold; fail one and it's **dismissible now** with a named
reason — the same reasons the reconcilers now DROP on at creation, so the sweep and the
intake gate speak one language:

1. **Commitment, not notification** — fail → **Notification** (job alert, marketplace
   listing, "terms updated", a machine alert like disk-full). Dismiss.
2. **Ball in your court** — fail → **Watch** (waiting on someone else). Dismiss (or
   `add_note` it onto the case); it belongs back only as a *dated follow-up you own*.
3. **Real, dated consequence** — fail → **No-stakes** ("free up storage"). Dismiss.
4. **Specific next action** — fail → **Open-loop** ("review / monitor / decide whether to
   apply"). Dismiss.
5. **Ties to something you care about** — fail → **Want/courtesy** (a record, show
   tickets, a guest review). Dismiss — but this is a *values* call, so **propose**, never
   auto.

A reminder that PASSES all five is a real obligation — *then* judge it on **state**: has
it been **done**, has its **moment passed**, or is it **still live**? That's the table:

| What you observe | Verdict | Verb | Auto or propose |
|---|---|---|---|
| The reminder's own **`tasks` checklist is fully checked** (all `done`) | CLOSE | `complete` | **auto** |
| It links a case and **`get_case` shows that case in a done/closed lane or archived** | CLOSE — the nudge's job is finished | `complete` | **auto** |
| A **delivery / collection** nudge (*"parcel in transit / will be delivered soon / DELIVERED — collect"*) whose expected date has **clearly passed**, and a sibling shows the delivered→done pattern | CLOSE | `complete` | **auto** when the date is unambiguously past; else propose |
| A **one-shot dated event / plan** (*"catch-up Thu 25 Jun", "rdv Wed 19:00"*) whose `dueAt` is **in the past**, nothing recurring | CLOSE — the moment has passed | `complete` | **propose** (you can't prove it happened) — auto only if a linked case/email confirms it did |
| A **decision-window / cold FYI** (*"review the LinkedIn alert, decide whether to apply", an RSVP, "buy tickets if interested", "record available on Discogs"*) sitting **many days** past creation with no action | CLOSE — the window has effectively lapsed | `dismiss` | **propose** (never auto — it's an inference about your intent) |
| **Superseded / duplicate** — a newer reminder or a case now owns the same thing | CLOSE | `dismiss` | propose (auto only for an exact dup of one *you* made) |
| A **passed deadline you might still owe** (*"submit the meter readings by Fri", "retry the failed payment"*) that you **can't prove** is settled | KEEP-OPEN, flag it | — | **NEEDS-YOU** — never auto-close |
| **Awaiting the other side** (*"catch up with X — he'll confirm timing", "awaiting agency callbacks"*) and the window hasn't clearly lapsed | KEEP-OPEN — still live | — | leave; surface only if long-dead |
| Tied to a **starred / P0** node, or plainly still relevant | KEEP-OPEN | — | surface only if it looks stale |
| Genuinely **ambiguous** | KEEP-OPEN | — | **NEEDS-YOU** (surface, don't close) |

**`complete` vs `dismiss` — pick the honest verb.** **`complete_reminder`** = the thing
**got done or happened** (parcel delivered, event occurred, task finished); it stamps
`completedAt`. **`update_reminder {status:"dismissed"}`** = it's **off the list without
claiming completion** (a lapsed job-alert you're not pursuing, a cold FYI, a superseded
nudge); no `completedAt`. When torn between the two, **dismiss under-claims** and is the
safer choice.

## STEP 4 — Auto vs propose (the two-tier action policy)

**AUTO-CLOSE** — only when `autoSync` is **on**, and only the **PROVEN-done** rows:

- a `tasks` checklist that is **fully checked** → `complete_reminder`;
- a reminder whose **linked case is in a done/closed lane or archived** →
  `complete_reminder`;
- a **delivery/collection** nudge whose date is **unambiguously past** *and* a sibling
  shows the delivered→done pattern → `complete_reminder`.

Log each auto-close (STEP 6).

**PROPOSE** — **always**, regardless of the switch, for **every judgment call**:

- a **decision-window / cold FYI** lapse (job alerts, RSVPs, *"decide whether to"*,
  Discogs availability) → propose `dismiss`;
- a **past-dated event/plan** you can't prove happened → propose `complete`;
- **staleness inferred from age** alone rather than proven by concrete state;
- **anything tied to a starred / P0** node;
- any case where the honest verb (complete vs dismiss) is unclear.

Present proposals as **one consolidated batch** — `REM-<n> · "title" · created N days
ago · verdict · one-line reason` — not a stream of one-off prompts. Close only what the
user approves. In **approval mode**, *everything* (including the proven-done set) goes
into that batch. Route a **passed-deadline-you-might-owe** to **NEEDS-YOU**, not the
close batch.

The writes, and nothing else:

- **`complete_reminder {id}`** → flips `status:"done"`, stamps `completedAt`, logs
  `reminder_completed` on the linked case. The close-as-done.
- **`update_reminder {id, status:"dismissed"}`** → the close-as-not-relevant (no
  `completedAt`).
- **Never `delete_reminder`.** Complete/dismiss drops it from the open view *and* stays
  reversible (Trash → restore for ~30 days). Hard-delete is out of scope.

## STEP 5 — Idempotency & re-run safety

- **A clean board no-ops.** The sweep only ever reads open reminders; a run with
  nothing stale writes nothing.
- **Closed stays closed.** `complete`/`dismiss` flips the status out of `open`, so a
  closed reminder never re-enters this sweep (it's gone from `list_reminders
  {status:"open"}`). Re-running only finds **newly** stale ones.
- **No thrash, no reopening.** This sweep **never reopens** a reminder — if the user (or
  a reconciler) deliberately keeps or re-opens one, you leave it. Convergent by design:
  each pass only *closes* the settled, so successive runs shrink the open set and then
  quiesce.

## STEP 6 — Report

When `autoSync` is **on**, append each auto-close to the matching domain log
(`work/log.md` or `life/log.md`), one line apiece:

    ## [YYYY-MM-DD] reminders-review
    Closed REM-168 (complete) — Geneva plate collected; linked CASE-26 now in Done.
    Dismissed REM-156 (proposed→approved) — AWS CSM job-alert, 15 days cold, not pursued.

Then **report** a consolidated tally:

- **Reviewed** — N open reminders.
- **Closed (auto)** — each `REM-<n>`, verb (completed/dismissed), and the one-line proof.
- **Proposed** — the batch awaiting your yes/no (or, in approval mode, everything), each
  tagged with its **reason code** (Notification · Watch · No-stakes · Open-loop ·
  Want/courtesy · done · moment-passed) so a glance shows *why*.
- **Needs you** — passed deadlines that might still be owed (e.g. the meter readings) —
  surfaced, **not** closed.
- **Kept open** — still-live nudges (awaiting the other side, future-dated, starred).
- The board surface: **`<BOARD_URL>`** → the **Reminders** page.

---

## Board API operations — the reminder tools' contract

Every write goes **only** through the `board` MCP; here is the exact contract so a call
lands first try and you know how to react when it doesn't.

| Tool (params; `*` = required) | Route → success | Required, else **400** | Notes |
|---|---|---|---|
| `list_reminders([status],[caseId],[domain],[verbose])` | `GET /api/reminders` → **200** `{reminders[], version}` | — (read-only) | Pass **`status:"open"`** for the working set. **`verbose:true`** renders EACH reminder's full content (detail · created/updated · due · task checklist with done-flags · labels · caseId) in one call — triage the whole set without a `get_reminder` per reminder. Excludes Trash by default. |
| `get_reminder(id*)` | `GET /api/reminders/{id}` → **200** `{reminder, messages[], version}` | **`id`** | Full record: `detail`, `dueAt`, **`Created`/`Updated`**, the `tasks` checklist (done-flags), and linked emails. Does **not** expand the linked case — call `get_case` for that. |
| `get_case(id*)` | `GET /api/cases/{id}` → **200** | **`id`** | The linked matter's live **status / lane / tasks** — your proof of whether the nudge's job is done. |
| `get_priorities()` | `GET /api/priorities` → **200** | — (read-only) | Starred nodes + `PRI-…` notes = pinned intent; never auto-close against it. |
| `complete_reminder(id*)` | `PATCH /api/reminders/{id}` `{status:"done"}` → **200** `{reminder, version}` | **`id`** | The **close-as-done**. Stamps `completedAt`; logs `reminder_completed` on the linked case. |
| `update_reminder(id*, status:"dismissed")` | `PATCH /api/reminders/{id}` → **200** `{reminder, version}` | **`id`**; a bad `status`/`dueAt`/label → 400 | The **close-as-not-relevant** (no `completedAt`). Use `dismissed`, not `done`, when the thing didn't actually get done. |

**Errors come back as an MCP `isError: true` text result — READ it, don't blindly retry:**

- **`Board returned 400: …`** — a malformed call (a `status` outside `open|done|dismissed`,
  an unparseable `dueAt`, an unknown label id). **Fix the call**, don't resend it byte-for-byte.
- **`Not found.` (404)** — a **stale `REM-<n>`** (already closed, or the id was guessed).
  Re-run `list_reminders {status:"open"}` for the **live** ids and retry.
- **`Could not reach the board …` (network)** — the board or its bridge is down. **Stop
  and report**; write nothing. (Nothing to advance — this sweep keeps no watermark.)
- **No 409 to handle.** The `complete_reminder`/`update_reminder` tools don't send
  `expectedVersion`, so there's no optimistic-concurrency conflict — every failure is a
  400 / 404 / network case above.

## Conventions (guardrails recap)

- **BOARD-ONLY writes, and only two of them.** `complete_reminder` and
  `update_reminder {status:"dismissed"}` — never via `bash`/`curl`, never
  `create_reminder`/`link_*` (the reconcilers own creation), **never `delete_reminder`**.
- **Overdue ≠ done (Guardrail 1).** Auto-close only **PROVEN** completion (checklist
  done · linked case closed · one-shot delivery/event clearly past). A passed deadline
  you can't prove settled is **NEEDS-YOU**, surfaced — never flipped.
- **Reminders have no author (Guardrail 2).** You can't see who set one or whether the
  user is holding it open, so **inferred-stale closes are always proposed**, never auto.
- **complete vs dismiss — the honest verb.** `complete` = it happened / got done;
  `dismiss` = off the list without claiming completion. When torn, `dismiss`.
- **Approval is conversational.** The board `propose` queue is **case-only** (no reminder
  verb — it would 400), so "propose" = show the batch, get the go-ahead, then call the
  close tool. Present one consolidated batch, not a prompt per reminder.
- **Ground in priorities.** `get_priorities` first; a starred / `P0` / note-matched
  reminder is pinned — surface if stale, never auto-close.
- **Reversible, idempotent, non-reopening.** Complete/dismiss is restorable from Trash
  (~30 days). A closed reminder leaves the open set, so re-runs converge and never
  thrash; the sweep never reopens what someone keeps.

## Worked examples

> **1 — A delivery whose window has passed → complete (auto).** `REM-215` — *"Parcel
> from Digitec Galaxus in transit — will be delivered soon"*, **created 2026-07-03**, no
> `dueAt`. Today is several days later.

- **STEP 1** — the `list_reminders {status:"done"}` pass surfaces the sibling `REM-134`
  (*the June order, delivered 2026-06-19, now done*) — the **delivered→done pattern**.
- **STEP 3** — a *"will be delivered soon"* parcel created several days ago, with a
  sibling that followed exactly this arc, is a delivery whose window has **clearly
  passed** → **CLOSE / complete**. **STEP 4** — proven-enough by the passed window + the
  sibling pattern → **`complete_reminder("REM-215")`** (auto in auto mode). It **arrived**,
  so `complete`, not `dismiss`. *(If you truly can't tell the date passed, propose it.)*

> **2 — A job-alert decision-window gone cold → dismiss (propose).** `REM-156` — *"AWS —
> Customer Solutions Manager, Customer Migration Center (Zurich): review LinkedIn alert,
> decide whether to apply"*, **created 2026-06-21**, no `dueAt`, no application on file.

- **STEP 3** — this is a **decision-window** nudge: *~15 days* old, dateless, no action.
  The posting has almost certainly closed and the decision has defaulted to *no* — the
  window has **lapsed** → **CLOSE / dismiss** (you didn't apply; nothing was
  "completed"). But this is an **inference about your intent** (Guardrail 2), so **STEP 4
  — PROPOSE**: add it to the batch — *"REM-156 · AWS CSM job-alert · 15 days cold, no
  application → dismiss?"* — alongside its ~11 sibling job-alerts (`REM-155`, `-173`,
  `-176`, `-185`, `-194`, `-195`, `-197`, `-198`, `-214`, `-222`, …). Close the approved
  ones with **`update_reminder {status:"dismissed"}`**.

> **3 — A linked case is now Done → complete (auto).** `REM-168` — *"Geneva plate
> (rouge, porte-vélo) DELIVERED — collect at OCV guichet"*, linked `CASE-26`.

- **STEP 2** — `get_case("CASE-26")` shows the collection task closed / the matter in a
  done lane. The nudge's job is **finished** → **CLOSE / complete**, **auto**:
  **`complete_reminder("REM-168")`**. *(If `CASE-26` is still active — the plate not yet
  collected — it's **still live**: keep it.)*

> **4 — A passed deadline you might still owe → NEEDS-YOU, never auto-close.** `REM-192`
> — *"SIG — submit monthly meter readings by Fri 3 Jul 2026"*, `dueAt` now **overdue**.

- **STEP 3 — Guardrail 1.** Overdue is **not** proof of done. You either submitted the
  readings (closeable) **or** you missed the deadline and it's now **urgent** — and
  nothing in the reminder or its case proves which. So **do NOT close it**: surface it as
  **NEEDS-YOU** — *"REM-192: meter readings were due 3 Jul — did you submit them? If so
  I'll complete it; if not, it's overdue."* Let the user decide.

> **5 — Pinned by a star, looks stale → surface, don't touch.** A reminder about a
> **starred** initiative, past its `dueAt`.

- **STEP 1** — `get_priorities` shows the node is starred = **pinned intent**. Even
  though it looks stale, **never auto-close** it (Guardrail 2). At most **surface** it in
  the report — *"this starred reminder looks stale; close it?"* — and act only on an
  explicit yes.

## What's Next

After a sweep, the user can:

- **Open the Reminders page** (`<BOARD_URL>` → **Reminders**) to see the trimmed open
  list, or **Trash** to **restore** any reminder this sweep closed (reversible for ~30
  days) if a call was wrong.
- **Answer the batch** — approve/reject the proposed closes and the NEEDS-YOU questions;
  the next run acts on the decisions.
- **Re-run the sweep** — it's idempotent and non-reopening, so extra cycles that find
  nothing newly stale simply no-op. Good as a **scheduled** Cowork task (see the
  [skills README](../README.md)); a **daily / every-few-hours** cadence keeps the
  reminders list from ever rotting again.
- **Trust the source gate** — the reconcilers (`/mail-to-board`, `/whatsapp-triage`) now
  apply the **same five tests at *creation*** and DROP notifications / watches / wants,
  so the backlog is a **one-time cull**; going forward the open list stays commitments,
  not noise.
