---
name: fitness-athlete-profile
description: >
  Manage the ATHLETE PROFILE — the Fitness add-on's singleton that the AI coaching
  skills (training plan, weekly review, pre-workout brief) all read to personalise their
  output. It SETS / UPDATES / READS the one profile per board via the `fitness` MCP's
  `get_athlete_profile` / `set_athlete_profile` tools: the goal + goal date, experience
  level, weekly availability (days/week, max session minutes), the sports trained, the
  equipment on hand, and current/target weight. It maps free-text ("I have a bike and a
  pool", "5 days a week, 90 min max") onto the English `VALID_ATHLETE_*` vocabularies and
  validates before writing. Use when the user says "set my athlete profile", "I'm
  training for a triathlon", "update my training goal", "my goal is to lose weight", "set
  my weekly availability", "I can train 4 days a week", "what's my training profile",
  "show my athlete profile", "I have a kettlebell / a treadmill / pool access", or
  otherwise asks to define, change, or read what they're training for and with. Not
  medical advice for any weight / health target.
---

# Fitness — athlete profile (the coach's source of truth)

This skill owns the **athlete profile**: the one record (a **singleton** — one per board)
that says *what the user is training for, at what level, with how much time, on which
sports, with what gear*. The three generative coaching skills — **training plan**, **weekly
review**, **pre-workout brief** (all in `fitness-coach`) — read this profile to personalise
everything. A plan without a goal is weak; this skill is how the goal gets set. It writes
**only** through the **`fitness`** MCP — never `bash`/`curl` (Cowork's sandbox blocks
outbound HTTP; the tools exist for exactly this). The `/fitness` overview page is the read
twin where the human can see the saved profile.

The profile is **create-or-REPLACE** (`set_athlete_profile` overwrites the whole record;
`createdAt` is sticky, preserved across replaces). So the cardinal rule is: **read first,
then write the merged whole** — never send a partial that drops fields the user isn't
changing. The validation + storage live on the board; **YOU** (the agent) do the
gathering, the free-text → enum mapping, and the merge.

> **Gate — the add-on must be ENABLED.** `set_athlete_profile` 404s ("Not found — the
> fitness add-on may be disabled.") when the Fitness add-on is disabled; the read
> (`get_athlete_profile`) always works. If the save comes back "Not found.", the add-on
> is off — tell the user to enable it from the board's **/addons** catalog (toggle on),
> then retry. You don't enable it yourself; it's a deliberate, human, one-time switch.

> **NOT MEDICAL ADVICE.** A `weight_loss` goal or any `currentWeightKg` / `targetWeightKg`
> is an **informational** target, **not** medical advice. Don't prescribe a weight or a
> rate; record what the user states, and **defer to a clinician or registered dietitian**
> for anything medical (a medical condition, pregnancy/breastfeeding, an eating-disorder
> history, or a user under 18). For the actual diet math (calorie targets, deficit, ETA),
> that's the Nutrition add-on's job — point them at `/nutrition-chef`.

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if the file
or key is missing). State the mode once.

- **`autoSync: true` (auto mode).** Read the profile, gather/infer the fields, write it,
  and report what you saved.
- **`autoSync: false` (approval mode).** A **wholesale replace** of an existing profile
  (changing goal/level and several fields at once) is the one write to **confirm in chat**
  first — lay out the merged profile you're about to save and get a yes. A first-time set,
  or a single-field tweak you've echoed back, is low-stakes — just do it.

`get_athlete_profile` is a read — no confirmation in any mode. Read freely.

---

## THE PROCEDURE — read → gather → validate → write → confirm

### 1. READ the current profile (always first)

Call **`get_athlete_profile {}`**. It returns the singleton (or none if unset).

- **None set yet** → tell the user there's no profile, then gather it fresh (step 2).
- **Already set** → **show what's set** (goal, level, days/week, max session, sports,
  equipment, goal date, weights) so the user sees the starting point — and so you can
  **merge** their change onto it rather than clobbering the rest (the write is a full
  replace; see step 4). For a pure *"what's my training profile?"* read, this step is the
  whole job — render it and stop.

