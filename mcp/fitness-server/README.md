# Fitness MCP Server

MCP server for the Cos **Fitness** add-on — Apple Watch HealthKit data
ingestion into the Cos board and vault.

A **thin fetch wrapper** over the board's `/api/fitness/*` HTTP routes
(`packages/mcp-kit` primitives, like the nutrition server): it holds no business
logic. Receives **workouts, sleep, HRV, steps, VO2 max, and resting heart rate**
data via the board's HTTP API. The board folds it onto the core store
(`db.healthEntries` in `cases.json`, 90-day retention) and exposes
query/trend/vault-ingest tools to Claude.

## Architecture

```
iPhone (Shortcut / Health Auto Export)
    │ POST /api/fitness/push + x-fitness-token header
    ▼
Board API (:3000)  ──►  cases.json (db.healthEntries, 90-day retention)
    ▲
Fitness MCP (:8011)  ──►  tools for Claude (list, summary, trends, vault ingest)
```

## Canonical data types

In lockstep with `board/lib/types.ts` `VALID_HEALTH_ENTRY_TYPE`. Per-day metric
aggregates live in `data.value`; the push route maps Health Auto Export metric
names onto these and stores unmapped names verbatim.

| Type | Key fields |
|------|-----------|
| `workout` | `activity`, `duration_min`, `calories?`, `avg_hr?`, `distance_km?` |
| `sleep_night` / `sleep_nap` | `value` (hours), `metadata.{deep,rem,core,awake,sleepStart,sleepEnd}` |
| `hrv` | `value` (ms) |
| `resting_hr` | `value` (bpm) |
| `steps` | `value` (count) |
| `vo2max` | `value` (mL/kg/min) |

## MCP tools

18 tools — 7 health-data tools, 4 athlete-profile / readiness / correlation tools, plus 7
stateful **coaching-artifact** tools (v13). The
coaching surfaces (training plan, weekly review, pre-workout brief, sleep/performance
correlations) are persisted on the board's core store (`db.coachingArtifacts`) and upserted
by `(kind, periodKey)`. The `save_*` tools are token-gated writes; the `list_*` / `get_*`
reads are ungated. An external agent (Claude Cowork) can create artifacts **without** the
board's Anthropic key — the `x-fitness-token` is the only credential.

| Tool | Description |
|------|-------------|
| `push_health_data` | Push a batch of HealthKit entries (token-gated) |
| `list_health_data` | List entries with optional type/date filters |
| `get_health_summary` | Aggregated summary for a date or range |
| `get_daily_summary` | Full daily health + nutrition summary (workouts, sleep, metrics, food, calorie balance) for one date |
| `delete_health_data` | Delete by IDs or date range (token-gated) |
| `get_health_trends` | Daily trends over last N days |
| `ingest_health_to_vault` | Fetch the board's composed health report (`GET /api/fitness/report`) for vault ingestion |
| `get_athlete_profile` | Read the athlete training-profile singleton (ungated) |
| `set_athlete_profile` | Create-or-replace the athlete profile (token-gated; board validates the enums) |
| `get_form_score` | Board-computed daily readiness ("form") score 0-100 with breakdown (ungated) |
| `get_correlations` | Board-computed sleep-vs-performance correlation + regression over N days; persists to history (ungated) |
| `save_training_plan` | Persist a weekly training plan (upsert by week; token-gated) |
| `save_weekly_review` | Persist a weekly review (upsert by week; token-gated) |
| `save_pre_workout_brief` | Persist a daily pre-workout readiness brief (upsert by date; token-gated) |
| `save_correlation_report` | Persist a sleep/performance correlation report (upsert by `<from>_<to>`; token-gated) |
| `list_coaching_artifacts` | List persisted coaching artifacts, newest-first (ungated; filter by kind/date) |
| `get_coaching_artifact` | Fetch one coaching artifact by id (ungated) |
| `delete_coaching_artifact` | Delete one coaching artifact by id (token-gated) |

## Setup

Run the `/fitness-mcp-setup` skill for the full runbook. In brief:

### 1. Generate a push token

Pick any random string (e.g. `openssl rand -hex 20`). The **token** is a secret, so
it goes in `config/secrets.env`; the **port** is public config in `config/cos.env`:

```bash
# config/secrets.env
FITNESS_PUSH_TOKEN="your-random-token-here"

# config/cos.env
FITNESS_BRIDGE_PORT="8011"
```

### 2. Install dependencies

```bash
cd mcp/fitness-server
npm install
```

### 3. Wire the bridge (macOS launchd + supergateway)

