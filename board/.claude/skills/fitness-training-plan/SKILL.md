---
name: fitness-training-plan
description: >
  The Fitness coach's HEADLINE skill — generate a personalised WEEKLY TRAINING
  PLAN for the athlete with deliberate VARIETY / ROTATION (rotate sports and
  intensity; alternate hard/easy; progressive overload toward the goal date),
  then PERSIST it via `save_training_plan` so it lands on the
  /fitness/training-plan history feed. It reads the athlete profile (focus, goal
  date, availability, sports, equipment), the body add-on (training status, weight,
  the body goal), the last ~4 weeks of actual workouts, the recovery state (HRV /
  sleep / resting HR / form score), and the LAST few plans — varying the new week
  against them. Use when the user says "make me a training plan", "plan my week
  of workouts", "generate this week's training plan", "what should I train this
  week", "I'm training for a race, plan my week", or otherwise
  asks for a forward week of structured sessions. (Watch data → fitness-health-data;
  the past week → fitness-weekly-review; the daily go/no-go brief →
  fitness-pre-workout-brief.)
---

# Fitness — weekly training plan (the headline coaching skill)

This is the **flagship** of the Fitness coach: it turns *"plan my week"* / *"I'm
training for an Olympic tri in September, build this week"* into a **7-day,
day-by-day training plan** that is **personalised** to the athlete's goal +
constraints, **adapted** to their current recovery, and — the whole point —
**deliberately VARIED against the recent plans/workouts** so the athlete isn't fed
the same week on repeat. You **author** the plan in your own reasoning, then
**persist** it via the **`fitness`** MCP's `save_training_plan` so it lands on the
**`/fitness/training-plan`** history feed.

**The board is a state machine; YOU are the coach.** There is **no board-side LLM**
— the board never designs a plan. The `/fitness/training-plan` page is a **history
feed** over persisted `training_plan` artifacts (latest-by-default, page-back); its
Generate action **hands off to you**, it does not call a server-side model. So
**never** tell the user to "click Generate and wait" — *you* generate, *you*
`save_training_plan`, and the result appears on the feed.

> **Gate (same as fitness-coach).** `save_training_plan` is an **add-on-gated write**
> — it 404s ("Not found — the fitness add-on may be disabled.") when the Fitness
> add-on is off (tell the user to flip it on at **/addons**; you don't enable it
> yourself). All the READ tools below are ungated — read freely.

> **STEP 0 — the mode switch.** Read `config/auto-sync.json` → `{ "autoSync": <bool> }`
> (default **ON / auto** if missing) and state the mode once. Saving one plan is a
> single low-stakes write — **just do it** in either mode. The conversational
> confirm is reserved for the **bulk** calendar push (STEP 8) and any destructive
> action.

> **NOT MEDICAL ADVICE.** A training plan is an **informational estimate**, not
> medical advice. A "train easy / take a recovery day" call on low HRV or poor sleep
> is a conservative default, **not** clinical judgement. **Defer to a professional**
> (physician, physiotherapist, qualified coach) for any injury, pain, abnormal
> symptom, medical condition, pregnancy, or an under-18 athlete — recommend they
> consult one and don't prescribe hard training.

---

## The procedure: FETCH → GENERATE → PERSIST

### 0.5 CLOSE OUT last week (before authoring anything)

Before generating anything new, reconcile what actually happened last week — an outcome is a
fact only the user (or a proven workout) can supply, and skipping this step means STEP 4's
rotation reads intentions instead of reality.

- **Find the most recent prior plan.** `list_coaching_artifacts { kind:"training_plan", limit:4 }`,
  take the most recent one whose week PRECEDES the week you're about to plan, then
  `get_coaching_artifact { id }` and read its **`reconciliation`** — all three fields:
  `sessionDays` (the batched line's "N planned"), `outcomes` (feeds STEP 4's rotation), and
  `unresolvedDays`.