### 2. GATHER the fields (from the user, or infer from their message)

The fields of the profile:

- **`goal`** *(required)* — what they're training toward.
- **`goalDate`** (`YYYY-MM-DD`, optional) — the race / target date; `""` when none.
- **`level`** *(required)* — self-assessed experience.
- **`daysPerWeek`** (1–7, optional) and **`maxSessionMinutes`** (optional) — the weekly
  availability the plan must respect.
- **`sports[]`** (optional) — what they train / like to do.
- **`equipment[]`** (optional) — what they have access to.
- **`currentWeightKg`** / **`targetWeightKg`** (kg, optional) — only if the user gives
  them (carry the not-medical-advice framing on any target).
- **`notes`** (freeform, optional) — anything else the coach should know (injuries to work
  around, schedule constraints, preferences).

Gather what's **missing** conversationally before writing — *"to build you a good plan I
need your goal, your level, how many days a week you can train, and your max session
length"*. Infer what the message already states (*"intermediate runner, 5 days a week, 90
min"* gives you `level`, `daysPerWeek`, `maxSessionMinutes`, and a sport).

### 3. VALIDATE against the allowed vocabularies (bind to these verbatim)

The board rejects anything outside these English enums and **silently drops** unknown
`sports` / `equipment` strings (the route filters them out) — so map free-text onto the
allowed values yourself, and **ask if ambiguous** rather than guessing.

- **`goal`** ∈ **`VALID_ATHLETE_GOAL`** =
  `["weight_loss", "sprint_triathlon", "olympic_triathlon", "cycling", "swimming", "running", "general_fitness"]`.
- **`level`** ∈ **`VALID_ATHLETE_LEVEL`** = `["beginner", "intermediate", "advanced"]`.
- **`sports[]`** ⊆ **`VALID_ATHLETE_SPORT`** =
  `["cycling_outdoor", "cycling_indoor", "running", "walking", "swimming_pool", "swimming_open_water", "rowing", "skiing_alpine", "skiing_cross_country", "snowboard", "hiking", "climbing", "surfing", "kayaking", "strength_training", "hiit", "yoga", "pilates", "dance", "martial_arts", "boxing", "crossfit", "stretching", "tennis", "padel", "soccer", "basketball", "cycling_indoor_zwift"]`.
- **`equipment[]`** ⊆ **`VALID_ATHLETE_EQUIPMENT`** =
  `["road_bike", "home_trainer", "pull_up_bar", "dumbbells", "kettlebell", "resistance_bands", "treadmill", "rowing_machine", "elliptical", "jump_rope", "bodyweight", "pool_access", "gym_access"]`.

**Map free-text onto the vocabularies**, e.g.: *"I have a bike and a pool"* →
equipment `road_bike` + `pool_access`, sports `cycling_outdoor` + `swimming_pool`; *"I
swim in the lake"* → `swimming_open_water`; *"I lift / do weights"* → sport
`strength_training`, equipment `dumbbells`/`gym_access` as stated; *"I have a Peloton /
Zwift"* → `cycling_indoor` (`cycling_indoor_zwift`) + `home_trainer`. When the mapping is
genuinely ambiguous (*"I do classes"* — which?), **ask** rather than pick.

### 4. WRITE — `set_athlete_profile` (create-or-REPLACE)

Call **`set_athlete_profile { goal, goalDate?, level, currentWeightKg?, targetWeightKg?, daysPerWeek?, maxSessionMinutes?, sports[], equipment[], notes? }`**.

> **It REPLACES the whole record** — so send the **merged** profile: the field(s) the user
> is changing **plus** every field you read back in step 1 that they're keeping. Dropping a
> field you didn't restate **erases** it. (`createdAt` is sticky and preserved by the
> board; you never send it.) The board stamps `updatedAt` and returns the saved
> `{ profile, version }`.

