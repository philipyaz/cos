---
name: fitness-health-data
description: >
  The Fitness DATA-PLANE operator — ingests, queries, and maintains Apple Watch
  health data on the Cos board via the `fitness` MCP, and pushes a health report to
  the vault. It INGESTS canonical health entries (push workout / sleep / HRV /
  resting-HR / steps / VO2max, dedup by id, 90-day auto-purge), READS the data back
  (raw entries, a per-type summary, multi-day trends, a full daily health + nutrition
  summary), FIXES bad rows (hard-delete by id or date range), and composes + persists a
  HEALTH REPORT to the vault. It does NOT design plans / reviews / briefs and does NOT
  edit the athlete profile — those are the coaching + profile skills. Always with
  not-medical-advice framing on any interpretation. Use when the user says "push my
  watch data", "log my workout", "log my sleep", "log my HRV", "I ran 5k", "how did I
  sleep", "what's my HRV trend", "summarize my health today", "how was my day", "show my
  resting HR over two weeks", "delete that bad entry", "remove the duplicate sleep
  entry", "save my health summary to the vault", "log this week's training to my
  knowledge base", or otherwise asks to ingest, read, fix, or vault-archive health data.
---

# Fitness — health data (the data-plane operator)

This skill is the **intelligence** that turns a plain-language health note — *"push last
night's sleep"*, *"I ran 5k this morning"*, *"what's my HRV doing"*, *"how was my day"*,
*"delete that bad entry"* — into structured health records on the board, and that archives a
health report into the vault. The **health data** plumbing runs **only** through the
**`fitness`** MCP — never `bash`/`curl` (Cowork's sandbox blocks outbound HTTP; the tools
exist for exactly this). The board UI is the **read** twin: the human glances at
`/fitness/health` (the Apple Watch dashboard); the agent (you) does the ingestion, the reads,
the fixes, and the vault archive.

The data this skill ingests is the **fuel** for everything else: the coaching skills (training
plan, weekly review, pre-workout brief, correlations) and the `/fitness/health` dashboard all
read the entries you push here. Get the data in clean and they work; push a malformed entry and
they silently see nothing.

**Scope — this is the DATA half.** This skill does **ingest + query + maintain + vault**. It
does **NOT** design training plans (**fitness-training-plan**), weekly reviews
(**fitness-weekly-review**), pre-workout briefs (**fitness-pre-workout-brief**), or
correlations (**fitness-correlations**), and it does **NOT** create or edit the athlete
profile (that's the **fitness-athlete-profile** skill). If the user asks for a plan, a review,
a brief, correlations, or to set their goal/level/sports, hand off to the right sibling skill.

> **Gate — the add-on must be ENABLED.** Every WRITE (`push_health_data`,
> `delete_health_data`) 404s ("Not found — the fitness add-on may be disabled.") when the
> Fitness add-on is disabled; READS always work. If a write comes back "Not found.", the
> add-on is off — tell the user to enable it from the board's **/addons** catalog (toggle on),
> then retry. You don't enable it yourself; it's a deliberate, human, one-time switch.

> **Attribution.** The MCP stamps health writes as the **agent** (the `x-actor: agent`
> header), and the board's activity log records them. There is **no pending / propose queue**
> for health — these tools write **directly**. So "approval" here means a **conversational**
> check-in (STEP 0), not the board's propose/approve flow. Don't claim a pending queue exists.

> **NOT MEDICAL ADVICE — say it whenever you interpret.** You only **log what the user (or their
> export) provides** — but the moment you *read back* and interpret a number (a low HRV, poor
> sleep, an elevated resting HR), frame it as an **informational estimate, not medical advice.**
> **Defer to a professional** (a physician or qualified clinician) for any abnormal symptom,
> chest pain, injury, illness, pregnancy, or a user under 18 — recommend they consult one. Never
> diagnose from biometric data.

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if the file or
key is missing). State the mode once at the start of the run.

- **`autoSync: true` (auto mode).** Just do the work. Push the data, fix the entry — and report
  what you wrote so the user can see it on the board.
- **`autoSync: false` (approval mode).** Before a **BULK** write — pushing a large batch /
  backfill of entries — or a **destructive** one (`delete_health_data`, especially a date-range
  delete), lay out the plan **in chat** and ask the user to confirm, then proceed once they say
  yes.

