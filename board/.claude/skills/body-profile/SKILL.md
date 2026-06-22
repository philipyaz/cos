---
name: body-profile
description: >
  Manage the BODY add-on — the single owner of your body identity, your weight + body-composition
  history, and your GOAL. It drives the `body` MCP: set/read your FREE-TEXT objective (describe what
  you're after in your own words — fat loss, muscle gain, recomposition, maintenance — plus an optional
  target weight) via set_body_objective / get_body_objective; set/read your identity (sex, date of
  birth, height, training status, whether you lift) via set_body_profile / get_body_profile; log
  weigh-ins + body composition (weight, body-fat %, lean mass, waist) via log_weight / list_weights;
  and read the deterministic physiology facts (age, BMR, maintenance TDEE, BMI, fat-free mass, trend)
  via get_body_status. The goal is PROSE, not a pick-list. Use when the user says "set my goal", "I
  want to build muscle / lose fat / recomp / maintain", "I'm 178 cm", "I was born in 1991", "log my
  weight", "I'm 18% body fat", "my waist is 84 cm", "what's my BMR / maintenance / body status", or
  otherwise asks to define their body goal, identity, or weight. Not medical advice.
---

# Body (the shared body space)

This skill owns the **body** add-on — the foundational space that **Nutrition & Chef** and **Fitness**
both read. It holds three things: your **identity** (`db.bodyProfile` — sex, date of birth, height,
training status, whether you lift), your **weight + body-composition series** (`db.weights` — weigh-ins
with optional body-fat % / lean mass / waist), and your **objective** (`db.bodyObjective` — a
**free-text** goal + an optional target weight). It writes **only** through the **`body`** MCP — never
`bash`/`curl`. The **/body** page is the read twin.

> **The goal is FREE TEXT — never a pick-list.** Write the user's objective **in their own words** in
> `goalText` (*"lose some fat but keep my strength"*, *"lean recomposition — drop body fat, hold ~80
> kg"*, *"build muscle, I lift 4×/week"*). The only structured anchor is a **target weight** (optional —
> recomp/maintenance legitimately have none). Do **not** force the goal into "lose / gain / maintain"
> categories; capture what they said.

> **This skill owns the goal/identity/weight — NOT the targets.** It does not compute calorie or macro
> targets. Those are **authored by the Nutrition chef** (`nutrition-chef` skill → `save_nutrition_targets`),
> which reads your goal here + the physiology facts (`get_body_status`) + your dietary profile
> (`get_diet_profile`). So: set the goal/identity/weight here; ask the chef *"what's my calorie target?"*
> there. The Fitness coach likewise reads your training status + weight + goal cross-add-on.

> **Gate — usually already on.** Writes are add-on-gated (a disabled add-on 404s, surfaced as "Not
> found."). But **body HARD auto-enables** whenever Nutrition or Fitness is enabled, so it is on in
> practice. If a write 404s with everything else off, enable it at the board's **/addons** catalog.

> **NOT MEDICAL ADVICE.** Body status (BMR, maintenance, BMI, fat-free mass) is an **informational
> estimate**, not medical guidance. Record what the user states; don't prescribe a weight or rate; defer
> medical conditions, pregnancy/breastfeeding, an eating-disorder history, or a user under 18 to a
> clinician or registered dietitian.

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if missing). State the
mode once. A single write (one `set_body_objective`, one `log_weight`, one `set_body_profile`) is
**low-stakes — just do it** in either mode. In approval mode, confirm a **bulk/wholesale** change in
chat first. All reads (`get_body_objective`, `get_body_profile`, `get_body_status`, `list_weights`)
need no confirmation.

---

## JOB 1 — The objective (the free-text goal + the target anchor)

`get_body_objective` / `set_body_objective`. The objective is a **singleton** (one per board);
`set_body_objective` **replaces** it (`createdAt` is sticky).

