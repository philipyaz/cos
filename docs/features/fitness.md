# Fitness — the training add-on

Cos's core is about *matters* — work and life to-dos on a board. **Fitness** is the
second **[add-on](../architecture/addons.md)** (after [Nutrition & Chef](nutrition.md)): an
optional vertical that adds a different daily surface — **your body, your training, and an AI
coach** — layered over the same store, gated behind one toggle, and shipped **disabled by
default**. A board only carries it if you switch it on.

It is **one** add-on spanning **two surfaces** behind one flag, one MCP bridge, and one setup
skill:

- **`/fitness/health` — the dashboard.** Apple Watch HealthKit data — workouts, sleep, HRV,
  resting heart rate, steps, VO₂max — ingested off your phone and read back as a daily summary,
  trends, and a Markdown report.
- **`/fitness` — the coach.** A singleton training profile (your goal, level, available days,
  equipment) that feeds an **AI coach**: a weekly training plan, a weekly review, a pre-workout
  brief, a daily form score, and sleep/performance correlations.

The division of labour mirrors the rest of Cos: the **human reads** the views at a glance; data
**writes in** from the watch (via a token-gated push) and the **agent reads** through the fitness
MCP. The one piece of genuine intelligence — turning raw biometrics into coaching — lives in the
**AI coaching routes** (forced-tool calls to Claude), not in the MCP, which stays a thin fetch
wrapper.

## It rides the core store — so it is cheap

Like [nutrition](nutrition.md) and the [calendar](calendar.md), fitness is **not a new store**. It
**replaces** the old standalone `data/health.json` and folds onto the same `cases.json`:

- **`db.healthEntries[]`** — the Apple Watch time-series (the owned **array**), written through the
  **same serialized `mutate()` chokepoint** as cases and events.
- **`db.athleteProfile`** — the training profile, a **singleton object** (not an array, so —
  exactly like nutrition's `db.nutritionGoal` — it is intentionally **not** in the add-on's
  `dataArrays`).

So the add-on inherits the board's machinery for free: the monotonic **`version`** counter +
**SSE live-refresh** (a watch push or an MCP read lands on the read-only view without a reload),
the timestamped **daily backup** (the data rides `cases.json`, so it is snapshotted whole), and the
**actor attribution** baseline. The schema bump to **v11** (`db.healthEntries` + `db.athleteProfile`)
is **purely additive** — old v10 files read unchanged, the array defaults to `[]`, the profile is
simply absent until you set one, and a board with the add-on disabled is indistinguishable from a
pre-add-on board. (See [Add-ons](../architecture/addons.md) for why this is the whole point.)

The data and helpers live in
[`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts) (the types +
enums) and
[`board/lib/fitness.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness.ts) (the data
API — the module that retired `health-store.ts`).

## HAE ingestion — the `x-fitness-token` push model