- **Auto-resolve the proven subset, silently.** For every `unresolvedDays.days[]` entry with
  `provenDone: true`, call `set_plan_day_outcome(artifact_id, date, "done")` — no need to ask,
  a same-date workout entry already proves it happened. Cite the proving `healthEntryId` in your
  run report.
- **Batch everything else into one batched question.** For the remaining `unresolvedDays`, ask
  ONE question — counts first, then the days: *"Last week: 3 planned, 1 proven done. Mon
  strength + Wed stretch are unanswered — done, skipped, or move one into this week?"* **In
  every mode**: an outcome is a fact only the user knows — **never guess, never mark an
  unanswered day**; it simply stays `planned` (the issue's "Never fabricate" rule — the same
  discipline JOB 0 uses for nutrition intake). **In an unattended (scheduled) run nobody can
  answer:** put the batched question in the run report (and in the new plan's `weekly_notes`)
  and **proceed to STEP 1 immediately** — the unanswered days stay `planned` and are re-asked
  next run. Only a conversational run waits for the answer; the weekly plan is never skipped
  because a question went unanswered.
- **Answers.** "done" / "skipped" → `set_plan_day_outcome(artifact_id, date, status)`. "move it
  [to \<date\>]" → `set_plan_day_outcome(artifact_id, date, "moved", moved_to:<chosen date>)`
  **and** carry that session into the new week's plan you're about to author (place it on
  `moved_to`'s date when you reach STEP 6) — that's the cross-week relocation; STEP 8's push
  materialises it once you save. Two rules the board enforces on the re-save (400 otherwise):
  **keep the old date's day entry** in the week you re-save (its `moved` status and its calendar
  receipt carry forward by date — dropping the entry loses both), and **one entry per date** — a
  session moved onto a date that already has one is MERGED into that single entry (or the
  existing session is pushed to another free date), never a second entry on the same date.
- **Nothing unresolved, or no prior plan** → say so in **one line** and go straight to STEP 1.

### 1. FETCH the goal + constraints — `get_athlete_profile {}` + the body add-on

Read TWO sources (the body half moved off the athlete profile in v14):

- **`get_athlete_profile {}`** (fitness MCP) — the **TRAINING FOCUS** + availability: **goal**
  (the sport/event — e.g. `olympic_triathlon` / `running` / `general_fitness`, NOT the body goal),
  **goalDate**, **daysPerWeek**, **maxSessionMinutes**, **sports[]**, **equipment[]**, **notes**.
- **The body add-on** (body MCP) — identity, weight, and the body goal:
  - **`get_body_profile {}`** → **trainingStatus** (`novice | intermediate | advanced` — the
    experience level that sets how fast to progress; "novice" replaces the old "beginner"),
    **heightCm**, **sex**, **resistanceTrains** (do they lift — progressive RT is gated on this).
  - **`get_body_status {}`** → the FACTS for load context: current + trend **weight**, BMR / TDEE.
  - **`get_body_objective {}`** → the **FREE-TEXT** body goal (`goalText` — prose like *"lose fat
    but keep my strength"*; there is **no** pick-list) + `targetWeightKg`.

These are the hard constraints the plan must respect (days available, equipment on hand, session
ceiling, the disciplines done) plus **how aggressively to progress** (`trainingStatus`) and **what
the body goal is** (read the free-text `goalText` — don't expect an enum).

> **No profile → STOP.** If `get_athlete_profile` returns nothing, a plan without a training focus
> is weak — don't guess. Tell the user to set it (the **fitness-athlete-profile** skill / the
> **/fitness** page); for the body goal / training status / weight, point them at the
> **body-profile** skill / the **/body** page. Then stop here.

### 2. FETCH what was actually done lately — `list_health_data { type:"workout", from:<~28d ago> }`

Pull the **last ~4 weeks of workouts** (`from` = today − 28d) — the **raw material**
for progression and for avoiding monotony. Read off: which **sports** were trained,
the **weekly frequency**, the **volume** (durations/distances) and rough **intensity
mix**. This tells you what to **progress** (a touch more volume/intensity than last
week, toward the goal) and what's gone **stale** (a discipline neglected, or one
hammered three weeks running that now wants a deload).

### 3. FETCH the recovery state — `get_health_trends { days:14 }` and/or `get_form_score { date:<today> }`

Read the **HRV** trend, **resting HR**, and **sleep** over the last 14 days, and/or the
deterministic **form score** for today (`get_form_score` returns `{ score, level, color,
breakdown:{hrv,sleep,resting_hr,load}, recommendation }` — the board computes it; you
**interpret**, you don't recompute). Collapse this into the week's **`recovery_status`**:

- **`good`** — HRV stable/up, sleep solid, form high → you can prescribe the planned
  hard sessions and push volume toward the goal.
- **`moderate`** — mixed signals, mild fatigue → hold intensity, trim the hardest
  session, keep an easy/recovery day in.
- **`poor`** — HRV suppressed, poor sleep, high accumulated load → open the week
  easy, add a recovery day, defer the key session.

### 4. FETCH the LAST few plans for ROTATION — `list_coaching_artifacts { kind:"training_plan", limit:4 }`

**This is the heart of the skill.** Read the **last ~4 `training_plan` artifacts** (use
`get_coaching_artifact { id }` to read a full one) and see **exactly what you
prescribed recently** — then **DELIBERATELY VARY the new week against them.** Concretely:

- **Rotate the sports / discipline focus.** Don't repeat last week's split. For a
  **triathlon**, rotate which of swim / bike / run carries the week's *key* session
  (e.g. last week's focus was the long ride → this week's is the threshold run or the
  swim-technique block). Touch all required disciplines but **move the emphasis**.
- **Alternate hard ↔ easy at the week level.** If the recent weeks have been building
  hard, make this one a **lighter / deload** week (every ~4th week), and vice-versa.
- **Vary the session TYPES.** Don't serve the same intervals every Tuesday — rotate
  among intervals / tempo-threshold / long endurance / technique / strength /
  active-recovery so the stimulus (and the experience) stays fresh.
- **Progress toward `goalDate`.** Earlier in the build → more base/volume; closer to
  the event → more race-specific intensity and a taper. Each week should be a small,
  **progressive** step on the last, not a copy and not a random reshuffle.
- **Avoid back-to-back same-sport hard days** and repeated identical descriptions.

If there are **no prior plans**, this is week one — set a sensible **baseline** and
note in `weekly_notes` that future weeks will rotate off it.

**Rotate off outcomes, not intentions.** STEP 0.5's `reconciliation.outcomes` counts and each
recent plan's per-day `status` are the real rotation input, not just what was originally
scheduled — a session that was repeatedly `skipped` or `moved` must **change** next week
(different slot, sport, duration, or dropped entirely), not be re-planned verbatim as if it had
happened.

### 5. (soft) FETCH nutrition if weight is a goal — `list_food_log { ... }`

**Only if** the body goal involves fat loss or a target weight (from `get_body_objective` — the
free-text `goalText` + `targetWeightKg`), optionally glance at the Nutrition add-on's food log (`list_food_log`) to tune volume /
the easy-vs-hard balance to the energy the athlete's actually fuelling. This is a
**soft** edge — if Nutrition is off, skip it silently (it's not a fault).

### 6. GENERATE the 7-day plan (in your own reasoning)

Author **seven day entries**, one per calendar day of the next ISO week, honouring
**everything** above:

- **Respect `daysPerWeek`** — exactly that many *training* days; fill the rest with
  **`rest`** or **`active_recovery`** (a walk, easy spin, mobility). Don't exceed the
  athlete's available days.
- **Respect `equipment` + `sports`** — only prescribe sessions they can actually do
  (a pool session only if they have pool access; an indoor trainer ride only if they
  have a home trainer; etc.).
- **Respect `maxSessionMinutes`** — no day's `duration_min` over the ceiling.
- **Adapt intensity to `recovery_status`** (STEP 3) — `poor` opens easy + adds
  recovery; `good` allows the key hard sessions.
- **Injury-prevention** — no two hard same-sport days back to back; sandwich hard
  days with easy/rest; ramp volume gradually (≈10%/week rule of thumb).
- **Describe zones / RPE per day** — give each working day its target effort (e.g.
  Zone 2 endurance / RPE 3–4; threshold Zone 4 / RPE 7–8; recovery Zone 1) in
  `zones` + `description`.
- **Vary vs. the recent plans/workouts** (STEP 4) — make the rotation visible.

Each day object:
`{ date:"YYYY-MM-DD", day:"Mon"…"Sun", type:<"endurance"|"intervals"|"tempo"|"long"|
"strength"|"technique"|"active_recovery"|"rest"|…>, sport:<a VALID_ATHLETE_SPORT or
"rest">, duration_min:<int>, intensity:<"recovery"|"easy"|"moderate"|"hard">,
description:"<the session, concretely>", zones:"<the effort target>" }`.

### 7. PERSIST — `save_training_plan { … }`

Upsert the plan by **ISO week** (regenerating the same week **replaces**, no
duplicate). Save:

```
save_training_plan({
  week: "<next ISO week, e.g. 2026-W26>",
  recovery_status: "good" | "moderate" | "poor",
  days: [ {date, day, type, sport, duration_min, intensity, description, zones} × 7 ],
  weekly_notes: "<the RATIONALE — the week's focus, the recovery read driving the
    intensity, and EXPLICITLY how it rotates/progresses vs. the recent plans
    (which sport carries the key session this week, hard-vs-easy at the week level,
    the step toward goalDate)>",
  generated_at: "<optional ISO now>"
})
```

**Validate your own JSON** against this shape before sending — the board rejects a
malformed body, it does not repair it. A bad `sport` string or a missing day will be
refused.

**When re-saving a week, never include `status`, `movedTo`, or `eventId` keys in the days you
send** — the board carries them forward; sending one overwrites the recorded fact.

### 8. Push the week to the calendar — `push_plan_to_calendar`

Once the plan is saved, put the sessions on the calendar **by default**. **First, read
the user's REAL calendar** (your own Google Calendar connector) for the week's date
range and collect the busy times — **only** `{date, start, end}`, never a title,
attendee, or any other content. Then call the `fitness` MCP's
**`push_plan_to_calendar({ period_key: "<the week>", busy_windows: [...] })`** —
`busy_windows` is optional (omit it if you can't read the real calendar), but pass it
whenever you can, so a session never lands on top of a real meeting the board's own
`db.events` doesn't know about. **Never ask Cos to store this calendar data** — the
tool uses it for this one call only and discards it; it is not a sync.

The push is also **idempotent and overlap-safe**: a session lands in a free slot
within its day's candidate windows and is never placed on top of an existing timed
event or inside the user's **working hours** (Mon–Fri 09:00–18:00 by default, or
whatever the board has stored — this happens automatically, you don't set it here);
rest / active-recovery days are always skipped, never placed. Re-running it after the
plan changes **reconciles** the week (creates new sessions, refreshes changed ones,
never duplicates) instead of re-creating it — safe to call every time this skill
runs. A session time you or Philip edited by hand is **never moved back** by a
re-push; only its title/description refresh.

This is a **bulk** write (a whole week of events), so in **approval mode** it is the
ONE confirmation STEP 0 reserves for the whole run — lay the week out and get a
single yes before calling it. In auto mode, call it and report.

**Relay every `skipped` result with its reason** — `rest_day` (expected, no action
needed), `resolved` (the day was already marked done/skipped/moved by STEP 0.5's close-out or
the training-plan view; expected), `no_free_slot` (the day was genuinely
fully booked; tell the user which day), or `outside_working_hours` (every candidate slot fell
inside working hours — this is a policy skip, not congestion; tell the user their working day
left no margin). When a skipped result — a rest day OR a `resolved` day — carries an
`eventId`, a session is still on the calendar for a slot that no longer holds one (the plan
changed since that day was last pushed, or the day was **moved** and its original slot is now
stale) — tell the user and offer to remove it via the `calendar` MCP's delete tool (the board
itself never deletes it). A `resolved` result without an `eventId` needs no action. (The `/fitness/training-plan` page's own "Add to calendar"
button calls the same route server-side; either path works, but only this skill's
path can supply `busy_windows`.)

### 9. Tell the user

Confirm the plan is **saved** and **visible in the `/fitness/training-plan` history
feed** (latest-by-default). Call out the **week's focus**, the **`recovery_status`**
driving the intensity, the **rest/recovery days**, and — explicitly — **how this week
rotates/progresses vs. last** (the variety is the value; make it legible). Report
what STEP 8's calendar push did (created / updated / skipped, with reasons) and
offer the **weekly review / pre-workout brief** (fitness-coach) as follow-ups. Carry
the **not-medical-advice** framing.

---

## Guardrails recap

- **Close out last week FIRST** (STEP 0.5) — before authoring anything new, auto-resolve the
  proven subset silently and batch the rest into one question.
- **Rotation reads outcomes, not intentions; never fabricate one** — an unanswered day stays
  `planned`; only the user (or a proven workout) can confirm what actually happened.
- **The board does NOT generate — YOU do.** No board-side LLM; you author the plan
  and `save_training_plan` it. Never say "click Generate and wait" — that button
  hands off to you, and the result lands on the `/fitness/training-plan` feed.
- **No profile → stop** and point at **fitness-athlete-profile** / the **/fitness**
  page. A plan without a goal is weak.
- **VARIETY / ROTATION is the whole point.** Always read the last ~4 plans
  (`list_coaching_artifacts { kind:"training_plan", limit:4 }`) **and** the last ~4
  weeks of workouts, and **deliberately vary** the new week against them — rotate the
  sport focus, alternate hard/easy at the week level, rotate session types,
  progressively overload toward `goalDate`. No two weeks the same.
- **Respect the profile's constraints** — `daysPerWeek` (rest/active-recovery on
  off-days), `equipment`, `sports`, `maxSessionMinutes`. **English vocabulary only**
  — bind sports/equipment to the `VALID_ATHLETE_SPORT` / `VALID_ATHLETE_EQUIPMENT`
  enums.
- **Adapt to recovery** — read HRV / sleep / resting HR / form score into a
  `recovery_status` and let it drive the week's intensity; injury-prevention baked in.
- **Gate + mode** — `save_training_plan` 404s if the add-on is off (flip on at
  /addons). Saving one plan is low-stakes in any mode; confirm only the **bulk**
  calendar push in approval mode.
- **Calendar push is the DEFAULT, not an offer** — `push_plan_to_calendar` runs
  after every save; it's idempotent + overlap-safe, rest/active-recovery days are
  always skipped, and a human-edited event time is never moved back. Bulk, so
  confirm once in approval mode. Read the user's real calendar first and pass its
  busy times as `busy_windows` (date/start/end only — never store the content);
  working hours are protected automatically either way.
- **NOT MEDICAL ADVICE** — informational estimate; defer injuries / pain / symptoms /
  medical conditions / pregnancy / under-18 to a professional; don't push hard
  training on poor recovery.
- **Result lives on the feed** — tell the user it's saved + visible at
  **/fitness/training-plan**; browse prior plans with `list_coaching_artifacts` /
  `get_coaching_artifact`, prune with `delete_coaching_artifact`.
