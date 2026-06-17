---
name: fitness-weekly-review
description: >
  Generate and persist the WEEKLY REVIEW — the look-BACK over a training week
  on the Cos board via the `fitness` MCP. A focused sub-skill of fitness-coach:
  it FETCHES the week's health (summary + trends: sleep, HRV, resting HR, steps,
  workouts), the workouts actually done, the week's training plan (to compare
  planned vs done), and the daily form scores across the week, then YOU (the
  agent) author the review — an overall 0–100 score, a prose summary, and
  structured training / sleep / recovery / nutrition blocks with 3–5
  recommendations and a next-week focus — and PERSIST it via `save_weekly_review`
  (upserted by ISO week). It lands on the `/fitness/weekly-review` history feed.
  Always with not-medical-advice framing. Use when the user says "how was my
  training this week", "weekly review", "review my week", "how did my week go",
  "recap my training week", or otherwise asks to look back on the week's training.
---

# Fitness — Weekly Review (the look-back operator)

This is the **weekly-review** sub-skill of **fitness-coach** — read that skill for the
shared philosophy, the canonical health taxonomy, the enable-gate, and the
`FITNESS_PUSH_TOKEN` rules. Here you do **one** thing: turn *"how was my training this
week?"* into a **persisted `weekly_review` artifact** on the board.

**The board is a state machine; YOU are the coach.** There is **no board-side LLM** — the
board never generates the review. It computes the deterministic numbers (the **form score**
is a board compute you *read*, you do not recompute it), validates + versions + stores your
JSON, and serves it on the `/fitness/weekly-review` history feed (latest-by-default,
page-back, upserted by ISO week). You FETCH the inputs via the `fitness` MCP, **synthesise
the review yourself**, and `save_weekly_review` it. `x-fitness-token` is the only credential
— **no board Anthropic key is involved**.

> **Gate + token (same as fitness-coach).** `save_weekly_review` is a **gated write** — it
> 404s ("Not found — the fitness add-on may be disabled.") when the Fitness add-on is off;
> tell the user to enable it at **/addons** and retry (you don't enable it yourself). A
> **401** (Unauthorized) is a `FITNESS_PUSH_TOKEN` setup issue (`/fitness-mcp-setup`), not a
> retry. All the FETCH reads below are **ungated** — read freely.

> **NOT MEDICAL ADVICE.** A weekly review is an **informational estimate**, not medical
> advice — carry that framing whenever you read recovery, load, or sleep. **Defer to a
> professional** for any injury, pain, illness, abnormal symptom, pregnancy, or an under-18
> user; a "back off / recover" read on low HRV or poor sleep is a conservative default, not
> clinical judgement.

---

## The ISO week + its bounds

The review is keyed on the **ISO week** (e.g. `2026-W25`) — re-saving the same week
**upserts** in place (no duplicate). Resolve the week from the user's intent ("this week"
= the current ISO week; "last week" = the prior one) and compute its bounds: **Monday**
(inclusive) to the **next Monday** (exclusive, half-open) so every FETCH covers exactly that
week. Use those as `from` / `to` throughout.

---

## PROCEDURE — FETCH → GENERATE → PERSIST

### 1. FETCH the week's health (the aggregate + the series)

- **`get_health_summary({ from: <Mon>, to: <next Mon> })`** — per-type aggregates for the
  week: `sleep {count, avg_hours, avg_deep_hours, avg_rem_hours}`, `hrv {avg_ms}`,
  `resting_hr {avg_bpm}`, `steps {total, avg_per_day}`, `workout {count,
  total_duration_min, total_calories, activities}`.
- **`get_health_trends({ days: 7 })`** — the daily series + deltas (sleep, HRV, resting HR,
  steps, workouts) so you can read **direction** (improving / flat / declining), not just the
  average — e.g. HRV climbing back across the week vs. a flat low.

### 2. FETCH the workouts actually done

- **`list_health_data({ type: "workout", from: <Mon>, to: <next Mon> })`** — the raw
  sessions: count, per-session `activity` / `duration_min` / `distance_km` / `calories`.
  Aggregate to **sessions done**, **total volume (min)**, **total distance (km)**, and a
  **per-sport breakdown**.

### 3. FETCH plan-vs-actual (planned vs done)

- **`list_coaching_artifacts({ kind: "training_plan" })`** → find **this week's** plan (match
  its `week` to the ISO week; `get_coaching_artifact({ id })` to read the days if needed).
  Compare the plan's prescribed days/sports against what step 2 shows was actually done →
  a concise **`vs_plan`** read (adherence, what was skipped/added). If there's **no** plan for
  the week, say so and review on actuals alone.

