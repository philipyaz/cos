# Calendar placement — the shared engine behind every calendar push

[Fitness](fitness.md)'s training-plan push, [Nutrition & Chef](nutrition.md)'s meal-plan push, and
the generic `POST /api/events` route's `place` mode (cos-ops#24's chase-block allocation) all need
the same primitive: turn a list of things that want a slot into decisions — create, update, or
skip — without ever double-booking. Rather than a copy of that logic per caller, every placement
caller shares **one pure engine**,
[`board/lib/placement.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/placement.ts), and
this page documents its contract, its two inputs from outside the board's own data, and the limits
worth knowing before you rely on it.

This is the reusable primitive PRODUCT's A1 exit signal asks for — *"slot proposals are
overlap-safe"* — and it is deliberately **not a scheduling engine**: it decides nothing about
*where* the candidate windows are (that is the caller's job — see each push route) and it never
reads an external calendar itself.

## The engine contract

`planPlacement` is a pure function, no I/O, clock injected — the standard shape this codebase uses
for a deterministic engine: pure engine + thin route + MCP tool + api test + unit test:

```ts
planPlacement({
  requests: PlacementRequest[],   // things that want a slot, in the order to place them
  events: CalendarEvent[],        // the board's own db.events — timed, non-cancelled ones are busy
  busyWindows?: BusyWindow[],     // caller-supplied busy times — see "The busy-set input" below
  policy?: PlacementPolicy,       // the working-hours preference — see "Working hours" below
  today: string,                  // "YYYY-MM-DD" — the injected clock
}) => PlacementOp[]
```

A `PlacementRequest` carries a `key` (echoed back on the resulting op), a `date`, a `durationMin`,
a list of `windows` (candidate time ranges **in preference order** — the caller resolves these, not
the engine), a `title` + `description`, and an optional `existingEventId` — the caller's own proof
that a receipt points at a **live** event. The result is one `PlacementOp` per request:

| Op | When | Notes |
|---|---|---|
| `create` | A free gap was found | `{startTime, endTime}` inside one of the request's candidate windows |
| `update` | `existingEventId` was supplied | **Never** touches `date`/`startTime`/`endTime` — only title/description refresh |
| `skip` | Nothing fit | `reason`: `past` \| `no_free_slot` \| `outside_working_hours` |

Five rules, each a unit-test case in
[`tests/unit/placement.test.ts`](https://github.com/philipyaz/cos/blob/main/tests/unit/placement.test.ts):

1. **Receipt first.** A live `existingEventId` always **updates**, never a skip/create, and never
   moves the event's time — human placement wins, content refreshes. This is the pinned answer to a
   manually-edited session/meal time: a re-push never moves it back.
2. **Past days skip** (`date < today`) with reason `past`, unless a live receipt exists (a past day
   *with* a receipt still gets its content `update` — the event is the record of the plan).
3. **The busy set** per date is the board's own timed events (`!allDay && startTime`, a missing
   `endTime` defaulting to +60 minutes) **unioned with** the caller's `busyWindows` for that date.
   The busy set excludes any event whose `status` is `"cancelled"` — a cancelled meeting stays on
   the calendar as the record but is no longer a real claim on the time. A `"tentative"` hold
   **still blocks** (a hold is a real claim on the time) — a one-word reversal in `placement.ts`
   if holds should ever read as free.
4. **Earliest fit, in preference order.** The engine walks `windows` in the order given and takes
   the first gap, in the first window, that fits — never falling back outside the given windows.
5. **Same-call creates stack.** A `create` earlier in one `planPlacement` call becomes busy for
   later requests in the *same* call, so two meals on one evening never land on top of each other.

## The busy-set input — per-call, never persisted

Cos has **no calendar sync** — no OAuth, no polling, no IMAP-style client — and it must not grow
one. VISION's rule 2 is explicit: *"Cos does not rebuild what the agent already reaches. It has no
reason to write an IMAP client or a calendar sync engine when the agent is already connected to
Gmail and Google Calendar."* The agent already holds that connector; the board holds the decisions
and state.

So `busyWindows` is an **argument**, not a lookup the engine performs. The caller — the
`fitness-training-plan` or `nutrition-chef` skill, running inside an agent with its own Google
Calendar connector — reads the target window's busy times itself and hands the engine only
`{date, start, end}` triples: no titles, no attendees, no other content. The engine unions them
into its busy set for exactly that one call, and then they are gone. Both push routes' request
bodies accept an optional `busyWindows` array (validated: `isISODate` + `isHHMM`, `start < end`) and
pass it straight through — **nothing about it is ever written to `cases.json`**. The
`api-fitness-push-plan.mjs` suite asserts this directly: after a push carrying `busyWindows`, the
raw store file is grepped and neither of the sentinel times it sent appears anywhere in it.

This is the same division of labour the repo's
[architecture philosophy](https://github.com/philipyaz/cos/blob/main/CLAUDE.md) states for LLM
inference, applied instead to **data**: the board never calls an LLM, and it also never ingests
another system's state — both stay the agent's job, and the board only ever validates, uses, and
discards what it's handed.

## Working hours — a shipped default, not a setup step

Without a notion of "the user is usually working," the busy set above is incomplete for its own
sake: the board's calendar carries very few of Philip's actual work meetings (they live in a
calendar the board doesn't sync), so a placement that only avoids `db.events` would confidently
propose a slot on top of a real meeting the board simply doesn't know about.

The fix is a **preference**, not a sync: `Settings.workingHours` on the existing `db.settings`
object —

```ts
workingHours?: { days: number[]; start: string; end: string }  // ISO weekday: Mon=1 … Sun=7
```

— unset ⇒ `DEFAULT_WORKING_HOURS` (`{ days: [1,2,3,4,5], start: "09:00", end: "18:00" }`, exported
from `lib/placement.ts`). Shipping a working default means this needs **no setup step and no
first-run question** — the default is the answer for the person this is built for, and there is
deliberately no settings-editor route yet (see [Known limits](#known-limits)).

A `PlacementPolicy` tells the engine *how* to enforce the window, and the meaning is genuinely
different depending on what's being placed:

- **`margins`** — the mode both push routes use today. On a day whose weekday is a working day,
  the working window is **added to the busy set**, so a training session or a meal can never land
  inside it — working hours are protected *margins*, and training/meal windows are expected to sit
  in the morning/evening/weekend around them. Non-working days are left unprotected.
- **`within`** — the mode for a caller that places *work itself*, a sibling capability to
  `margins`: candidate windows are **clamped** to the working window, and a non-working weekday or a
  weekend is refused outright. It shipped unit-tested with no product caller (the smallest honest
  way to satisfy *"placement never proposes a slot outside the configured working window, and never
  on a weekend"* ahead of the caller that needed it), and cos-ops#24's chase-block allocation on
  `POST /api/events` is its first: an admin/work chase (*"call the clinic, they open 08:00"*) wants
  business hours, not the fitness/meal-plan pushes' evening margins.
- **No `policy` at all** ⇒ exactly the engine's pre-`workingHours` behaviour — the additive
  guarantee that let this ship without touching either existing push route's other tests.

**The skip reason is pinned, and it matters.** A request that fails because its only candidate
windows sit *entirely inside* a protected working day (a weekday lunch, in `margins` mode; any
window on a non-working day, in `within` mode) is reported `outside_working_hours` — never
`no_free_slot`. Reporting a policy skip as "fully booked" would tell the agent a false story about
*why* nothing was placed. `no_free_slot` is reserved for the case where a window really did have a
chance and lost it to real congestion (an actual event, or the caller's own `busyWindows`).

## Third consumer — chase blocks (cos-ops#24)

The generic `POST /api/events` route (and the `calendar` MCP's `create_event`) accept the same
optional `place` parameter as the two pushes above — `{ durationMin, windows, busyWindows?, policy?
}` — as an alternative to explicit `startTime`/`endTime`. This is the placement engine's **third**
consumer, and the first product caller of its `within` policy mode (see [Working
hours](#working-hours-a-shipped-default-not-a-setup-step) above): the `board-organize` skill's weekly staleness lens (see [Triage
skills](../architecture/triage-skills.md#board-organize-the-housekeeper)) uses it to place a timed
chase block for a starving obligation, choosing the day and candidate windows (typically a wide
business-hours window with `policy: "within"`) while the board finds the actual free gap.

Unlike the two pushes, this consumer has no persisted artifact to carry an `eventId` receipt
forward across a re-plan — there is no "day 3 of this week's plan" to re-target. So
`existingEventId`/update reconciliation is **not exposed** on this path: the route only ever
`create`s or `skip`s (409, with a machine-readable `reason`: `no_free_slot` |
`outside_working_hours` | `past`). An already-placed chase block is never edited in place by this
surface — the calling skill deletes and re-places it if the timing needs to change.

`busyWindows` follows the same [busy-set contract](#the-busy-set-input-per-call-never-persisted)
as the pushes — per-call, used-and-discarded, never persisted. The HTTP field is camelCase on
every route (`busyWindows` for the pushes, `place.busyWindows` here); the **MCP tool** spelling
differs deliberately: the fitness/nutrition push tools spell theirs `busy_windows` (their own
servers' convention), while the `calendar` MCP spells it `place.busyWindows` — camelCase, matching
that server's existing `startTime`/`endTime`/`allDay`/`caseId` argument style.

## Receipts and idempotency

Each push route writes the newly-created event's id back onto its own initiator record — the
training-plan artifact's `payload.days[i].eventId`, or the meal-plan entry's `eventId`: the
initiator's own record carries the receipt, with no generic cross-store receipts table. A day/entry
with a **live** receipt is passed to the engine as
`existingEventId`, which always resolves to an `update` (rule 1 above) — so a re-push after
nothing changed is a no-op in effect (content refreshes, nothing duplicates), and a re-push after
the plan changed only touches what actually changed.

For the fitness push specifically, `upsertCoachingArtifact` **carries receipts forward** across a
regenerate: a day that survives into a newly-saved plan (matched by `date`) inherits the outgoing
payload's `eventId` for that date. Without this, regenerating the same week's plan and pushing it
would duplicate every session, because the fresh payload would arrive with no receipts at all.

## Known limits

- **Orphaned events are never deleted.** If a re-planned week **drops** a date entirely, or
  **flips** a date that already has a live event to `rest`/`active_recovery`, the old calendar event
  is left exactly as it was — the board never deletes state a human may have adopted or edited. The
  flipped-to-rest case is the more visible one: the push reports that day `skipped`/`rest_day`
  **carrying the stale `eventId`**, so the calling skill can see it and offer to remove it via the
  `calendar` MCP's delete tool. The dropped-date case has no such signal — the orphan just sits on
  the calendar until removed by hand.
- **A manual artifact-payload `PATCH` bypasses carry-forward.** `PATCH /api/fitness/coaching/[id]`
  (`applyCoachingArtifactUpdate`) replaces `payload` wholesale, same as a regenerate, but without the
  receipt carry-forward step `upsertCoachingArtifact` does. No MCP tool exposes this path today; it
  is a known gap, not a guarded one.
- **No settings-editor write path for `workingHours` yet.** The preference is read from
  `db.settings.workingHours`, but there is no route or UI that writes it — changing it from the
  shipped default currently means editing the store directly, which is exactly what
  [`board/data/CLAUDE.md`](https://github.com/philipyaz/cos/blob/main/board/data/CLAUDE.md) says
  never to do on a live board. The shipped default is the intended answer for now; a real settings
  surface can pick the field up later without any migration (it is additive and optional).

## Reachable from every surface

None of the three callers nor the placement engine is UI-only — all are equally reachable over
HTTP and MCP, closing what would otherwise be an agent-invisible feature:

| Caller | Route | MCP tool |
|---|---|---|
| Fitness training plan | `POST /api/fitness/push-plan-to-calendar` | `push_plan_to_calendar` (`fitness` MCP) |
| Nutrition meal plan | `POST /api/nutrition/push-plan-to-calendar` | `push_meal_plan_to_calendar` (`nutrition` MCP) |
| Chase blocks (cos-ops#24) | `POST /api/events` (`place`) | `create_event` (`place`) (`calendar` MCP) |

All three accept a caller-supplied busy set (an optional array of `{date,start,end}` — camelCase
`busyWindows` on every HTTP route; `busy_windows` on the fitness/nutrition MCP tools,
`place.busyWindows` on the calendar MCP tool) and the `workingHours` preference, resolved
server-side from `db.settings` — the caller never has to supply the working-hours window itself,
only what it alone can see: the real calendar's busy times. See [Fitness](fitness.md) (the
coaching-artifacts section covers its push in full),
[Nutrition & Chef](nutrition.md#calendar-placement-the-default-push-plus-a-manual-explicit-time-path)
for each push surface's own request/response shape, [Triage skills](../architecture/triage-skills.md#board-organize-the-housekeeper)
for the chase-block caller, and [Calendar](calendar.md) for the `CalendarEvent` records every
route creates.
