---
name: fitness-training-plan
description: >
  The Fitness coach's HEADLINE skill — generate a personalised WEEKLY TRAINING
  PLAN for the athlete with deliberate VARIETY / ROTATION (rotate sports, focus,
  and intensity week to week; alternate hard/easy; progressive overload toward the
  goal date), then PERSIST it via `save_training_plan` so it lands on the
  /fitness/training-plan history feed. It reads the athlete profile (training
  focus, goal date, days/week, max session, sports, equipment) AND the body add-on
  (training status, current weight, the free-text body goal), the last ~4 weeks of
  actual workouts, the recovery state (HRV / sleep / resting HR / form score), and
  the LAST few plans — and deliberately varies the new week against
  them so no two weeks look the same. Use when the user says "make me a training
  plan", "plan my week of workouts", "generate this week's training plan", "build
  my weekly training plan", "plan my training", "what should I train this week",
  "I'm training for <an event>, plan my week", or otherwise asks for a forward
  week of structured sessions. (For ingesting/reading watch data use
  fitness-health-data; for the past week use fitness-weekly-review; for the daily
  go/no-go brief use fitness-pre-workout-brief.)
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

### 8. (optional, cross-add-on) Offer the calendar — `create_event`

Once the plan is saved, **offer** to put the sessions on the calendar — **one
`create_event` (the `calendar` MCP) per training day**, the session in the
description (write rest days as a "Rest" marker or skip them). This is **cross-add-on
and optional** — don't do it unless the user asks. It's a **bulk** write (a whole
week of events), so in **approval mode** lay it out and confirm before firing.
(The /fitness/training-plan page also has its own "add to calendar" action that does
the same server-side; either path works.)

### 9. Tell the user

Confirm the plan is **saved** and **visible in the `/fitness/training-plan` history
feed** (latest-by-default). Call out the **week's focus**, the **`recovery_status`**
driving the intensity, the **rest/recovery days**, and — explicitly — **how this week
rotates/progresses vs. last** (the variety is the value; make it legible). Offer the
calendar push (STEP 8) and the **weekly review / pre-workout brief** (fitness-coach)
as follow-ups. Carry the **not-medical-advice** framing.

---

## Guardrails recap

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
- **Calendar is cross-add-on + optional** — only on request; one `create_event` per
  training day; bulk, so confirm in approval mode.
- **NOT MEDICAL ADVICE** — informational estimate; defer injuries / pain / symptoms /
  medical conditions / pregnancy / under-18 to a professional; don't push hard
  training on poor recovery.
- **Result lives on the feed** — tell the user it's saved + visible at
  **/fitness/training-plan**; browse prior plans with `list_coaching_artifacts` /
  `get_coaching_artifact`, prune with `delete_coaching_artifact`.
