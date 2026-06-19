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
  equipment) that feeds **AI coaching** — a weekly training plan, a weekly review, a pre-workout
  brief, a daily form score, and sleep/performance correlations. The generative coaching is produced
  by the **external agent** and persisted back to the board (the board itself never calls an LLM);
  the form score and correlations are the board's own deterministic compute.

The division of labour mirrors the rest of Cos — and follows the
[founding philosophy](https://github.com/philipyaz/cos/blob/main/CLAUDE.md):
**the board is a state machine; the agent is the intelligence.** The **human reads** the views at a
glance; data **writes in** from the watch (via the add-on-gated push); and the one piece of genuine
intelligence — turning raw biometrics into a plan, a review, a brief — lives in the **external agent**
(e.g. the `fitness-coach` skill), **not on the board**. The board **never calls an LLM**: the agent
generates a coaching artifact in its own context and **persists it back** through the fitness MCP's
`save_*` tools / `POST /api/fitness/coaching`, and the board validates, versions, attributes, stores,
and serves it. Correlations are the one coaching surface the board produces itself — because they are
**deterministic compute** (Pearson + linear regression), not generative inference.

## It rides the core store — so it is cheap

Like [nutrition](nutrition.md) and the [calendar](calendar.md), fitness is **not a new store**. It
**replaces** the old standalone `data/health.json` and folds onto the same `cases.json`:

- **`db.healthEntries[]`** — the Apple Watch time-series (the owned **array**), written through the
  **same serialized `mutate()` chokepoint** as cases and events.
- **`db.coachingArtifacts[]`** — the persisted AI coaching outputs (training plans, weekly reviews,
  pre-workout briefs, correlation reports), a **second owned array** (v13 — see
  [Coaching artifacts are persisted & externally-creatable](#coaching-artifacts-are-persisted-externally-creatable)).
- **`db.athleteProfile`** — the training profile, a **singleton object** (not an array, so —
  exactly like nutrition's `db.nutritionGoal` — it is intentionally **not** in the add-on's
  `dataArrays`).

So the add-on inherits the board's machinery for free: the monotonic **`version`** counter +
**SSE live-refresh** (a watch push or an MCP read lands on the read-only view without a reload),
the timestamped **daily backup** (the data rides `cases.json`, so it is snapshotted whole), and the
**actor attribution** baseline. The schema bump to **v12** (`db.healthEntries` + `db.athleteProfile`)
and then **v13** (`db.coachingArtifacts`) is **purely additive** — old files read unchanged, each new
array defaults to `[]`, the profile is simply absent until you set one, and a board with the add-on
disabled is indistinguishable from a pre-add-on board. (See [Add-ons](../architecture/addons.md) for
why this is the whole point.)

The data and helpers live in
[`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts) (the types +
enums) and
[`board/lib/fitness.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness.ts) (the data
API — the module that retired `health-store.ts`).

## HAE ingestion — the push model

Health data does not get typed in; it **arrives off your wrist**. The
[**Health Auto Export**](https://www.healthexport.app/) (HAE) iOS app exports your HealthKit data
on a schedule and `POST`s it to **`/api/fitness/push`**
([`board/app/api/fitness/push/route.ts`](https://github.com/philipyaz/cos/blob/main/board/app/api/fitness/push/route.ts)).

Like every other fitness write, the push is **gated by the add-on toggle**: `pushEntries` calls
`assertAddonEnabled(db, "fitness")` **inside `mutate()`**, so a **disabled** add-on → **`404`**,
while an enabled one accepts the batch. The write is attributed to the agent via the `x-actor`
header, exactly like the rest of the add-on's writes.

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
mapping `NotFoundError → 404`), with the **add-on gate on writes** (push/delete):

| Method + route | What it does | Auth |
|---|---|---|
| `POST /api/fitness/push` | ingest a HAE batch (workouts/metrics/native), dedup by id, purge > 90 days | add-on gate |
| `GET /api/fitness/data?type=&from=&to=&limit=` | list raw entries (newest-first; `limit<=0` = all) | ungated |
| `DELETE /api/fitness/data` | delete entries by `ids` and/or date range | add-on gate |
| `GET /api/fitness/summary?date=\|from=&to=` | the aggregated [summary envelope](#the-summarize-contract) | ungated |
| `GET /api/fitness/daily-summary?date=` | one day of health **folded with nutrition** (see below) | ungated |
| `GET /api/fitness/trends?days=&type=` | per-day series over the last N days | ungated |
| `GET /api/fitness/report?days=` | a human-readable **Markdown** report (for vault ingestion) | ungated |
| `GET /api/fitness/coaching?kind=&from=&to=&limit=` | list persisted [coaching artifacts](#coaching-artifacts-are-persisted-externally-creatable) | ungated |
| `POST /api/fitness/coaching` | upsert one coaching artifact by `(kind, periodKey)` | add-on gate |
| `GET\|PATCH\|DELETE /api/fitness/coaching/<id>` | read / patch / delete one artifact | reads ungated; writes add-on gate |

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

`/fitness` is where the raw biometrics become coaching. It hangs off one **singleton profile** plus
two deterministic board computes (the [form score](#the-daily-form-score), a pure helper, and
[correlations](#correlations), pure stats) — and the **persisted coaching artifacts** (training plan,
weekly review, pre-workout brief) that the [agent generates and the board stores](#the-coaching-surfaces-are-stateful-artifacts-the-agent-generates-the-board-stores).
The board does **not** call an LLM here; the agent does the generating.

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

### The coaching surfaces are stateful artifacts — the agent generates, the board stores

The three generative coaching surfaces — the **training plan**, the **weekly review**, and the
**pre-workout brief** — are **stateful artifacts**, not board-side LLM calls. Following Cos's
[founding philosophy](https://github.com/philipyaz/cos/blob/main/CLAUDE.md),
**the board never calls an LLM.** The **agent** (e.g. the
[`fitness-coach` skill](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/fitness-coach/SKILL.md), reading the same profile +
recent health + nutrition through the fitness MCP) **generates** the plan / review / brief in its own
context, and **persists it back** through the MCP `save_*` tools / `POST /api/fitness/coaching`. The
board only **validates** the artifact's shape (raw bodies are never trusted), **versions** it (SSE),
**attributes** it (`agent` vs `human` vs `board`), **stores** it (upserted into
`db.coachingArtifacts` by period), and **serves** it back.

!!! warning "The board-side generate routes are removed"
    There used to be three board-side LLM routes — `GET /api/fitness/training-plan`,
    `GET /api/fitness/weekly-review`, `GET /api/fitness/pre-workout-brief` — that called Claude on the
    board's Anthropic key via a hardened `callClaude` (`board/lib/fitness-ai.ts`) and returned ephemeral
    JSON. **Those routes (and `fitness-ai.ts`) are gone.** A component is a state machine; it does not
    embed an LLM. Generation moved out to the agent; the board exposes only the **CRUD seam**
    ([`/api/fitness/coaching`](#the-crud-seam-apifitnesscoaching-add-on-gated-writes-open-reads)) that
    accepts and persists the agent's artifact. (The **vault MCP** remains the one component in the repo
    that legitimately runs LLM calls — it embeds the Claude Agent SDK.)

| Artifact | What it captures |
|---|---|
| **Training plan** | a personalized **weekly plan** (per-day sport/duration/intensity/zones), adapted to the recovery state (HRV/sleep/load) and the profile's constraints (days/equipment/max session) |
| **Weekly review** | an `overall_score`, training-vs-plan, sleep trend, recovery/fatigue, and 3–5 recommendations — folding the [form score](#the-daily-form-score) and (soft) nutrition |
| **Pre-workout brief** | a same-day **readiness brief** — ready / cautious / rest-recommended, a recommended session, warnings, and green-lights |

The matching `/fitness/*` UI pages are **history feeds** over the persisted artifacts — they show the
**latest** artifact of that kind by default and let you **page back** through the stored history (see
[the history feed UI](#the-history-feed-ui)); they hold a **Generate** action that hands off to the
agent rather than calling an LLM on the board. These reads/writes are **informational estimates, not
medical advice** — a low-HRV / poor-sleep "train easy" read is a conservative default, never a
substitute for clinical judgement.

A generated plan can be **materialized onto the calendar** via
**`POST /api/fitness/push-plan-to-calendar`**, which mints `db.events` (gated on the fitness add-on,
validated day-by-day inside `mutate()`) — the same opt-in calendar bridge nutrition uses for meals.

### Correlations

**Correlations are the one coaching surface the board produces itself** — because they are
**deterministic compute, not generative inference.** A state machine may compute deterministically;
only generative LLM inference is delegated to the agent.

**`GET /api/fitness/correlations?days=N`**
([source](https://github.com/philipyaz/cos/blob/main/board/app/api/fitness/correlations/route.ts))
correlates per-day **sleep** against per-day **workout performance** (calories per minute) over the
last N days — Pearson `r` + a linear regression — to answer "does sleeping better make me train
better?" It reads the canonical taxonomy directly (no LLM; pure stats), so the board runs it itself.
The response carries the window's `from` / `to` (`YYYY-MM-DD`), and the report is **persisted
best-effort** as a `correlations` artifact keyed on `<from>_<to>` (these are **observational
correlations, not causation, and not medical advice**).

## Coaching artifacts are persisted & externally-creatable

The four coaching surfaces are **stateful artifacts** on **one polymorphic array**,
`db.coachingArtifacts[]`. (An earlier design had the board generate three of them with a server-side
Claude call and throw the JSON away — no history, and an external agent could not produce one without
the board's key. That is gone: the board never calls an LLM, so all four kinds are simply persisted,
and the three generative kinds are created by the **external agent** that generated them in its own
context. Correlations the board still computes itself — deterministic stats, not generation.)

### One record, four kinds — `CoachingArtifact`

Rather than four parallel arrays, the four kinds share **one** record
([`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts)):

```ts
interface CoachingArtifact {
  id: string;            // minted "COACH-<n>"
  kind: CoachingArtifactKind;   // "training_plan" | "weekly_review" | "pre_workout_brief" | "correlations"
  periodKey: string;     // UNIQUE per (kind, periodKey)
  source: ArtifactSource;       // "agent" | "human" | "board"
  payload: Record<string, unknown>;  // the kind-specific body, verbatim (the agent-generated artifact, or the correlations compute)
  generatedAt: string;   // ISO; payload.generated_at if present, else createdAt
  createdAt: string;     // ISO; STICKY first-persist time
  updatedAt: string;     // ISO; bumped on every upsert
}
```

The **`periodKey`** is what makes the array a *register of the latest per period* rather than an
append-only log — there is **at most one artifact per `(kind, periodKey)`**, and re-persisting the
same period **upserts in place** (the `id` + `createdAt` stay sticky; `payload` / `source` /
`generatedAt` / `updatedAt` are replaced). The key shape is kind-specific:

| `kind` | `periodKey` | Derived from |
|---|---|---|
| `training_plan` | ISO week, e.g. `2026-W25` | `payload.week` |
| `weekly_review` | ISO week, e.g. `2026-W25` | `payload.week` |
| `pre_workout_brief` | `YYYY-MM-DD` | `payload.date` (else today) |
| `correlations` | `<from>_<to>` | the window's `from` / `to` |

The enums (`VALID_COACHING_ARTIFACT_KIND`, `VALID_ARTIFACT_SOURCE`) are single-sourced in
`types.ts`; the validators that enforce the per-kind minimal payload shape (so **the agent's artifact
is never persisted unvalidated** — the board does not trust a raw body) and derive the `periodKey` live in
[`board/lib/fitness-artifacts.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/fitness-artifacts.ts).

### The CRUD seam — `/api/fitness/coaching` (add-on-gated writes / open reads)

A new route family follows the add-on contract exactly — **reads ungated, writes add-on-gated**:

| Method + route | What it does | Auth |
|---|---|---|
| `GET /api/fitness/coaching?kind=&from=&to=&limit=` | list artifacts (newest-first; `from`/`to` against `createdAt`) | ungated |
| `POST /api/fitness/coaching` | upsert one artifact by `(kind, periodKey)` | add-on gate |
| `GET /api/fitness/coaching/<id>` | one artifact by id | ungated |
| `PATCH /api/fitness/coaching/<id>` | patch an artifact (payload / source / generatedAt) | add-on gate |
| `DELETE /api/fitness/coaching/<id>` | delete an artifact | add-on gate |

These coaching writes are **add-on-gated**: the add-on gate
(`assertAddonEnabled(db, "fitness")`) runs **inside `mutate()`**, so a disabled add-on → `404`, while
an enabled one accepts the write. This is
precisely what lets **the agent (Claude Cowork) create artifacts without any Anthropic key on the
board**: the agent generates the plan/review/brief in its own context, is attributed via `x-actor`,
and `POST`s it; the board persists it without ever calling Claude. (When the actor
resolves to `agent`, the route forces `source: "agent"`; `source: "board"` is reserved for the
correlations compute the board runs itself.)

### The history feed UI

The four `/fitness/*` coaching pages render through one shared client component,
[`artifact-feed.tsx`](https://github.com/philipyaz/cos/blob/main/board/components/fitness/artifact-feed.tsx):
it lists `GET /api/fitness/coaching?kind=<kind>` **newest-first**, defaults to the **latest**
artifact, and offers **prev/next** stepping back through the persisted history. The feed is the
**single source of truth** for artifact data — the pages are **history feeds over the stored
artifacts**, not live generators. For the three generative kinds the page's **Generate** action hands
off to the agent (which generates and `POST`s back); for correlations it triggers the board's
deterministic compute. The feed subscribes to SSE, so an agent `POST` lands on the page without a
reload.

### The seven new MCP tools

The [fitness MCP server](https://github.com/philipyaz/cos/blob/main/mcp/fitness-server/server.mjs)
gains seven thin wrappers over the new routes (total **14**) — four `save_*` writers (one per kind),
plus list / get / delete — so an agent can persist and browse artifacts entirely through the MCP. The
four `save_*` tools and `delete_coaching_artifact` are **add-on-gated writes**;
`list_coaching_artifacts` and `get_coaching_artifact` are ungated reads. See
[the MCP tool table below](#the-fitness-mcp-the-agents-read-verbs).

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
LLM calls**, and — exactly like the nutrition MCP — attributes its **writes to the agent** via the
`x-actor: "agent"` header, with every write gated by the add-on toggle.

| Tool | Maps to | Notes |
|---|---|---|
| `push_health_data` | `POST /push` | ingest entries; add-on-gated write |
| `list_health_data` | `GET /data` | raw entries by type / range |
| `get_health_summary` | `GET /summary` | the [summarize envelope](#the-summarize-contract) |
| `get_daily_summary` | `GET /daily-summary` | one day, health folded with nutrition |
| `get_health_trends` | `GET /trends` | per-day series over N days |
| `delete_health_data` | `DELETE /data` | delete by ids/range; add-on-gated write |
| `ingest_health_to_vault` | `GET /report` | fetch the Markdown report and forward it to the vault |
| `save_training_plan` | `POST /coaching` | persist a `training_plan` artifact; add-on-gated write |
| `save_weekly_review` | `POST /coaching` | persist a `weekly_review` artifact; add-on-gated write |
| `save_pre_workout_brief` | `POST /coaching` | persist a `pre_workout_brief` artifact; add-on-gated write |
| `save_correlation_report` | `POST /coaching` | persist a `correlations` artifact; add-on-gated write |
| `list_coaching_artifacts` | `GET /coaching` | list artifacts by kind / range |
| `get_coaching_artifact` | `GET /coaching/<id>` | one artifact by id |
| `delete_coaching_artifact` | `DELETE /coaching/<id>` | delete an artifact; add-on-gated write |

The four `save_*` tools let an agent (Claude Cowork) persist a generated plan / review / brief /
report **without the board's Anthropic key** — the add-on gate is the only guard. A write on a
**disabled** add-on returns the board's `404`, surfaced as a `Not found.` tool error.

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
exactly like the nutrition bridge. Point Health Auto Export at `/api/fitness/push` to ingest off your
phone — the write lands whenever the add-on is enabled.

## Parity rule

Fitness obeys the board's founding tenet — **one store, one write path**. The entries fold into
`cases.json`, every mutation flows through the single atomic, version-guarded `mutate()` with the
add-on gate inside it, the read-only views and the agent's tools resolve to the same
`/api/fitness/*` routes, and disabling the add-on freezes writes while leaving every byte readable —
all gated by one flag.
