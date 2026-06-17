---
name: fitness-correlations
description: >
  Surface and INTERPRET the sleep ↔ performance CORRELATIONS the board
  computes from the logged Apple-Watch + workout data — the deterministic stats
  twin of the Fitness add-on. The board computes (and persists) the Pearson r and
  the linear regression deterministically; YOU (the agent) trigger that compute via
  the `fitness` MCP and then read the numbers back to the user in plain language —
  strength + direction of the correlation, what the regression slope implies, and
  ACTIONABLE training guidance (e.g. "your deep-sleep correlation is strong → protect
  deep sleep before key sessions"), honest about small samples / weak links. You do
  NOT recompute Pearson yourself; the board owns the math. Use when the user says
  "how does my sleep affect my performance", "sleep vs performance", "correlate my
  sleep and training", "what affects my training", "does deep sleep help my workouts",
  "is my sleep linked to my training", "show me my sleep-performance correlation", or
  otherwise asks to relate their sleep to how they train. NOT a causal claim, NOT
  medical advice.
---

# Fitness correlations (the sleep ↔ performance interpreter)

This skill answers *"how does my sleep affect my performance?"* It is the **interpret**
half of a deterministic compute: the **board computes the statistics** (Pearson `r` for
sleep-vs-performance and deep-sleep-vs-performance, plus a linear regression) — **you do
not**. The board is a state machine; **the math is the board's, the meaning is yours.**
There is **no board-side LLM** here either — `get_correlations` runs pure, repeatable stats
and **persists the snapshot**; your job is to **trigger** that compute via the `fitness` MCP,
then **read the numbers back to the user in plain language** with actionable guidance. The
health-data plumbing runs **only** through the **`fitness`** MCP — never `bash`/`curl`.

This skill mostly **READS + interprets**. It does **not** usually write — `get_correlations`
already computes *and persists* the snapshot, so you almost never call `save_correlation_report`
(that writer is for an **externally-computed** dataset the user supplies — see the guardrail).

> **NOT MEDICAL ADVICE — and NOT causation.** A correlation between sleep and performance is
> an **observational association across your logged data, not proof that sleep causes the
> performance change** — say so, in your own words. And it is **informational, not medical
> advice**: defer any injury, illness, abnormal symptom, pregnancy, or an under-18 user to a
> physician / physiotherapist / qualified coach; don't push hard training off a number.

> **Gate + token.** `get_correlations` is a **read/compute** — it works whether or not the
> Fitness add-on is enabled (reads are always open). The persist it does is token-authed via
> the bridge's `x-fitness-token`; if the snapshot doesn't land you may see a `401 / Unauthorized
> — check FITNESS_PUSH_TOKEN` (a setup issue for `/fitness-mcp-setup`, not a retry).

---

## PROCEDURE — compute (board), then interpret (you)

### 1. COMPUTE — `get_correlations({ days })` (the board's deterministic stats)

Call **`get_correlations`** with the window the user asked for:

- **`days`** — `30 | 60 | 90`. **Default `30`** when they don't specify. Use `60` / `90` only
  when they ask for a longer look (*"over the last three months"*).

It returns the board-computed snapshot:

```
{
  correlation: { sleep_vs_performance, deep_sleep_vs_performance },   // Pearson r, each in [-1, 1]
  regression:  { slope, intercept },                                  // linear fit
  points:      [ … ],                                                 // the (sleep, performance) pairs
  data_points,                                                        // n — the sample size (matters!)
  from, to                                                            // the window
}
```

**The board computes AND persists this snapshot** in one call (upserted by `"<from>_<to>"`) —
so the act of asking already lands it on the `/fitness/correlations` feed. You do **not**
recompute Pearson, the slope, or the intercept yourself — read them off the result.

### 2. (optional) HISTORY — compare against a prior window

If the user wants to know whether the relationship is **changing**, call
**`list_coaching_artifacts({ kind: "correlations" })`** to pull prior snapshots, and
**`get_coaching_artifact({ id })`** to open one — then contrast the older `r` / slope against
the fresh one. Skip this for a plain one-shot *"how does my sleep affect my performance"*.

### 3. INTERPRET — read the numbers back in plain language

This is the skill's real work. Translate the stats:

- **The Pearson `r` values — strength + direction.** Describe each `r` in words, not jargon:
  sign = direction (positive → more/better sleep tracks **better** performance; negative →
  the inverse), magnitude = strength. A rough plain-language ladder: **|r| < 0.2** negligible,
  **0.2–0.4** weak, **0.4–0.6** moderate, **0.6–0.8** strong, **> 0.8** very strong. Give
  **both** `sleep_vs_performance` and `deep_sleep_vs_performance`, and call out which is
  stronger (often deep sleep is the more telling signal).
- **The `n = data_points` caveat — always.** State the sample size and **temper the claim to
  match it.** A handful of points (say `n < ~8`) means *"too few sessions to read much into
  yet — keep logging"*; a weak `r` on a small `n` is **noise**, not a finding. Be honest.
- **The regression — what the slope implies.** `slope` is the modelled change in performance
  per **unit of sleep** (hour). Translate it concretely — *"the fit suggests roughly +X
  performance per extra hour of sleep"* — but anchor it to the `r` (a slope off a weak/`negligible`
  correlation is **not** reliable; say so rather than over-reading it).
