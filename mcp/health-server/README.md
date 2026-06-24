# Health MCP Server

MCP server for Apple Watch HealthKit data ingestion into the Cos board and vault.

Receives **sleep, HRV, steps, workouts, VO2 max, and resting heart rate** data
via the board's HTTP API, stores it in a dedicated `data/health.json` file, and
exposes query/trend/vault-ingest tools to Claude.

## Architecture

```
iPhone (Shortcut / Health Auto Export)
    │ POST /api/health/push + x-health-token header
    ▼
Board API (:3000)  ──►  data/health.json  (90-day retention)
    ▲
Health MCP (:8011)  ──►  tools for Claude (list, summary, trends, vault ingest)
```

## Data types

| Type | Key fields |
|------|-----------|
| `sleep` | `duration_min`, `deep_min`, `rem_min`, `awake_min`, `bed_time`, `wake_time` |
| `hrv` | `avg_ms`, `samples` |
| `steps` | `count`, `distance_km` |
| `workout` | `activity`, `duration_min`, `calories`, `avg_hr`, `distance_km` |
| `vo2max` | `value` (mL/kg/min) |
| `resting_hr` | `bpm` |

## MCP tools

| Tool | Description |
|------|-------------|
| `push_health_data` | Push a batch of HealthKit entries (token-gated) |
| `list_health_data` | List entries with optional type/date filters |
| `get_health_summary` | Aggregated summary for a date or range |
| `delete_health_data` | Delete by IDs or date range (token-gated) |
| `get_health_trends` | Daily trends over last N days |
| `ingest_health_to_vault` | Compose a health report for vault ingestion |

## Setup

### 1. Generate a push token

Pick any random string (e.g. `openssl rand -hex 20`) and add it to `config/cos.env`:

```bash
HEALTH_PUSH_TOKEN="your-random-token-here"
HEALTH_BRIDGE_PORT="8011"
```

### 2. Install dependencies

```bash
cd mcp/health-server
npm install
```

### 3. Wire the bridge

**Windows (pm2):** Add the health process to `ecosystem.config.cjs`, then:

```bash
pm2 start ecosystem.config.cjs
```

**macOS (launchd):** Use the plist template in `deploy/` (same pattern as
nutrition-server).

### 4. Register in `.mcp.json`

```json
"health": {
  "type": "http",
  "url": "http://localhost:8011/mcp"
}
```

### 5. Test

```bash
cd mcp/health-server
HEALTH_PUSH_TOKEN="your-token" node test-client.mjs
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
   For each sample type, build an entry object:

   ```json
   {
     "entries": [
       {
         "id": "iphone-sleep-2026-06-15",
         "ts": "2026-06-15T07:00:00Z",
         "type": "sleep",
         "data": {
           "duration_min": 450,
           "deep_min": 85,
           "rem_min": 110,
           "awake_min": 18,
           "bed_time": "2026-06-14T23:15:00Z",
           "wake_time": "2026-06-15T07:00:00Z"
         }
       },
       {
         "id": "iphone-hrv-2026-06-15",
         "ts": "2026-06-15T07:30:00Z",
         "type": "hrv",
         "data": { "avg_ms": 42, "samples": 8 }
       },
       {
         "id": "iphone-steps-2026-06-15",
         "ts": "2026-06-15T23:59:00Z",
         "type": "steps",
         "data": { "count": 8432, "distance_km": 6.1 }
       },
       {
         "id": "iphone-rhr-2026-06-15",
         "ts": "2026-06-15T07:30:00Z",
         "type": "resting_hr",
         "data": { "bpm": 58 }
       },
       {
         "id": "iphone-vo2max-2026-06-15",
         "ts": "2026-06-15T07:30:00Z",
         "type": "vo2max",
         "data": { "value": 42.5 }
       }
     ]
   }
   ```

3. **Get Contents of URL** (action)
   - URL: `http://<your-pc-ip>:3000/api/health/push`
   - Method: POST
   - Headers:
     - `Content-Type`: `application/json`
     - `x-health-token`: `your-token-here`
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
1. Call `ingest_health_to_vault` (days: 7) to compose a health report
2. Pass the report to the vault MCP's `ingest` tool (domain: life)
3. The vault synthesizes it into `life/wiki/concepts/Health Dashboard.md`

## Retention

Entries older than 90 days are automatically purged on every push. The vault
holds the synthesized long-term knowledge.
