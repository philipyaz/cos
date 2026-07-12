# Case-management reference — the full board surface

Everything you can do to a case, via the **`board`** MCP tools, with *when* to reach for each.
Drive the board only through these tools — never `bash`/`curl`. This is the depth behind
[Step 7 of `SKILL.md`](../SKILL.md); the common cases are covered inline there, so consult this
file when you need a tool you don't touch every sweep.

- [Lanes (`status`)](#lanes-status--the-workflow-state)
- [Domain](#domain-work--life) · [Priority](#priority-p0p3) · [Tasks](#tasks) · [Labels](#labels-the-catalog-taxonomy) · [Tags](#tags)
- [Notes](#notes) · [Messages](#messages) · [Reminders](#reminders-minor-notices--not-full-work)
- [`dueAt` vs `eta`](#dueat-vs-eta) · [`vaultLinks`](#vaultlinks) · [`snoozeUntil`](#snoozeuntil)
- [Hierarchy](#hierarchy-initiative--workstream--case) · [Archive / restore / delete](#archive--restore--delete) · [Approval queue](#approval-queue) · [Search](#search) · [Templates](#templates)

## Lanes (`status`) — the workflow state

Exactly five:

- **`urgent`** — needs attention now / time-critical. Move here when an inbound email is
  time-pressing.
- **`todo`** — queued, not started. Where a fresh "reply to …" matter lands.
- **`in_progress`** — you're actively working it (you've started, not just queued).
- **`waiting_for_input`** — parked on someone else's reply or action. Where a case goes the moment a
  *sent* reply puts the ball in their court.
- **`done`** — finished. Move here when the email closes the matter out.

Set the lane with `update_case`'s `status` (or `status` on `create_case`).

## Domain (`work` | `life`)

Which side of the board the case files on. Always set it explicitly on `create_case` (the tool
defaults to `work`); refile with `update_case`'s `domain`.

## Priority (`P0`–`P3`)

Triage importance — distinct from the `urgent` lane. Lane is *workflow state*; priority is
*importance*. A `todo` card can still be `P0`.

## Tasks

The case's checklist; they drive the card's done/total counter.

- `add_task` — append (per-task `dueAt`, `owner`).
- `update_task` — edit fields / status.
- `complete_task` — mark done (sugar for status `done`, stamps `completedAt`).
- `delete_task` — hard-remove.

Prefer `complete_task` over `delete_task` when the work is actually done — a returned document
closes its task, it isn't deleted.

## Labels (the catalog taxonomy)

Always call **`list_labels` first** to fetch the active catalog; each entry has an `id`, a `title`,
and a `description` that tells you *when* it applies. Assign only ids it returns (pass
`labels: [ids]`) — an unknown id is rejected (the board returns the valid set), which is exactly the
failure to avoid. Labels are distinct from freeform `tags`. If the catalog lacks a category the
email clearly needs, use **`list_label_bundles`** + **`install_label_bundle`** to add the relevant
role / life pack (in approval mode, surface the suggestion instead).

## Tags

Freeform short lowercase strings (`['onboarding','first-call']`) — complementary to labels, not
catalog-checked.

## Notes

**`add_note`** for context, a trail of reasoning, or — importantly — flagging a conflict with a
manual action (Step 6 of `SKILL.md`, rule 1).

## Messages

**`link_message`** attaches an email/chat/event to a case (pass `url` — the
`https://mail.google.com/mail/u/0/#all/<threadId>` deep-link — on every call, and `to` / `cc` and
`outbound: true` for the user's own sent mail, which drives automatic trust). **`update_message`**
flips the `read` flag or relinks (`caseId`) — pass `caseId: null` to *unlink* a message from any
case. A relink to a case re-derives trust over the destination case (as does `link_message`), but
trust still only flows from a sent message carrying `outbound: true` plus its recipients — so link
sent mail correctly in the first place.

## Reminders (a commitment you own — not a notice / watch / want, not full work)

A reminder is one concrete action you own, with a real consequence if you miss it — mint one only
when the matter passes the five tests in Step 7 of `SKILL.md`. A notification / watch / want fails
those tests and is *dropped*, not filed.

- **`create_reminder`** / **`update_reminder`** with `title*`, optional `detail`, `dueAt`, `domain`,
  catalog `labels` (`list_labels` first — unknown ids are rejected, exactly as on a case), and a
  short `tasks` checklist of `{ title, done? }` items (a concise check-off list, not full case
  Tasks).
- **`link_reminder`** files the reminder under any node (`caseId`).
- **`link_reminder_message(id*, source*, from*, to?, cc?, outbound?, subject?, preview?, body?,
  receivedAt?, read?, url?)`** attaches an email *to the reminder* — so many emails on one matter all
  point at one reminder (`message.reminderId` is the single source of truth; relink/unlink with
  `update_message`'s `reminderId`). Pass `url` exactly as on `link_message`, and for the user's own
  sent mail pass `outbound: true` + `to`/`cc` — a reminder is a first-class trust source, same as a
  case.

Mint a reminder only when the matter clears all five tests in Step 7 of `SKILL.md` — a commitment you
own, not a mere nudge; a notification / watch / want is dropped, not filed.

## `dueAt` vs `eta`

**`dueAt`** is the ISO sortable / filterable deadline (`'2026-06-15'`); **`eta`** is free text
(`'Awaiting documents'`). Different fields.

## `vaultLinks`

The *titles* of the entity / concept / source vault pages the case draws on (exactly as they appear
inside `[[…]]`), e.g. `["Marco Rivera", "DevForge OSS Project"]`. Cross-link both ways — but delegate
the vault write (the `cases:` frontmatter + `Board:` line on the page) to `/second-brain-ingest`;
this skill sets the case side.

## `snoozeUntil`

ISO date; hides the card until then.

## Hierarchy (Initiative ▸ Workstream ▸ Case)

Owned by **`/board-organize`**, not this skill. Create your cases flat (Step 5 of `SKILL.md`); the
dedicated `/board-organize` sweep clusters same-entity matters into Initiatives ▸ Workstreams on its
own slower cadence, grounded in the user's priorities and respecting manual placements. Don't
`create_initiative` / `create_workstream` / `set_parent` / `regroup_cases` here. (The three tiers all
share the `CASE-<n>` id space; a container carries a rollup of its leaves.)

## Archive / restore / delete

- **`archive_case`** soft-archives (restorable; archived ≠ done).
- **`restore_case`** brings it back.
- **`delete_case`** is soft-only — it moves the case to Trash (identical to `archive_case`,
  restorable). Nothing is destroyed by these verbs; permanent removal is automatic after the
  retention window.

A re-seen email on a Trashed matter should `restore_case` + `link_message`, never `create_case`.

## Approval queue

**`propose`** a board mutation for the human (lands in the pending queue), **`approve`** / **`reject`**
a pending one (`list_pending` for ids). In approval mode, `propose` outward or overriding changes for
the human to decide.

## Search

**`search`** before you create — multi-query dedup (Step 5 of `SKILL.md`). Read-only.

## Templates

**`list_templates`** + **`apply_template`** stamp out a pre-filled case (e.g. an onboarding
doc-checklist) when a new matter fits one.