`goal` and `level` are **required** — the board 400s without a valid pair. Optional numeric
fields the board coerces: `daysPerWeek` is rounded into 1–7, `maxSessionMinutes` /
`currentWeightKg` / `targetWeightKg` must be positive (else stored as `null`); `goalDate`
must be `YYYY-MM-DD` or `""`; `notes` is capped at 2000 chars; out-of-vocab `sports` /
`equipment` entries are filtered out. Validate your JSON against this before sending — the
board rejects a malformed body, it does not repair it.

### 5. CONFIRM — tell the user it's saved

Report the saved profile back (goal, level, availability, sports, equipment, dates/weights)
and that it's **visible on the `/fitness` overview**. Then note that the **coaching skills
now use it** — the training plan, the pre-workout brief, and the weekly review (all in
`fitness-coach`) read this profile to personalise their output — and offer the natural next
step (*"want me to build you a training plan for the week?"*).

---

> **Example.** *"I'm an intermediate runner training for an Olympic triathlon in September,
> 5 days a week, 90 min max, I've got a bike, a pool, and a gym."* (auto mode):
> `get_athlete_profile` → none set. Map: goal `olympic_triathlon`, level `intermediate`,
> goalDate the Sept date (`YYYY-MM-DD`), daysPerWeek 5, maxSessionMinutes 90, sports
> `running` + `cycling_outdoor` + `swimming_pool`, equipment `road_bike` + `pool_access` +
> `gym_access`. → `set_athlete_profile { goal: "olympic_triathlon", goalDate: "2026-09-12",
> level: "intermediate", daysPerWeek: 5, maxSessionMinutes: 90, sports: ["running",
> "cycling_outdoor", "swimming_pool"], equipment: ["road_bike", "pool_access",
> "gym_access"] }`. Confirm it's saved + on `/fitness`, then offer a training plan.

> **Example (update one field, MERGE).** *"actually I can only do 4 days a week now."*:
> `get_athlete_profile` → read the existing record, change `daysPerWeek` to 4, **re-send
> every other field unchanged** (goal, level, sports, equipment, goalDate, weights, notes),
> `set_athlete_profile` the whole merged object. Confirm the new availability; the rest is
> preserved.

---

## Conventions (guardrails recap)

- **`fitness` MCP only, via `get_athlete_profile` / `set_athlete_profile`.** Never
  `bash`/`curl`. The `/fitness` overview is the read twin; you do the gathering + the write.
- **Singleton, create-or-REPLACE.** One profile per board. `set_athlete_profile` overwrites
  the whole record (`createdAt` sticky) — **always `get_athlete_profile` first and merge**,
  never send a partial that drops the fields the user is keeping.
- **The add-on must be ENABLED for the write.** A disabled add-on 404s `set_athlete_profile`
  ("Not found — the fitness add-on may be disabled.") while the read stays open — tell the
  user to flip it on at **/addons**; you don't enable it yourself.
- **English vocabularies, validated.** `goal` ∈ `VALID_ATHLETE_GOAL`, `level` ∈
  `VALID_ATHLETE_LEVEL`, `sports` ⊆ `VALID_ATHLETE_SPORT`, `equipment` ⊆
  `VALID_ATHLETE_EQUIPMENT` (verbatim above). Map free-text onto them; **ask when
  ambiguous** — out-of-vocab sports/equipment are silently dropped by the board.
- **Mode (STEP 0):** auto → just do it; approval → confirm a **wholesale replace** of an
  existing profile in chat first. A first set or an echoed single-field tweak is low-stakes
  either way. **There is no pending/propose queue** — confirmation is conversational.
- **NOT MEDICAL ADVICE.** A `weight_loss` goal / any weight target is informational, not
  medical advice — **say so**, don't prescribe a number or rate, and defer medical
  conditions, pregnancy/breastfeeding, eating-disorder history, or an under-18 user to a
  clinician or registered dietitian. The diet math lives in the Nutrition add-on
  (`/nutrition-chef`).
- **Report** the saved profile (goal, level, availability, sports, equipment, dates/weights)
  + that it's on `/fitness`, then note the coaching skills (`fitness-coach`) now use it and
  offer the next step (a training plan).