The launchd bridge is rendered from the co-located descriptor
`mcp/fitness-server/fitness.service.json` by `scripts/gen-launchd.mjs` (it
resolves the descriptor against `config/load-config.sh`, writes the plist with
literal paths/port, and does bootout → bootstrap → kickstart in one step). There
is no committed `*.plist.template` to `sed` — same manifest flow as every other
service (see [`mcp/CLAUDE.md`](../CLAUDE.md)). The descriptor declares
`secretWrapper: launch.sh`, so the wrapper sources `FITNESS_PUSH_TOKEN` from
`config/secrets.env` at spawn — the token is never baked into the plist:

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install fitness
```

### 4. Register in `.mcp.json` (generated)

`.mcp.json` is a generated artifact of the manifest — don't hand-edit it.
Regenerate (and CI-verify) the `fitness` http entry from the descriptor:

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-mcp-json.mjs"          # write; --check verifies in CI
# yields:  "fitness": { "type": "http", "url": "http://localhost:8011/mcp" }
```

### 5. Test

```bash
cd mcp/fitness-server
FITNESS_PUSH_TOKEN="your-token" node test-client.mjs
```

## iPhone Shortcut setup

Create an iOS Shortcut that runs on a schedule (or manually) to push HealthKit
data to the board.

### Shortcut steps

1. **Get Health Samples** (action: "Find Health Samples")
   - Type: Sleep Analysis
   - Start Date: last 24 hours
   - Repeat for: Heart Rate Variability, Step Count, Workouts, VO2 Max,
     Resting Heart Rate

2. **Build JSON** (action: "Text" or "Dictionary")
   For each sample type, build a canonical entry — metrics carry the per-day
   aggregate in `data.value`, and `ts` is the day (`YYYY-MM-DD`):

   ```json
   {
     "entries": [
       {
         "id": "iphone-sleep-2026-06-15",
         "ts": "2026-06-15",
         "type": "sleep_night",
         "data": {
           "value": 7.5,
           "metadata": {
             "deep": 1.4,
             "rem": 1.8,
             "core": 4.0,
             "awake": 0.3,
             "sleepStart": "2026-06-14T23:15:00Z",
             "sleepEnd": "2026-06-15T07:00:00Z"
           }
         }
       },
       {
         "id": "iphone-hrv-2026-06-15",
         "ts": "2026-06-15",
         "type": "hrv",
         "data": { "value": 42 }
       },
       {
         "id": "iphone-steps-2026-06-15",
         "ts": "2026-06-15",
         "type": "steps",
         "data": { "value": 8432 }
       },
       {
         "id": "iphone-rhr-2026-06-15",
         "ts": "2026-06-15",
         "type": "resting_hr",
         "data": { "value": 58 }
       },
       {
         "id": "iphone-vo2max-2026-06-15",
         "ts": "2026-06-15",
         "type": "vo2max",
         "data": { "value": 42.5 }
       }
     ]
   }
   ```

   > Tip: the easiest path is **Health Auto Export** — POST its native
   > `{ data: { metrics } }` / `{ data: { workouts } }` payloads straight to
   > `/api/fitness/push`; the board maps them onto the canonical taxonomy above.

3. **Get Contents of URL** (action)
   - URL: `http://<your-pc-ip>:3000/api/fitness/push`
   - Method: POST
   - Headers:
     - `Content-Type`: `application/json`
     - `x-fitness-token`: `your-token-here`
   - Request Body: the JSON from step 2

### Tips

- **Entry IDs** should be deterministic per day (e.g. `iphone-sleep-YYYY-MM-DD`)
  so re-running the shortcut the same day is idempotent (deduped by ID).
- **Network**: your iPhone must be on the same local network as the PC running
  the board. Use the PC's local IP (e.g. `192.168.1.x`).
- **Automation**: use iOS Shortcuts Automations to run this daily at a fixed
  time (e.g. 8:00 AM after waking up).
- **Health Auto Export** (third-party app): can POST HealthKit data on a
  schedule. Configure it to hit the same endpoint with the same JSON shape.

### Workout entries

For workouts, use a separate "Find Health Samples" for Workouts and map:

```json
{
  "id": "iphone-workout-2026-06-15-1",
  "ts": "2026-06-15T18:30:00Z",
  "type": "workout",
  "data": {
    "activity": "running",
    "duration_min": 35,
    "calories": 380,
    "avg_hr": 152,
    "distance_km": 5.2
  }
}
```

Activity names: use Apple's workout type names lowercase
(`running`, `cycling`, `swimming`, `walking`, `hiking`, `strength_training`, etc.).

## Vault ingestion

To persist health data in the vault, ask Claude:

> "Ingest my health data from the last 7 days into the vault"

Claude will:
1. Call `ingest_health_to_vault` (days: 7) — a thin forwarder that fetches the
   board's `GET /api/fitness/report?days=7`. The board composes the Markdown report
   from the canonical `summarize()` output; the MCP holds no composition logic.
2. Pass the returned `vault_ingest_content` to the vault MCP's `ingest` tool (domain: life)
3. The vault synthesizes it into `life/wiki/concepts/Health Dashboard.md`

## Retention

Entries older than 90 days are automatically purged on every push. The vault
holds the synthesized long-term knowledge.
