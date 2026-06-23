---
name: fitness-coach
description: >
  The Fitness add-on OVERVIEW / router — the index that fires on GENERIC or
  ambiguous fitness requests and points you at the right FOCUSED skill. Use it
  when the user gestures at fitness without a specific ask — "help me with my
  fitness", "what can the fitness add-on do", "I want to get fit / train better /
  level up my training", "set me up for fitness", "where do I start with the
  fitness coach" — i.e. when the intent is clear (fitness) but the JOB is not. Do
  NOT use it when the request already names a job — those belong to the focused
  skills and own their own triggers: a weekly plan → fitness-training-plan;
  today's readiness / "should I train today" → fitness-pre-workout-brief; "how was
  my week" → fitness-weekly-review; sleep-vs-performance → fitness-correlations;
  pushing / logging / reading Apple Watch data → fitness-health-data; setting the
  training focus / availability / equipment → fitness-athlete-profile; setting the
  body goal / training status / weight / identity → body-profile. This skill
  routes; it does not carry the procedures.
---

# Fitness (the add-on index / router)

This is the **overview** for the Fitness add-on. It exists to **route** a vague request to
the right focused skill — it no longer carries the per-feature procedures (those moved into
the six skills below). When the user names a job, defer to that skill. When the ask is
generic ("help me with my fitness", "what can this do"), give the short map below and ask
which they want.

## The six focused skills — pick one

- **fitness-training-plan** — generate a **weekly plan** (one session per day, with
  rotation / variety and progression, intensity adapted to recovery).
- **fitness-pre-workout-brief** — **today's** readiness / "should I train today?" training
  brief (go / go easy / rest).
- **fitness-weekly-review** — review the **past week** (training load, sleep, form, advice
  for next week).
- **fitness-correlations** — **sleep vs performance** analysis (board-computed stats you
  interpret).
- **fitness-health-data** — **log / query Apple Watch data** (push canonical
  workout/sleep/HRV/resting-HR/steps/VO2max entries, read summaries + trends) and **push a
  health report to the vault**.
- **fitness-athlete-profile** — set the **training focus (sport/event) / weekly availability /
  equipment / sports** (the training-focus half everything else personalises against).
- **body-profile** (the `body` add-on) — set/read the **body goal (free text)**, **identity**
  (sex / DOB / height), **training status** (novice|intermediate|advanced), and **weigh-ins +
  composition**. The body half moved off the athlete profile in v14: the coaching skills READ it
  via the `body` MCP (`get_body_profile` / `get_body_status` / `get_body_objective`); send the user
  here (or **/body**) to SET their goal / training status / weight.

## Cross-cutting reminders (true for all of the above)

- **The board is a state machine; YOU are the intelligence.** The board never calls an LLM —
  nothing is "generated on the board". The agent FETCHES inputs via the `fitness` MCP,
  GENERATES the artifact in its own reasoning, and PERSISTS it via a `save_*` tool so it
  lands in the history feed. Never tell the user to "click Generate" for a plan/review/brief.
- **NOT MEDICAL ADVICE.** Plans, reviews, briefs, and correlations are informational fitness
  guidance — say so, and defer injuries / medical conditions / abnormal symptoms / pregnancy
  / an under-18 user to a physician, physiotherapist, or qualified coach.
- **The `/fitness/*` pages are history FEEDS** over the persisted artifacts
  (latest-by-default, page-back) — `/fitness` (profile), `/fitness/training-plan`,
  `/fitness/weekly-review`, `/fitness/pre-workout-brief`, `/fitness/correlations`, and
  `/fitness/health` (the Apple Watch dashboard). The human glances; the agent does the work.
- **The `fitness` MCP** is the only path to health DATA (never `bash`/`curl`) — 18 thin tools
  (reads + `save_*` writes); writes are add-on-gated and need the add-on ENABLED. The detailed
  tool list, the canonical taxonomy, and the setup live in **/fitness-mcp-setup** — point
  there rather than restating it here.