Health data does not get typed in; it **arrives off your wrist**. The
[**Health Auto Export**](https://www.healthexport.app/) (HAE) iOS app exports your HealthKit data
on a schedule and `POST`s it to **`/api/fitness/push`**
([`board/app/api/fitness/push/route.ts`](https://github.com/philipyaz/cos/blob/main/board/app/api/fitness/push/route.ts)).

This is the **one route that is NOT actor-attributed**. Where every other board write resolves a
`human` / `agent` actor, the push authenticates with a **shared-secret header** instead — a
different auth shape for a machine-to-machine ingest:

- The request must carry **`x-fitness-token`** matching **`FITNESS_PUSH_TOKEN`** from the server env
  (lives in `config/secrets.env`).
- A missing token on the server → **`503`** ("not configured"); a wrong/absent header → **`401`**.
- The add-on gate still applies: `pushEntries` calls `assertAddonEnabled(db, "fitness")` **inside
  `mutate()`**, so a **disabled** add-on → **`404`** even with a valid token.

The route **normalizes three HAE shapes** into one canonical entry list before storing — workouts
(`{ data: { workouts: [...] } }`), metrics (`{ data: { metrics: [{ name, units, data }] } }`), or
the flat native `{ entries }` — so you can point HAE at the endpoint without reshaping:

- **Workouts** become one `workout` entry each: HAE's verbose fields are distilled to
  `{ activity, duration_min, calories, avg_hr, distance_km, ... }`, with units coerced (kJ→kcal,
  mi→km) at the boundary.
- **Metrics** are grouped **by calendar day** and aggregated per metric per day — **sum** for
  additive counts (steps), **avg** for rates (HRV, resting HR, VO₂max), **last** for sleep — so one
  metric yields **one entry per day**. HAE re-sends the full history on every push, so **all** days
  are kept (dropping non-today days would lose any day the watch missed); idempotency comes from a
  **deterministic dedup id** (`<metric>_<day>`), not from filtering.
- **Sleep** is split into `sleep_night` vs `sleep_nap` by the sleep-start hour (night = 20:00–05:59),
  with the stage breakdown preserved in `data.metadata`.
- **Unmapped HAE metric names are stored verbatim** (lower-cased), so a new HealthKit export type
  never silently drops data — `HealthEntry.type` is a plain string, not a closed union, for exactly
  this reason.

Two more properties of the ingest:

- **Dedup by id.** `pushEntries` skips any entry whose `id` already exists — re-pushing the same
  workout or the same metric-day is a no-op. The response reports `{ accepted, duplicates, purged,
  total, version }`.
- **90-day retention.** Every push purges entries older than 90 days (`RETENTION_DAYS`), comparing
  **date-only** so a date-only `ts` and a full-ISO `ts` are both handled.

## The canonical health taxonomy

The hard-won lesson here was a **taxonomy bug**: consumers used to query `"heart_rate_variability"`
(stored as `"hrv"`) and read `data.duration_min` / `data.avg_ms` / `data.bpm` / `data.count` instead
of `data.value`. The taxonomy is now **one source of truth** —
[`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts)'s
`HealthEntryType` + `VALID_HEALTH_ENTRY_TYPE` — that the ingest route writes, every consumer reads,
and the MCP server mirrors in lockstep.

Every entry is `{ id, ts, type, data, pushedAt }`. The `type` string and the `data` shape:

| `type` | `ts` | `data` shape |
|---|---|---|
| `workout` | full ISO start | `{ activity, duration_min, calories?, avg_hr?, distance_km?, speed_kmh?, hr_min?, hr_max?, source }` |
| `sleep_night` | `YYYY-MM-DD` | `{ value: hours, metadata: { deep, rem, core, awake, sleepStart, sleepEnd } }` |
| `sleep_nap` | `YYYY-MM-DD` | same shape as `sleep_night` |
| `hrv` | `YYYY-MM-DD` | `{ value: ms }` (per-day avg) |
| `resting_hr` | `YYYY-MM-DD` | `{ value: bpm }` (per-day avg) |
| `steps` | `YYYY-MM-DD` | `{ value: count }` (per-day sum) |
| `vo2max` | `YYYY-MM-DD` | `{ value: mL/kg/min }` (per-day latest) |
| *(unmapped HAE metric)* | `YYYY-MM-DD` | stored verbatim, value in `data.value` |

The invariant: **per-day metric aggregates carry their number in `data.value`**; workouts carry the
rich `data.*` shape. Every consumer — the daily summary, the trends, the form score, the
correlations, the AI coach — reads this taxonomy, and the
[fitness MCP server](https://github.com/philipyaz/cos/blob/main/mcp/fitness-server/server.mjs) keeps a
mirrored `HEALTH_TYPES` list with a lockstep comment.

## The data API — `/api/fitness/*`

The fitness routes follow the board idioms (`force-dynamic`; reads ungated; `storeErrorToResponse`
mapping `NotFoundError → 404`), with the **token gate on writes** (push/delete) standing in for the
usual actor gate:

| Method + route | What it does | Auth |
|---|---|---|
| `POST /api/fitness/push` | ingest a HAE batch (workouts/metrics/native), dedup by id, purge > 90 days | **`x-fitness-token`** + add-on gate |
| `GET /api/fitness/data?type=&from=&to=&limit=` | list raw entries (newest-first; `limit<=0` = all) | ungated |
| `DELETE /api/fitness/data` | delete entries by `ids` and/or date range | **`x-fitness-token`** + add-on gate |
| `GET /api/fitness/summary?date=\|from=&to=` | the aggregated [summary envelope](#the-summarize-contract) | ungated |
| `GET /api/fitness/daily-summary?date=` | one day of health **folded with nutrition** (see below) | ungated |
| `GET /api/fitness/trends?days=&type=` | per-day series over the last N days | ungated |
| `GET /api/fitness/report?days=` | a human-readable **Markdown** report (for vault ingestion) | ungated |

### The `summarize()` contract

`summarize()` in [`board/lib/fitness.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness.ts)
is the shared aggregator — the contract the `/summary` route, the `/report` route, the MCP report
tool, and the UI all read:

```
{
  sleep?:      { count, avg_hours, avg_deep_hours, avg_rem_hours },
  hrv?:        { count, avg_ms },
  resting_hr?: { count, avg_bpm },
  steps?:      { days, total, avg_per_day },
  vo2max?:     { count, latest },
  workout?:    { count, total_duration_min, total_calories, activities: { <name>: <n> } }
}
```

A key absent from the envelope means **no data of that type in the window** — every consumer treats
a missing key as "nothing logged", never as zero.

## The athlete sub-surface

`/fitness` is where the raw biometrics become coaching. It hangs off one **singleton profile** and a
small family of read routes — the [form score](#the-daily-form-score) is a pure helper; the
[training plan / weekly review / pre-workout brief](#the-ai-coach) are AI calls.

### The profile singleton — `AthleteProfile`

`db.athleteProfile` is a **singleton** (mirrors `db.nutritionGoal`): exactly one current profile, a
bare object set/replaced (never minted with an id), with a **sticky `createdAt`** preserved across
replaces. It is read with `getProfile()` and written with `setProfile()` (gated inside `mutate()`),
both in [`board/lib/fitness.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness.ts), and
served by **`/api/fitness/profile`** (`GET` ungated, `PUT`/`POST` gated).

| Field | Type | Notes |
|---|---|---|
| `goal` | `AthleteGoal` | `weight_loss` \| `sprint_triathlon` \| `olympic_triathlon` \| `cycling` \| `swimming` \| `running` \| `general_fitness` |
| `goalDate` | `string` | ISO `YYYY-MM-DD` target date, or `""` |
| `level` | `AthleteLevel` | `beginner` \| `intermediate` \| `advanced` |
| `currentWeightKg` / `targetWeightKg` | `number\|null` | kilograms (canonical, like `WeightEntry`) |
| `daysPerWeek` | `number\|null` | 1–7 sessions/week |
| `maxSessionMinutes` | `number\|null` | session-length ceiling the coach respects |
| `sports` | `string[]` | ⊆ `VALID_ATHLETE_SPORT` |
| `equipment` | `string[]` | ⊆ `VALID_ATHLETE_EQUIPMENT` |
| `notes` | `string` | freeform context for the coach |

!!! note "English value domain — single-sourced"
    The athlete enums (`VALID_ATHLETE_GOAL`, `VALID_ATHLETE_LEVEL`, `VALID_ATHLETE_SPORT`,
    `VALID_ATHLETE_EQUIPMENT`) live in
    [`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts), and the
    **route validator and the UI option lists import the SAME arrays** — never redefined inline. All
    stored vocabulary, prompts, enums, and labels are in **English** (an earlier version stored
    French; that drift is gone).

### The daily form score

**`GET /api/fitness/form-score?date=`** is a thin wrapper over `computeFormScore` in
[`board/lib/fitness-score.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness-score.ts)
— a **pure, I/O-free** helper (no loopback HTTP) that reads the canonical taxonomy and blends four
sub-scores (HRV, sleep, resting HR, recent load), each 0–100, into one daily **readiness** score
with a `level` / `color` / `recommendation`. It is the headline widget on both `/fitness/health` and
`/fitness`, and the weekly review + pre-workout brief call it **in-process**.

### The AI coach

Three routes turn the profile + recent health (+ nutrition, when present) into structured coaching.
They share
[`board/lib/fitness-ai.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness-ai.ts)'s
hardened `callClaude`:

- **Model `claude-sonnet-4-6`** — supports forced tool use + prompt caching.
- **Forced tool use** — the model is forced to call a tool whose `input_schema` *is* the output
  shape, so the route gets **already-valid JSON** back: no markdown-fence stripping, no bare
  `JSON.parse` on free text. A `max_tokens` truncation is caught and returned as a clear error.
- **A `cache_control` breakpoint** sits at the end of the **stable** coaching system prompt; the
  **volatile** per-request context (profile + health + nutrition + dates) is appended *after* it, so
  the cached prefix is never invalidated by the changing data.
- The API key is read from `config/secrets.env` (placeholder/empty values rejected).

| Route | What it returns |
|---|---|
| `POST /api/fitness/training-plan` | a personalized **weekly plan** (per-day sport/duration/intensity/zones), adapted to the recovery state (HRV/sleep/load) and the profile's constraints (days/equipment/max session) |
| `POST /api/fitness/weekly-review` | a **weekly review** — an `overall_score`, training-vs-plan, sleep trend, recovery/fatigue, and 3–5 recommendations — folding the [form score](#the-daily-form-score) and (soft) nutrition |
| `POST /api/fitness/pre-workout-brief` | a same-day **readiness brief** — ready / cautious / rest-recommended, a recommended session, warnings, and green-lights |

A generated plan can be **materialized onto the calendar** via
**`POST /api/fitness/push-plan-to-calendar`**, which mints `db.events` (gated on the fitness add-on,
validated day-by-day inside `mutate()`) — the same opt-in calendar bridge nutrition uses for meals.

### Correlations

**`GET /api/fitness/correlations?days=N`**
([source](https://github.com/philipyaz/cos/blob/main/board/app/api/fitness/correlations/route.ts))
correlates per-day **sleep** against per-day **workout performance** (calories per minute) over the
last N days — Pearson `r` + a linear regression — to answer "does sleeping better make me train
better?" It reads the canonical taxonomy directly (no AI; pure stats).

## The soft Nutrition dependency

Fitness **SOFT-depends** on [Nutrition & Chef](nutrition.md) — declared in the manifest as
`dependsOn: [{ id: "nutrition", required: false }]`. It means: the coach works **better** with
Nutrition (the daily summary and the weekly review fold `db.foodLogs` into the picture — calories
in vs. workout calories out, macros, an energy balance), but it **degrades gracefully** when
Nutrition is off or absent.

Crucially, the dependency **does not gate reads**. `/api/fitness/daily-summary` reads `db.foodLogs`
straight from the store — it does **not** check `isAddonEnabled(db, "nutrition")` before doing so,
because gating that read would hide frozen-but-readable data and violate the framework's "reads stay
open" contract. A board with Nutrition disabled simply has no recent food logs to fold, so the
nutrition section comes back empty rather than erroring. The soft edge is a **catalog hint** ("works
better with Nutrition"), not an auto-enable and not a hard gate. See
[Add-ons § soft dependencies](../architecture/addons.md#optional-inter-add-on-dependencies-dependson).

## The fitness MCP — the agent's read verbs

A new **stdio MCP server** (registry name **`fitness`**, bridge port **`8011`**,
[`mcp/fitness-server/server.mjs`](https://github.com/philipyaz/cos/blob/main/mcp/fitness-server/server.mjs))
is the agent's twin of the dashboard — a **thin `fetch` wrapper** over the `/api/fitness/*` routes on
`CRM_BASE_URL` (default `http://localhost:3000`), built on `packages/mcp-kit`. It holds **no
business logic** (the report Markdown is composed by `/api/fitness/report`, not the MCP), makes **no
LLM calls**, and — unlike the nutrition MCP — authenticates its **writes with `x-fitness-token`**
(not `actor: "agent"`), because the push/delete routes use the shared-secret auth shape.

| Tool | Maps to | Notes |
|---|---|---|
| `push_health_data` | `POST /push` | ingest entries; token-gated write |
| `list_health_data` | `GET /data` | raw entries by type / range |
| `get_health_summary` | `GET /summary` | the [summarize envelope](#the-summarize-contract) |
| `get_daily_summary` | `GET /daily-summary` | one day, health folded with nutrition |
| `get_health_trends` | `GET /trends` | per-day series over N days |
| `delete_health_data` | `DELETE /data` | delete by ids/range; token-gated write |
| `ingest_health_to_vault` | `GET /report` | fetch the Markdown report and forward it to the vault |

A write on a **disabled** add-on returns the board's `404`, surfaced as a `Not found.` tool error.

## The read-only views

Enabling the add-on reveals a **Fitness** nav group, plus the reachable **Add-ons** catalog
link:

- **`/fitness`** — the profile + form score + entry points to the coach (the athlete hub / Overview).
- **`/fitness/health`** — the dashboard (today's form score, recent workouts, sleep, HRV, steps,
  trends).
- **`/fitness/training-plan`**, **`/fitness/weekly-review`**, **`/fitness/pre-workout-brief`**,
  **`/fitness/correlations`** — the four coaching surfaces.

All subscribe to SSE, so a watch push (or an MCP write) lands without a reload. A **disabled** add-on
`404`s its pages and hides its nav, but the data stays readable via the API and the **Add-ons**
catalog link stays reachable so you can turn it back on. Disabling never deletes data.

## Setup

The add-on's bridge is wired by the **`fitness-mcp-setup`** skill (the `mcp.setupSkill` in the
manifest) — it renders + loads the launchd bridge plist on `:8011` and wires the `.mcp.json` entry,
exactly like the nutrition bridge. The push token (`FITNESS_PUSH_TOKEN`) lives in
`config/secrets.env`; point Health Auto Export at `/api/fitness/push` with that token in the
`x-fitness-token` header.

## Parity rule

Fitness obeys the board's founding tenet — **one store, one write path** — with one deliberate
exception worth naming: the **HAE push is machine auth, not human/agent attribution**. Everything
else holds: the entries fold into `cases.json`, every mutation flows through the single atomic,
version-guarded `mutate()` with the add-on gate inside it, the read-only views and the agent's tools
resolve to the same `/api/fitness/*` routes, and disabling the add-on freezes writes while leaving
every byte readable — all gated by one flag.