### 4. FETCH the form trend (the deterministic readiness number)

- **`get_form_score({ date })`** across the week's days (or **`get_daily_summary({ date })`**
  per day) — the board's deterministic readiness score 0–100. Average it → **`avg_form_score`**
  and read its direction → **`form_trend`** (rising / flat / falling). **The board computes
  this; you only read + average + interpret it — never recompute it.**

### 5. FETCH nutrition (SOFT — don't block on it)

- **`list_food_log({ from: <Mon>, to: <next Mon> })`** (Nutrition add-on) — days logged, avg
  calories. This is a **soft** edge: if Nutrition isn't installed/enabled the log is empty —
  just leave the `nutrition` block thin (or omit it); the review is **not** broken because
  food data is missing. Point the user at `/nutrition-chef` if they want it.

### 6. GENERATE the review (this is YOUR judgement)

Synthesise — don't dump the numbers — into the `save_weekly_review` payload:

- **`overall_score`** (0–100) — your weighted read across **training** (volume + adherence to
  plan), **sleep** (duration + quality trend), **recovery** (HRV / resting HR / form), and
  **nutrition** (if logged). One honest number for the week.
- **`summary`** — a short prose paragraph: how the week went, the headline win, the headline
  drag.
- **`training`** — `{ sessions_done, total_volume_min, total_distance_km, sports_breakdown,
  vs_plan, highlights }` (from steps 2–3).
- **`sleep`** — `{ avg_duration_h, avg_deep_h, avg_rem_h, quality_trend, notes }` (from step 1).
- **`recovery`** — `{ avg_hrv, avg_resting_hr, fatigue_level, notes }` (from steps 1 + 4 —
  let the form trend inform `fatigue_level`).
- **`nutrition`** (optional) — `{ days_logged, avg_calories, notes }` (from step 5; omit if no
  log).
- **`recommendations[]`** — **3–5** concrete, profile-aware next steps.
- **`next_week_focus`** — the one thing to prioritise next week.
- **`avg_form_score`** + **`form_trend`** (optional) — from step 4.

Respect the athlete profile's constraints (goal, level, days available) when you advise —
read it via `get_athlete_profile({})` if you need it; if there's **no** profile, the review
is weaker — note it and suggest setting one (the **fitness-athlete-profile** skill / the
`/fitness` page). **Validate your own JSON** against this shape before saving — the board
rejects a malformed body, it does not repair it. English vocabulary only.

### 7. PERSIST

```
save_weekly_review({
  week: "<this ISO week, e.g. 2026-W25>",
  overall_score, summary,
  training:   { sessions_done, total_volume_min, total_distance_km, sports_breakdown, vs_plan, highlights },
  sleep:      { avg_duration_h, avg_deep_h, avg_rem_h, quality_trend, notes },
  recovery:   { avg_hrv, avg_resting_hr, fatigue_level, notes },
  nutrition:  { days_logged, avg_calories, notes },   // optional
  recommendations: [ … 3–5 … ],
  next_week_focus,
  avg_form_score,   // optional
  form_trend        // optional
})
```

Upserts by `week` — regenerating the same week **replaces** the prior review, no duplicate.

### 8. Tell the user

Report the **`overall_score`**, the one-line summary, and the **next_week_focus**; note it's
**not medical advice**. Tell them it's now on the **`/fitness/weekly-review`** history feed
(latest-by-default, page-back). Optionally offer to run **fitness-training-plan** to build
next week's plan off this review.

---

## Guardrails (recap)

- **`fitness` MCP only, via the tools** — never `bash`/`curl` for health data.
- **The board does NOT generate — YOU do.** No board-side LLM, no "click Generate" — you
  author the review and `save_weekly_review` it. The deterministic **form score** is the one
  number the board computes; you **read + average + interpret** it, never recompute.
- **Gate + token.** A **404** = add-on disabled (enable at **/addons**, then retry); a **401**
  = `FITNESS_PUSH_TOKEN` setup issue (`/fitness-mcp-setup`). Reads are ungated.
- **Upsert by ISO week** — re-saving the same week replaces it.
- **Profile-aware + English enums only;** respect days available / level / goal. No profile →
  weaker review; note it and point at **fitness-athlete-profile**.
- **Nutrition is a SOFT dep** — empty food log → thin `nutrition` block, not a fault.
- **NOT MEDICAL ADVICE** — informational estimate; defer injuries / pain / illness / abnormal
  symptoms / pregnancy / under-18 to a physician / physiotherapist / qualified coach.