- **`goalText`** — the goal in the user's OWN words (prose). May be empty, but capture what they said.
- **`targetWeightKg`** — the one structured anchor: a number, or omit/`null` when there's no scale
  target (recomp / maintenance / "just eat better"). Honor their unit (the body profile's `weightUnit`)
  but the field is **kilograms**.
- **`targetDate`** — optional `YYYY-MM-DD` deadline, or `null`.
- **`activity`** *(required)* — the TDEE multiplier: `sedentary | light | moderate | very_active |
  extra_active`. Default to **`moderate`** if unknown.

**Read it back** with `get_body_objective`. To tweak it, re-`set` the whole thing (re-state the
unchanged fields). A single objective write is low-stakes — do it directly, then confirm and offer to
ask the chef for daily targets.

> **Example.** *"I want to lose a bit of fat but keep my strength — get to about 78 kg."* (auto): →
> `set_body_objective { goalText: "Lose some fat but keep my strength.", targetWeightKg: 78, activity:
> "moderate" }`. Confirm, then offer: *"want me to set your daily calorie + macro targets?"* (that's the
> `nutrition-chef` skill).

---

## JOB 2 — Identity (the BMR inputs)

`get_body_profile` / `set_body_profile`. A **singleton**; create-or-replace. Required:

- **`sex`** (`male | female`) — the Mifflin-St Jeor sex constant.
- **`dateOfBirth`** (`YYYY-MM-DD`) — store the **DOB**, not an age; age is derived fresh at read time.
- **`heightCm`** — BMR + BMI input.
- **`trainingStatus`** (`novice | intermediate | advanced`) — resistance-training experience (this is
  the deduped successor to the old fitness "level"; the coach reads it from here).
- **`resistanceTrains`** (boolean) — does the user lift at all? (gates whether muscle-gain / recomp is
  realistic — nutrition is permissive, training is causal).
- **`weightUnit`** (`kg | lb`, optional) — display/entry preference; storage stays kg.

Gather what's missing conversationally before writing. A single profile write is low-stakes.

> **Example.** *"I'm a 34-year-old man, 180 cm, I lift 3×/week, intermediate."* (auto): convert the age
> to a DOB (*"so born around 1992?"* — confirm if it matters) → `set_body_profile { sex: "male",
> dateOfBirth: "1992-01-01", heightCm: 180, trainingStatus: "intermediate", resistanceTrains: true }`.

---

## JOB 3 — Weigh-ins + body composition

`log_weight` (UPSERT BY DAY) / `list_weights` / `delete_weight`. One entry per `date` — re-logging a day
**updates** it.

- **`date`** (`YYYY-MM-DD`, default today). Pass **exactly one** of **`weightKg`** or **`weightLb`**
  (pounds → kg server-side). Honor the user's unit.
- Optional body composition: **`bodyFatPct`** (3–60), **`leanMassKg`** (from a DXA / smart scale),
  **`waistCm`** (the scale-independent recomp signal). Log these when the user gives them — they power
  the chef's FFM-anchored protein + recomp tracking.
- Optional **`note`**. A single weigh-in is low-stakes — log it, then report the new trend from
  `get_body_status`.

`list_weights(from?, to?)` renders the series (newest last) with the trend.

> **Example.** *"I weighed 79.4 this morning, 18% body fat, waist 84."* (auto): → `log_weight { date:
> "2026-06-22", weightKg: 79.4, bodyFatPct: 18, waistCm: 84 }`. Report it + the trend.

---

## JOB 4 — Read the physiology facts (`get_body_status`)

`get_body_status` returns the deterministic **FACTS** — derived **age**, current + EWMA-trend weight,
**BMR** (Mifflin-St Jeor), estimated + measured **TDEE** (and which basis is in use), **BMI**, **fat-free
mass**, latest **waist**. It is **NOT** a recommendation — there is no calorie/macro target here. Use it
to answer *"what's my maintenance / BMR / BMI / body status?"*, and remind the user that the daily
**targets** come from the **`nutrition-chef`** skill (which reads these facts + the goal + the dietary
profile and authors the numbers). Carry the not-medical-advice framing.

---

## Conventions (guardrails recap)

- **`body` MCP only, via the tools.** Never `bash`/`curl`. The **/body** page is the read twin.
- **The goal is FREE TEXT** (`goalText`) + an optional target weight — never a pick-list. Capture the
  user's own words.
- **Singletons, create-or-REPLACE** (objective + profile) — read first, re-state the kept fields, write
  the merged whole. Weigh-ins **upsert by day**.
- **This skill sets the goal/identity/weight; it does NOT compute targets.** The daily calorie/macro
  targets are authored by **`nutrition-chef`** (`save_nutrition_targets`), reading your goal +
  `get_body_status` + `get_diet_profile`. Hand off there for *"what should I eat?"*.
- **Gate:** writes are add-on-gated, but body **hard auto-enables** under Nutrition/Fitness, so it is
  usually on. A lone 404 → enable it at **/addons**.
- **NOT MEDICAL ADVICE.** Record what's stated; defer medical conditions, pregnancy/breastfeeding,
  eating-disorder history, or an under-18 user to a clinician/dietitian.
- **Report** what you wrote (the goal/profile fields, the `WEIGHT-id` + trend) and offer the natural next
  step (ask the chef for targets; ask the coach for a plan).
