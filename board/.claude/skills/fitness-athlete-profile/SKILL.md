---
name: fitness-athlete-profile
description: >
  Manage the ATHLETE PROFILE — the Fitness add-on's TRAINING-FOCUS singleton that the AI
  coaching skills (training plan, weekly review, pre-workout brief) read to personalise their
  output. It SETS / UPDATES / READS the one profile per board via the `fitness` MCP's
  `get_athlete_profile` / `set_athlete_profile` tools: the training-focus goal + goal date,
  weekly availability (days/week, max session minutes), the sports trained, and the equipment on
  hand. It maps free-text ("I have a bike and a pool", "5 days a week, 90 min max") onto the
  English `VALID_ATHLETE_*` vocabularies and validates before writing. Training STATUS, your
  WEIGHT, and your BODY goal (fat loss / muscle / recomp) are NOT here — those live in the body
  add-on (the `body-profile` skill / the `body` MCP). Use when the user says "set my athlete
  profile", "I'm training for a triathlon", "I can train 4 days a week", "I have a kettlebell / a
  treadmill / pool access", "what's my training profile", or otherwise asks to define what they're
  TRAINING for and with. Not medical advice.
---

# Fitness — athlete profile (the coach's training-focus source of truth)

This skill owns the **athlete profile**: the one record (a **singleton** — one per board) that
says *what sport/event the user is training for, with how much time, on which sports, with what
gear*. The three generative coaching skills — **training plan**, **weekly review**, **pre-workout
brief** (all in `fitness-coach`) — read this profile to personalise everything. It writes **only**
through the **`fitness`** MCP — never `bash`/`curl` (Cowork's sandbox blocks outbound HTTP). The
`/fitness` overview page is the read twin.

The profile is **create-or-REPLACE** (`set_athlete_profile` overwrites the whole record;
`createdAt` is sticky). So the cardinal rule is: **read first, then write the merged whole** —
never send a partial that drops fields the user isn't changing.

> **This is the TRAINING half only — the BODY half lives elsewhere (v14).** Your training
> **STATUS** (novice / intermediate / advanced), your **weight + body composition**, and your
> **body goal** (lose fat / build muscle / recomp / maintain — the free-text objective) are owned
> by the **body** add-on, NOT this profile. Set them via the **`body-profile`** skill (or the
> `body` MCP: `set_body_profile` for training status, `log_weight` for weigh-ins, `set_body_objective`
> for the goal) or the **/body** page. This skill's `goal` is a **training FOCUS** — the sport or
> event — not the body objective. The coach reads training status + weight + the body goal
> cross-add-on; you don't set them here.

> **Gate — the add-on must be ENABLED.** `set_athlete_profile` 404s ("Not found — the fitness
> add-on may be disabled.") when the Fitness add-on is disabled; the read (`get_athlete_profile`)
> always works. If the save 404s, the add-on is off — tell the user to enable it from the board's
> **/addons** catalog, then retry. You don't enable it yourself.

> **NOT MEDICAL ADVICE.** Anything weight- or health-related is **informational**, not medical
> advice. Don't prescribe a weight or rate; defer medical conditions, pregnancy/breastfeeding, an
> eating-disorder history, or a user under 18 to a clinician or registered dietitian. The body goal
> + weight live in the body add-on (`body-profile`); the diet math (calorie/macro targets) lives in
> the Nutrition add-on (`nutrition-chef`).

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if missing). State
the mode once.

- **`autoSync: true` (auto mode).** Read the profile, gather/infer the fields, write it, report.
- **`autoSync: false` (approval mode).** A **wholesale replace** of an existing profile (changing
  the goal + several fields at once) is the one write to **confirm in chat** first. A first-time
  set, or a single-field tweak you've echoed back, is low-stakes — just do it.

`get_athlete_profile` is a read — no confirmation in any mode.

---

## THE PROCEDURE — read → gather → validate → write → confirm

### 1. READ the current profile (always first)

Call **`get_athlete_profile {}`**. It returns the singleton (or none if unset).

- **None set yet** → tell the user, then gather it fresh (step 2).
- **Already set** → **show what's set** (goal, days/week, max session, sports, equipment, goal date)
  so the user sees the starting point and you can **merge** their change onto it. For a pure
  *"what's my training profile?"* read, this step is the whole job — render it and stop.

### 2. GATHER the fields (from the user, or infer from their message)

- **`goal`** *(required)* — the **training FOCUS**: the sport/event they're training toward.
- **`goalDate`** (`YYYY-MM-DD`, optional) — the race / target date; `""` when none.
- **`daysPerWeek`** (1–7, optional) and **`maxSessionMinutes`** (optional) — the weekly availability
  the plan must respect.
- **`sports[]`** (optional) — what they train / like to do.
- **`equipment[]`** (optional) — what they have access to.
- **`notes`** (freeform, optional) — anything else the coach should know (injuries to work around,
  schedule constraints, preferences).

Gather what's **missing** conversationally — *"to build a good plan I need your focus, how many days
a week you can train, and your max session length"*. If the user mentions their **training status**,
**weight**, or a **body goal** ("I'm an intermediate lifter", "I'm 80 kg", "I want to lose fat"),
**route those to the body add-on** (`body-profile` skill) — they don't belong on this profile.

### 3. VALIDATE against the allowed vocabularies (bind to these verbatim)

The board rejects anything outside these English enums and **silently drops** unknown
`sports` / `equipment` strings — so map free-text onto the allowed values yourself, and **ask if
ambiguous** rather than guessing.

- **`goal`** ∈ **`VALID_ATHLETE_GOAL`** =
  `["weight_loss", "sprint_triathlon", "olympic_triathlon", "cycling", "swimming", "running", "general_fitness"]`.
  (`weight_loss` is a legacy training-focus value; the real body goal is the free-text **body objective** —
  if the user wants to lose fat / build muscle, set that via `body-profile`, and pick the relevant
  sport or `general_fitness` here.)
- **`sports[]`** ⊆ **`VALID_ATHLETE_SPORT`** =
  `["cycling_outdoor", "cycling_indoor", "running", "walking", "swimming_pool", "swimming_open_water", "rowing", "skiing_alpine", "skiing_cross_country", "snowboard", "hiking", "climbing", "surfing", "kayaking", "strength_training", "hiit", "yoga", "pilates", "dance", "martial_arts", "boxing", "crossfit", "stretching", "tennis", "padel", "soccer", "basketball", "cycling_indoor_zwift"]`.
- **`equipment[]`** ⊆ **`VALID_ATHLETE_EQUIPMENT`** =
  `["road_bike", "home_trainer", "pull_up_bar", "dumbbells", "kettlebell", "resistance_bands", "treadmill", "rowing_machine", "elliptical", "jump_rope", "bodyweight", "pool_access", "gym_access"]`.

**Map free-text onto the vocabularies**, e.g.: *"I have a bike and a pool"* → equipment `road_bike` +
`pool_access`, sports `cycling_outdoor` + `swimming_pool`; *"I swim in the lake"* →
`swimming_open_water`; *"I have a Peloton / Zwift"* → `cycling_indoor` (`cycling_indoor_zwift`) +
`home_trainer`. When genuinely ambiguous, **ask**.

### 4. WRITE — `set_athlete_profile` (create-or-REPLACE)

Call **`set_athlete_profile { goal, goalDate?, daysPerWeek?, maxSessionMinutes?, sports[], equipment[], notes? }`**.

> **It REPLACES the whole record** — send the **merged** profile: the field(s) the user is changing
> **plus** every field you read back in step 1 that they're keeping. Dropping a field you didn't
> restate **erases** it. (`createdAt` is sticky and preserved; you never send it.)

`goal` is **required** (the board 400s without a valid value). The board coerces the optionals:
`daysPerWeek` rounds into 1–7, `maxSessionMinutes` must be positive (else `null`); `goalDate` must be
`YYYY-MM-DD` or `""`; `notes` is capped at 2000 chars; out-of-vocab `sports`/`equipment` are filtered.
(There is **no** `level` / `currentWeightKg` / `targetWeightKg` on this tool anymore — they moved to
the body add-on; passing them is simply ignored.)

### 5. CONFIRM — tell the user it's saved

Report the saved profile (goal, availability, sports, equipment, dates) and that it's **on the
`/fitness` overview**. Note the **coaching skills now use it** (the training plan, the pre-workout
brief, the weekly review — `fitness-coach`), and offer the natural next step (*"want a training plan
for the week?"*). If they haven't set their training status / weight / body goal, nudge them to the
**`body-profile`** skill so the coach has the full picture.

---

> **Example.** *"I'm training for an Olympic triathlon in September, 5 days a week, 90 min max, I've
> got a bike, a pool, and a gym."* (auto mode): `get_athlete_profile` → none set. Map: goal
> `olympic_triathlon`, goalDate the Sept date, daysPerWeek 5, maxSessionMinutes 90, sports `running`
> + `cycling_outdoor` + `swimming_pool`, equipment `road_bike` + `pool_access` + `gym_access`. →
> `set_athlete_profile { goal: "olympic_triathlon", goalDate: "2026-09-12", daysPerWeek: 5,
> maxSessionMinutes: 90, sports: ["running", "cycling_outdoor", "swimming_pool"], equipment:
> ["road_bike", "pool_access", "gym_access"] }`. Confirm + offer a training plan. (If they add *"and
> I want to lose a bit of fat"*, route that to `body-profile` — it's a body goal, not this profile.)

> **Example (update one field, MERGE).** *"actually I can only do 4 days a week now."*:
> `get_athlete_profile` → read the existing record, change `daysPerWeek` to 4, **re-send every other
> field unchanged**, `set_athlete_profile` the whole merged object.

---

## Conventions (guardrails recap)

- **`fitness` MCP only, via `get_athlete_profile` / `set_athlete_profile`.** Never `bash`/`curl`.
- **Singleton, create-or-REPLACE.** One profile per board — **always `get_athlete_profile` first and
  merge**, never send a partial that drops kept fields.
- **TRAINING focus only.** `goal` is the sport/event. Training **status**, **weight**, and the **body
  goal** are the **body** add-on's (`body-profile` skill / `body` MCP) — route those there.
- **The add-on must be ENABLED for the write** (a disabled add-on 404s `set_athlete_profile`).
- **English vocabularies, validated.** `goal` ∈ `VALID_ATHLETE_GOAL`, `sports` ⊆ `VALID_ATHLETE_SPORT`,
  `equipment` ⊆ `VALID_ATHLETE_EQUIPMENT` (verbatim above). Map free-text; **ask when ambiguous**.
- **Mode (STEP 0):** auto → just do it; approval → confirm a **wholesale replace** in chat first.
  There is **no pending/propose queue** — confirmation is conversational.
- **NOT MEDICAL ADVICE.** Defer medical conditions, pregnancy/breastfeeding, eating-disorder history,
  or an under-18 user to a clinician/dietitian. Body goal + weight → `body-profile`; diet math →
  `nutrition-chef`.
- **Report** the saved profile + that it's on `/fitness`, then note the coaching skills use it and
  offer a training plan.