- **ACTIONABLE guidance.** Turn the read into a training lever. *Strong positive deep-sleep
  correlation* → *"protect deep sleep before your key/hard sessions — it's tracking with your
  better output."* *Weak / negligible* → *"no clear sleep-performance link in this window — don't
  over-optimise sleep for performance on this evidence; keep logging."* Tie it to the profile's
  goal where you can.

### 4. CLOSE — note the snapshot, repeat the caveats

Tell the user the snapshot was **saved** and is visible on the **`/fitness/correlations`**
feed (latest-by-default, page-back). Reiterate: this is an **observational correlation, not a
causal claim**, and **not medical advice**.

---

## The one WRITE exception — `save_correlation_report`

You **almost never** call `save_correlation_report`, because **`get_correlations` already
persists** the snapshot it computes. Reach for it **only** when the user **supplies an
externally-computed dataset** (their own numbers, a different tool's output) that you want to
land on the feed — then `save_correlation_report({ from, to, days, data_points, correlation,
regression, points })` with **their** figures (you are persisting their math, still not
inventing your own Pearson). This is a **gated, token-authed write** — it 404s if the add-on is
disabled (tell the user to enable it at **/addons**) and 401s on a bad token (`/fitness-mcp-setup`).

---

## Guardrails (recap)

- **The board computes; you interpret.** `get_correlations` owns the Pearson `r`, the slope,
  the intercept — **never recompute them yourself**. Your value is the plain-language reading +
  the actionable training guidance, not the arithmetic.
- **`fitness` MCP only** for the data — never `bash`/`curl`. Reads/compute are ungated; the
  persist `get_correlations` does is token-authed.
- **Honour `n = data_points`.** Always state the sample size and **temper** the conclusion to
  it — a weak `r` on a small `n` is noise, not a finding. Don't over-claim.
- **Correlation ≠ causation.** Say it explicitly every time — it's an association across logged
  data, not proof sleep *causes* the performance change.
- **NOT MEDICAL ADVICE.** Informational only; defer injuries, illness, abnormal symptoms,
  pregnancy, or an under-18 user to a clinician. A "protect your sleep" read is a training
  suggestion, not clinical guidance.
- **Default `days: 30`**; use `60` / `90` only when asked for a longer window.
- **Don't write unless the user supplies external numbers.** `get_correlations` already
  persists; `save_correlation_report` is the rare externally-sourced exception only.
- **Report** the two `r` values (with their strength/direction), the `n`, the slope's
  implication, the actionable takeaway — and that the snapshot is saved on `/fitness/correlations`.
