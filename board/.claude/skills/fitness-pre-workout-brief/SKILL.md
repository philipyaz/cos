---
name: fitness-pre-workout-brief
description: >
  Prepare and persist TODAY'S pre-workout / training-readiness brief — the daily
  "should I train today?" call. It reads the board's deterministic FORM SCORE (0–100,
  with its hrv / sleep / resting-HR / load breakdown), folds in last night's sleep +
  this morning's metrics + recent training load + the athlete profile + today's PLANNED
  session, then YOU author a short brief — readiness (ready / caution / rest), the
  recommended session (the plan, adjusted to recovery), the warnings, the green lights,
  and a one-liner — and `save_pre_workout_brief` it (upserted by today's date). Always
  with not-medical-advice framing. Use when the user says "should I train today", "am I
  ready to train", "am I recovered", "pre-workout brief", "training brief", "what should
  I do today", "what's on for today", "how's my readiness", or otherwise asks whether to
  train, go easier, or rest. It does NOT make the weekly plan (fitness-training-plan owns
  that) — it reads today's recovery and the planned session and gives the go / hold-back call.
---

# Pre-workout brief (today's go / hold-back call)

This skill is the **intelligence** that turns *"should I train today?"* into a persisted
**pre-workout brief** on the board. It runs **only** through the **`fitness`** MCP — never
`bash`/`curl` (Cowork's sandbox blocks outbound HTTP; the tools exist for exactly this).
`/fitness/pre-workout-brief` is the **read** twin: a history feed (latest-by-default,
page-back) over the saved briefs; the human glances at it, **you** author and persist the
brief.

**The board is a state machine; YOU are the intelligence.** There is **no board-side LLM** —
the page's Generate action hands off to **you**, not to a server-side coach. The one number
you do **not** invent is the **form score**: the board **computes it deterministically**
(`get_form_score`) and you **read + interpret** it — you never recompute it. Everything else
(the readiness call, the session adjustment, the warnings, the green lights, the one-liner)
is **your** judgement, then you `save_pre_workout_brief` it.

> **Scope.** This skill is the **daily** brief only. The **weekly training plan**
> (`fitness-training-plan`), the **weekly review** (`fitness-weekly-review`), the
> **profile** (`fitness-athlete-profile`), and **correlations** (`fitness-correlations`)
> are their own focused skills — defer there for *"make me a plan for the week"*, *"how was
> my training this week"*, *"set my profile"*. Here you read today's recovery + the day's
> planned session and give the **go / easier / rest** call.

> **Gate — the add-on must be ENABLED.** The WRITE (`save_pre_workout_brief`) 404s ("Not
> found — the fitness add-on may be disabled.") when the Fitness add-on is disabled; the
> READS (`get_form_score`, `get_daily_summary`, `list_health_data`, `get_athlete_profile`,
> `list_coaching_artifacts`) always work. If the save comes back **404**, the add-on is off —
> tell the user to enable it from the board's **/addons** catalog (toggle on), then retry.
> You don't enable the add-on yourself.

> **NOT MEDICAL ADVICE — say it.** A brief is an **informational estimate, not medical
> advice.** A "go easy / rest" read on low HRV or poor sleep is a **conservative training
> default**, not clinical judgement. **Defer to a professional** (physician,
> physiotherapist, qualified coach) for any injury, pain, illness, chest pain or abnormal
> symptom, pregnancy, or a user under 18 — recommend they consult one and **don't** push hard
> training. Carry that framing in your own words.

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if the file
or key is missing). State the mode once. A pre-workout brief is **one low-stakes write**
(`save_pre_workout_brief`, upserted by today's date — re-saving the same day overwrites, it
does not stack) — so **just do it in either mode**. The conversational check that
`fitness-coach` applies to bulk/destructive writes does not apply here; there's nothing bulk
about a single day's brief. **There is no pending/propose queue** — the save lands directly.

---

## STEP 1 — Make sure today's overnight data is ingested

The brief leans on **last night's sleep** and **this morning's HRV / resting HR** — that's
exactly the recovery signal. If the user just mentioned numbers that aren't on the board yet
(*"slept badly, HRV was 41"*), ingest them first via `fitness-health-data`
(`push_health_data`, canonical taxonomy) — a brief built on stale data is misleading. If
today's data is already in (the HAE shortcut usually posts it), proceed.

---

## PROCEDURE — FETCH → GENERATE → PERSIST

`<today>` is today's date as `YYYY-MM-DD` unless the user names another day.

### 1. FETCH today's readiness — the form score (the deterministic anchor)

`get_form_score({ date: <today> })` → `{ date, score (0–100), level, color,
breakdown: { hrv, sleep, resting_hr, load }, recommendation }`. The board computed this —
**read it, do not recompute it.** Note the **`score`** (you'll persist it verbatim), the
sub-scores in **`breakdown`** (each 0–100, 50 = neutral / no data — they tell you *why* the
score is what it is), the **`level`** (`good` ≥75 / `moderate` ≥50 / `low` ≥30 /
`insufficient` <30), and the board's own **`recommendation`** string. If a breakdown
sub-score is ~50, that signal is **missing** (e.g. no HRV logged) — say the brief is built on
partial data, don't read a flat 50 as "average recovery".

### 2. FETCH the context (three reads)

- **`get_daily_summary({ date: <today> })`** — last night's sleep (hours + stages), this
  morning's metrics (HRV, resting HR, steps), and (soft-dep) the day's nutrition + calorie
  balance. This is the human-readable colour behind the score.
- **`list_health_data({ type: "workout", from: <48h ago ISO>, to: <today end> })`** — recent
  training **load**: did they already do a hard/long session in the last day or two? Back-to-
  back hard days is a warning even when the score is decent.
- **`get_athlete_profile({})`** — the training FOCUS (goal=sport/event), days/week, **sports[]**,
  equipment, max session minutes. The recommended session must respect these (a fallback session
  comes from `sports[]`). **If it returns no profile**, tell the user to set it first (point at the
  `fitness-athlete-profile` skill / the **/fitness** page) — a brief without a focus is weak — but
  you can still give a recovery-only read from the score.
- **`get_body_profile({})` + `get_body_status({})`** (body MCP) — the **trainingStatus**
  (novice|intermediate|advanced — how hard to push) and current **weight**; the body goal (fat loss
  vs build vs maintain) from **`get_body_objective({})`**'s free-text `goalText`. These moved off the
  athlete profile in v14 — read them here when the session call depends on the body goal / experience.

### 3. FETCH today's PLANNED session

`list_coaching_artifacts({ kind: "training_plan", limit: 1 })` → the latest plan; in its
`days[]` find the entry whose date is **`<today>`** (plans key by ISO week, days carry a
date). That planned session is what the brief **confirms or adjusts**. If there's no plan, or
no entry for today, fall back to a sensible session from the profile's `sports[]` (or a rest
day if recovery is poor) and say there was no planned session.

### 4. GENERATE the brief (your judgement)

Compose the artifact from what you read. Map **readiness** off the form score **and** the
sleep signal (the board's `recommendation` is your steer):

- **`ready`** — score **≥ 70** and good sleep (and no fresh hard-load / warning). Train as
  planned.
- **`caution`** — score **40–70**, or average/short sleep, or a notable warning. Train, but
  **easier** — drop intensity/duration, swap a hard session for an easy/aerobic one.
- **`rest`** — score **< 40**, or poor sleep, or a clear over-reach signal. Recovery day —
  rest, mobility, or a very easy flush.

Then build the rest:

- **`recommended_session`** — `{ sport, duration_min, intensity, description }`. Start from
  **today's planned session** (STEP 3) and **adjust it to recovery**: `ready` → keep it;
  `caution` → reduce intensity/volume (e.g. tempo → steady, 90 → 60 min); `rest` → a recovery
  option (easy spin / walk / mobility / yoga) or an explicit rest. `sport` must come from the
  profile's **`sports[]`** (or the plan); respect `maxSessionMinutes`. Use a clear `intensity`
  word (`recovery` / `easy` / `steady` / `moderate` / `hard`).
- **`warnings[]`** — the negative signals: short/poor sleep (call the hours), low HRV vs
  baseline, elevated resting HR, **high recent load** (back-to-back hard days from STEP 2),
  low overall score, missing data. Empty array if none.
- **`green_lights[]`** — the positives: good/long sleep, HRV at/above baseline, resting HR at
  baseline, fresh legs (rest yesterday), a strong score. Empty array if none.
- **`one_liner`** — one short, plain-language motivating-or-cautionary line (e.g. *"Green
  light — legs are fresh, hit the planned tempo."* / *"Amber — sleep was short, keep it easy
  and aerobic today."* / *"Recovery day — HRV's down and you trained hard yesterday; rest and
  come back stronger."*).

### 5. PERSIST — `save_pre_workout_brief`

```
save_pre_workout_brief({
  date: <today>,                       // YYYY-MM-DD — UPSERT key (re-saving today overwrites)
  readiness: "ready" | "caution" | "rest",
  form_score: <the score from get_form_score>,   // verbatim — do NOT recompute
  recommended_session: { sport, duration_min, intensity, description },
  warnings: [ ... ],
  green_lights: [ ... ],
  one_liner: "..."
})
```

`readiness` **must** be exactly one of `ready | caution | rest` (the board rejects anything
else — it does not repair a malformed body). `form_score` is the number you read from
`get_form_score` — passing your own recomputation is a bug. Validate your own JSON before
sending.

### 6. TELL the user

Report the call in plain language: the **readiness** + the **form score** (and the one or two
breakdown signals that drove it), the **recommended session** (and how you adjusted it off
the plan), the top **warnings** / **green lights**, and the **one-liner**. **Carry the
not-medical-advice framing** — a "go easy / rest" read is a conservative default, and any
pain / illness / abnormal symptom means **stop and consult a professional**, not push
through. Note that the brief is saved and visible on the **/fitness/pre-workout-brief** feed
(latest-by-default; re-saving today updates it in place).

---

## Worked example

*"Should I train today?"* (auto mode), today = `2026-06-17`:

1. `get_form_score({ date: "2026-06-17" })` → `{ score: 48, level: "moderate", breakdown:
   { hrv: 44, sleep: 38, resting_hr: 55, load: 60 }, recommendation: "Insufficient sleep.
   Favor a light session or rest." }`.
2. `get_daily_summary({ date: "2026-06-17" })` → slept 5h40 (short), HRV 41 (below baseline);
   `list_health_data({ type: "workout", from: "2026-06-15T00:00:00Z", to: "2026-06-17T23:59:59Z" })`
   → a hard 75-min ride yesterday; `get_athlete_profile({})` → focus olympic_triathlon,
   sports running/cycling/swimming, max 90 min; `get_body_profile({})` → trainingStatus intermediate.
3. `list_coaching_artifacts({ kind: "training_plan", limit: 1 })` → today's planned day = a
   60-min tempo run.
4. GENERATE → **readiness `caution`** (score 48, sleep sub-score 38 = poor, hard ride
   yesterday). recommended_session = swap the tempo for **`{ sport: "running", duration_min:
   40, intensity: "easy", description: "Easy aerobic run, zone 2 — skip the tempo today" }`**.
   warnings = `["Short sleep (5h40)", "HRV 41 below baseline", "Hard 75-min ride yesterday"]`.
   green_lights = `["Decent recent training load — no overtraining"]`. one_liner = *"Amber —
   sleep was short and HRV's down, so keep it easy and aerobic; save the tempo for tomorrow."*
5. `save_pre_workout_brief({ date: "2026-06-17", readiness: "caution", form_score: 48,
   recommended_session: {…}, warnings: [...], green_lights: [...], one_liner: "..." })`.
6. Tell the user the caution call + the easy-run swap + the not-medical-advice note; point
   them at /fitness/pre-workout-brief.

---

## Conventions (guardrails recap)

- **`fitness` MCP only, via the tools.** Never `bash`/`curl`. The
  **/fitness/pre-workout-brief** page is the read twin (a history feed); you author + persist.
- **Use the board's `form_score` — never recompute it.** `get_form_score` is the
  deterministic anchor; you read + interpret its `score` / `breakdown` / `level` /
  `recommendation` and persist the `score` **verbatim** in `save_pre_workout_brief`.
- **The board does NOT generate — YOU do.** No board-side LLM; the page's Generate hands off
  to you. Never tell the user to "click Generate" — **you** author the brief and `save_*` it.
- **The add-on must be ENABLED for the save.** A disabled add-on 404s the write ("Not found —
  the fitness add-on may be disabled.") while reads stay open — tell the user to flip it on at
  **/addons**; you don't enable it.
- **Mode (STEP 0):** a brief is **one low-stakes write** — just do it in either mode; no
  pending/propose queue, no confirmation needed.
- **Ingest today's overnight data first** (last night's sleep + this morning's HRV /
  resting-HR) — a brief on stale data is misleading.
- **Profile required for a strong brief.** No profile → tell the user to set it first
  (`fitness-athlete-profile` / **/fitness**); you can still give a recovery-only read from the score.
- **`readiness` ∈ `ready | caution | rest`, exactly.** The board rejects anything else and
  does not repair a malformed body — validate your JSON. Upsert key is **today's date** (re-
  saving overwrites).
- **NOT MEDICAL ADVICE.** A brief is an informational estimate — **say so**; a "go easy /
  rest" read is a conservative default; **defer injuries, illness, abnormal symptoms,
  pregnancy, or an under-18 user to a physician / physiotherapist / qualified coach**
  (recommend they consult one; don't push hard training).
- **Report** the readiness + form score + driving signals, the (adjusted) recommended
  session, the warnings / green lights, the one-liner — and that it's saved on the
  /fitness/pre-workout-brief feed.