> **A single low-stakes write is fine either way.** One `push_health_data` of a single entry,
> one fix-up, just do it, in either mode. The conversational check is for **bulk** and
> **destructive** writes; don't make the user approve pushing one workout.

All reads — `list_health_data`, `get_health_summary`, `get_daily_summary`,
`get_health_trends`, and `ingest_health_to_vault` (it only composes, doesn't persist) — need no
confirmation in any mode. Read freely.

---

## The canonical health taxonomy (read this before any push)

Every entry is `{ id, ts, type, data }`. **id** is globally unique (used for dedup; reuse the
same id to overwrite). **ts** is `YYYY-MM-DD` for daily metrics + sleep, full ISO-8601 for a
workout start. **type** is one of the **seven canonical strings** — and the **data** shape is
type-specific. **Get these exactly right** — a wrong type string or a value in the wrong field
silently produces empty summaries / trends / dashboard.

| `type` | `ts` | `data` shape |
|---|---|---|
| `workout` | full ISO start (`2026-06-16T07:30:00Z`) | `{ activity, duration_min, calories?, avg_hr?, distance_km? }` |
| `sleep_night` | `YYYY-MM-DD` | `{ value: <hours>, metadata: { deep, rem, core, awake, sleepStart, sleepEnd } }` |
| `sleep_nap` | `YYYY-MM-DD` | `{ value: <hours>, metadata: {…} }` |
| `hrv` | `YYYY-MM-DD` | `{ value: <ms> }` |
| `resting_hr` | `YYYY-MM-DD` | `{ value: <bpm> }` |
| `steps` | `YYYY-MM-DD` | `{ value: <count> }` |
| `vo2max` | `YYYY-MM-DD` | `{ value: <mL/kg/min> }` |

**The metric value ALWAYS lives in `data.value`** (hrv = ms, resting_hr = bpm, steps = count,
vo2max = mL/kg/min, sleep = **hours**) — never `data.bpm` / `data.count` / `data.ms` /
`data.duration_min`. Sleep hours go in `data.value`, the stage breakdown (deep / rem / core /
awake, in hours) in `data.metadata`. **Workouts are the one exception**: they carry `activity` +
`duration_min` (+ optional `calories` / `avg_hr` / `distance_km`) directly on `data`, no
`value`. Unmapped Health Auto Export metric names are stored verbatim, but **only the seven
canonical types feed the summaries / trends / dashboard / coach** — so map onto them.

> **Most ingestion is automatic.** The iPhone's **Health Auto Export** shortcut posts raw HAE
> payloads straight to the board's ingest endpoint; the board maps them onto this taxonomy.
> `push_health_data` is for **already-canonical** entries — a
> manual log, a correction, a backfill. Prefer letting the shortcut do the bulk; reach for the
> tool for one-off / fix-up writes.

---

## JOB 1 — INGEST ("push my watch data", "log my run / sleep / HRV")

From a free-text health note, build canonical entries and `push_health_data({ entries: [...] })`.

**1. Pick the type + build `data`** per the taxonomy table. *"I slept 7.5 hours, 1.5 deep"* →
`{ id, ts: "<night>", type: "sleep_night", data: { value: 7.5, metadata: { deep: 1.5 } } }`.
*"morning HRV was 62"* → `{ type: "hrv", data: { value: 62 } }`. *"45-min easy run, 6 km"* →
`{ type: "workout", ts: "<ISO start>", data: { activity: "running", duration_min: 45,
distance_km: 6 } }`. **Put the metric in `data.value`** — that's the bug to never reintroduce.

**2. Mint a stable, unique `id`.** Use something deterministic per logical entry
(`sleep-2026-06-16`, `hrv-2026-06-16`, `workout-2026-06-16T0730`) so a **re-push of the same day
overwrites rather than duplicating** — re-pushing the exact same entry is an **idempotent no-op**
(dedup is by id). For an arbitrary manual entry a short unique slug is fine (`hlth-<rand>`).

**3. Push, then read back.** `push_health_data` returns `{ accepted, duplicates, purged, total,
version }`. Report the **accepted** count, note **duplicates** (re-pushes that deduped to a
no-op), and note **purged** if the **90-day retention** swept old rows (entries older than 90
days auto-purge on write). A single entry is low-stakes — push it directly; a large backfill is a
**bulk** write (confirm in approval mode).

> **Example.** *"push last night: slept 7h12m, 1h20 deep, 1h45 REM; resting HR 52; HRV 58"*
> (auto mode) → one `push_health_data` with three entries: `sleep_night` (value 7.2,
> metadata.deep 1.33, metadata.rem 1.75), `resting_hr` (value 52), `hrv` (value 58), all
> `ts: "2026-06-16"`, ids `sleep-2026-06-16` / `resting_hr-2026-06-16` / `hrv-2026-06-16`.
> Report 3 accepted, then offer a `get_daily_summary` for the day.

---

## JOB 2 — QUERY ("how did I sleep", "what's my HRV trend", "summary")

Four read tools, each for a different question. None need confirmation.

- **`get_daily_summary({ date })`** — the headline "**how was my day**" read. Returns the day's
  workouts, sleep (night + naps), metrics (HRV / resting HR / steps), the **food log with macro
  totals** (folded in from the Nutrition add-on — see the soft-dep note), and a **calorie
  balance** (workout calories burned − calories ingested). Use it for *"summarize today /
  yesterday"*, *"how was my day"*.
- **`get_health_summary({ date | from, to })`** — per-type aggregates over a date or range:
  `sleep {count, avg_hours, avg_deep_hours, avg_rem_hours}`, `hrv {count, avg_ms}`, `resting_hr
  {count, avg_bpm}`, `steps {days, total, avg_per_day}`, `vo2max {count, latest}`, `workout
  {count, total_duration_min, total_calories, activities}`. Use it for *"my averages this week"*,
  *"how much did I sleep on average"*.
- **`get_health_trends({ days, type? })`** — daily series + deltas over the last N days (default
  7). Use it for *"is my HRV trending up"*, *"show my resting HR over two weeks"*.
- **`list_health_data({ type?, from?, to?, limit? })`** — the raw entries, newest first. Use it
  to inspect / verify individual rows (e.g. to find an id to delete in JOB 3).

> **Read these fields as the contract gives them** — `data.value` for metrics, `avg_ms` /
> `avg_bpm` / `avg_hours` in the summary, etc. Don't reach for `data.bpm` or `data.count`; those
> are the retired split-brain shape.

> **Soft dependency on Nutrition.** `get_daily_summary`'s food + calorie-balance section reads
> the Nutrition add-on's food log. This is a **soft** edge — if Nutrition isn't installed/enabled,
> that section is simply empty (the health side is unaffected). Don't tell the user health is
> broken because the food block is blank; if they want it, point them at the Nutrition & Chef
> add-on (`/nutrition-chef`).

---

## JOB 3 — FIX ("delete that bad entry", "remove the duplicate")

When an entry is wrong or duplicated, remove it with **`delete_health_data`**. It takes either
**`{ ids: [...] }`** (specific entries) or **`{ from, to }`** (a date range) — and it
**hard-removes** (no soft-archive; irreversible, unlike the board's soft `archive_case`). Deletes
are add-on-gated like pushes.

- **To fix wrong VALUES**, you usually don't delete — **re-push the same id** with the corrected
  data (JOB 1 dedup-by-id overwrites in place). Reach for `delete_health_data` to remove a row
  that **shouldn't exist at all** (a bogus reading, a duplicate, a test entry).
- **Find the id first** with `list_health_data` (filter by `type` / date) so you delete exactly
  the right row.
- A **range** delete (`{ from, to }`) is **destructive and broad** — in approval mode, lay out
  exactly what it will sweep (run a `list_health_data` over the same window first and show the
  count) and get a yes before firing.

> **Example.** *"delete that duplicate sleep entry from the 14th"* → `list_health_data({ type:
> "sleep_night", from: "2026-06-14", to: "2026-06-14" })` to find the id → `delete_health_data({
> ids: ["sleep-2026-06-14-dup"] })`. Report it removed and the new `total`.

---

## JOB 4 — VAULT ("save my health summary to the vault")

Archive a health report into the knowledge base. This is a **two-step** flow — the fitness MCP
**composes**, the vault MCP **persists**.

**1. Compose — `ingest_health_to_vault({ days? })`.** It composes a Markdown health summary of
the last N days (default 7) and returns `{ vault_ingest_content, domain: "life", instruction }`.
It **does NOT write to the vault itself** — it's an ungated read that just builds the report.

**2. Persist — hand it to the `vault` MCP.** Take the returned `vault_ingest_content` and pass it
as the **`content`** argument (with **`domain: "life"`**) to the **`vault`** MCP's **`ingest`**
tool. The vault ingest is **async** — submit, then poll **`ingest_status`** to a terminal state;
never re-submit an in-flight job (see `/vault-operations`). Report the vault job's outcome once it
lands.

Use this for *"save my health summary to my knowledge base"*, *"log this week's training to the
vault"*. The compose step is an ungated read; the vault write is governed by the vault add-on.

---

## Conventions (guardrails recap)

- **`fitness` MCP only, via the tools, for health DATA.** Never `bash`/`curl`. The board UI
  (`/fitness/health`) is the read twin; you do the ingestion + the reads + the fixes + the vault
  archive.
- **The add-on must be ENABLED for writes.** A disabled add-on 404s every write ("Not found — the
  fitness add-on may be disabled.") while reads stay open — tell the user to flip it on at
  **/addons**; you don't enable it yourself.
- **Mode (STEP 0):** auto → just do it; approval → confirm **bulk** writes (a big backfill) and
  **destructive** ones (`delete_health_data`, a date-range delete) **in chat** before firing. A
  single write is low-stakes either way. **There is no pending/propose queue** — confirmation is
  conversational.
- **Canonical taxonomy, always.** Seven types (`workout`, `sleep_night`, `sleep_nap`, `hrv`,
  `resting_hr`, `steps`, `vo2max`); the metric goes in **`data.value`** (sleep = hours, with
  stages in `data.metadata`); workouts carry `activity` + `duration_min` on `data`. `ts` =
  `YYYY-MM-DD` for daily/sleep, full ISO for a workout. Stable unique `id` per logical entry so a
  re-push **overwrites** (idempotent no-op on an identical re-push). Never use
  `data.bpm`/`data.count`/`data.ms`. Entries older than 90 days **auto-purge** on write.
- **Reads:** `get_daily_summary` (the day, incl. nutrition + calorie balance), `get_health_summary`
  (per-type aggregates over a range), `get_health_trends` (the series), `list_health_data` (raw
  rows). Read the contract field names, not the producer's shape.
- **Fixes are HARD.** `delete_health_data` has no soft-archive — it's irreversible. Prefer a
  **re-push of the same id** to correct values; delete only to remove a row that shouldn't exist.
  Find the id with `list_health_data` first; confirm range deletes in approval mode.
- **Vault is two steps.** `ingest_health_to_vault` (compose, ungated read) **then** the `vault`
  MCP's `ingest` with `domain: "life"` (the actual write — async, poll `ingest_status`).
- **Soft dependency on Nutrition.** The food + calorie-balance parts of `get_daily_summary` read
  the Nutrition add-on; if it's off, that section is just empty — not a fault. Point the user at
  `/nutrition-chef` if they want it.
- **NEVER invent biometric numbers.** Only log what the user (or their export) gives you — never
  fabricate an HRV, a sleep duration, or a resting HR. If a value is missing, ask or omit; don't
  guess a vital sign.
- **NOT MEDICAL ADVICE on any interpretation.** Reading back a low HRV / poor sleep / elevated
  resting HR is an informational estimate — **say so**, and **defer abnormal symptoms, chest
  pain, injury, illness, pregnancy, or an under-18 user to a physician / qualified clinician**
  (recommend they consult one; never diagnose from the data).
- **Scope.** Plans → **fitness-training-plan**; reviews → **fitness-weekly-review**; briefs →
  **fitness-pre-workout-brief**; correlations → **fitness-correlations**; the athlete profile →
  **fitness-athlete-profile**. This skill is data-plane only.
- **Report** what landed: the **accepted / duplicates / purged** counts on a push, the day's
  summary + calorie balance or the trend direction on a read, the removed row + new `total` on a
  fix, and the vault job outcome on an archive — and that the ingested data **feeds the coaching
  skills and the `/fitness/health` dashboard**.
