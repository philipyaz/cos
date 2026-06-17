# nutrition MCP server (v1)

A stdio MCP server (registry name **`nutrition`**) for the Cos **"Nutrition & Chef"**
add-on. Every tool wraps the board's `/api/nutrition/*` HTTP routes over `fetch` on
`CRM_BASE_URL`; the server never shells out to `curl`. Used by the router and skills so the
nutrition verticals can be driven from the sandboxed Cowork VM (which can't call the API
directly).

The MCP is the **agent's twin** of the board's nutrition UI: both write through the same
HTTP API. The UI writes are attributed to **`human`**; every write this server makes is
attributed to **`agent`** (see [Actor attribution](#actor-attribution)).

This is an **add-on**, not a core server. It covers four verticals, all on the same tool
shape + gate model: the **food-log** (`FOOD-<n>`, `/api/nutrition/log`), the **pantry**
(`PANTRY-<n>`, `/api/nutrition/pantry`), the **meal-plan** (`MEAL-<n>`,
`/api/nutrition/plan`), and the **weight-loss** vertical — a weigh-in series
(`WEIGHT-<n>`, `/api/nutrition/weight`), a goal/profile **singleton**
(`/api/nutrition/goal`), and a derived read-only **targets** projection
(`/api/nutrition/targets`, computed by `board/lib/nutrition-targets.ts`).

## This is an add-on — writes are GATED

The "Nutrition & Chef" add-on must be **enabled** for food-log **writes** to succeed. The
enabled flag lives in the board's store (`Settings.addons.nutrition.enabled` in
`cases.json`) and is toggled from the board's **`/addons`** catalog (or
`PATCH /api/addons/nutrition { "enabled": true }`).

- **Writes** (`log_food`, `update_food_log`, `delete_food_log`, the pantry + meal-plan
  writes, and the weight-loss writes `log_weight` / `set_nutrition_goal`) on a **disabled**
  add-on are rejected by the board with a 404, surfaced here as a **`Not found.`** tool
  error. Enable the add-on from `/addons` and retry.
- **Reads** (`list_food_log`, `get_food_log`, the pantry + meal-plan reads, and the
  weight-loss reads `list_weights` / `get_nutrition_goal` / `get_nutrition_targets`) are
  **NOT gated** — a disabled add-on's data stays viewable.

## Actor attribution

Every **write** (anything that isn't a `GET`) is attributed to the agent two ways, for
robustness against either route convention:

- an **`x-actor: agent`** request header, and
- **`{ "actor": "agent" }`** folded into the JSON body (added even to bodyless writes
  like a `DELETE`).

You never pass `actor` yourself — the server adds it.

## The food-log model

Defined in `board/lib/types.ts` as `FoodLogEntry` (schema v9 — purely additive over v8;
old files still read, `foodLogs` defaults to `[]`). Enums: `MealSlot` / `VALID_MEAL_SLOT`
and `HealthRating` / `VALID_HEALTH_RATING`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `FOOD-<n>`, minted like `CASE-<n>` / `EVT-<n>` |
| `date` | `string` | ISO calendar day `YYYY-MM-DD` (the day the meal was eaten) |
| `slot` | `MealSlot` | **required** — `breakfast` \| `lunch` \| `dinner` \| `snack` |
| `description` | `string` | **required**, non-empty — what was eaten |
| `items` | `string[]?` | optional itemised components (`['2 eggs', 'toast']`) |
| `calories` | `number` | kcal for the entry |
| `protein` / `carbs` / `fat` | `number?` | optional macros, in grams |
| `health` | `HealthRating?` | optional `green` \| `amber` \| `red` health flag |
| `estimated` | `boolean` | `true` === the calorie count is a guess (defaults `true`) |
| `note` | `string?` | optional |
| `createdAt` / `updatedAt` | `string` | ISO |

## The weight-loss model

Defined in `board/lib/types.ts` (`WeightEntry`, `NutritionGoal`) and projected by the pure
engine `board/lib/nutrition-targets.ts` (schema v10 — purely additive over v9). Storage is
**always kilograms**; `weightUnit` / `weightLb` are display/entry conveniences only.

A **weigh-in** (`WeightEntry`) — one per day, the `date` is the upsert key:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `WEIGHT-<n>`, minted like `FOOD-<n>` |
| `date` | `string` | ISO calendar day `YYYY-MM-DD` — **UNIQUE per day** (the upsert key) |
| `weightKg` | `number` | canonical storage unit is **always kilograms** |
| `note` | `string?` | optional |
| `createdAt` / `updatedAt` | `string` | ISO |

The **goal / body profile** (`NutritionGoal`) — a **singleton** (no id, set/replace):

| Field | Type | Notes |
| --- | --- | --- |
| `sex` | `male` \| `female` | **required** — BMR sex constant |
| `age` | `number` | **required**, years — BMR input |
| `heightCm` | `number` | **required** — BMR + BMI input |
| `activity` | `sedentary`\|`light`\|`moderate`\|`very_active`\|`extra_active` | **required** — TDEE multiplier |
| `targetWeightKg` | `number` | **required** — the goal weight (kg) |
| `rateKgPerWeek` | `number` | DESIRED loss rate (default `0.5`); the engine **clamps** it (≤1%/wk, ≤1.0 kg/wk) |
| `weightUnit` | `kg` \| `lb` | display/entry preference only (default `kg`); storage stays kg |
| `createdAt` / `updatedAt` | `string` | ISO |

The **targets** projection is read-only and derived (never stored) — see
[`get_nutrition_targets`](#get_nutrition_targets). It is **always resolvable**: when the
goal or a weigh-in is missing it returns a "needs configuration" envelope rather than
erroring, and it always carries a leading **not-medical-advice** note. It is informational
only — not medical advice.

## Tools

`[x]` marks optional args.

### Reads

#### `list_food_log([from], [to], [slot], [date])`
`GET /api/nutrition/log`. Lists entries **grouped by day** with a **per-day calorie rollup**,
one line per entry (slot · description · kcal · macros · health · ~est). Read-only (works even
when the add-on is disabled). `from` (inclusive) / `to` (exclusive) bound a half-open day
window as `YYYY-MM-DD`; `date` narrows to one exact day; `slot` restricts to a meal slot. With
no filters, returns **all** entries (sorted chronologically by day).

#### `get_food_log(id)`
`GET /api/nutrition/log/{id}`. Loads a single entry by id (e.g. `FOOD-1`) and renders day,
slot, description, items, calories, macros, health flag, estimated/measured, and note. Read-only.
Unknown id → tool error.

### Food-log lifecycle

#### `log_food(date, slot, description, [items], [calories], [protein], [carbs], [fat], [health], [estimated], [note])`
`POST /api/nutrition/log`. Logs a meal. **Gated** — the add-on must be enabled.

- `date` **(required)** — the calendar day the meal was eaten, `YYYY-MM-DD`.
- `slot` **(required)** — `breakfast | lunch | dinner | snack`.
- `description` **(required)**, non-empty — what was eaten.
- `calories` — kcal; `protein` / `carbs` / `fat` — optional macros in grams.
- `health` — `green | amber | red`, optional flag.
- `estimated` — defaults `true` (the calorie count is a guess); set `false` for a measured value.
- Returns the minted `FOOD-id`.

#### `update_food_log(id, [date], [slot], [description], [calories], [protein], [carbs], [fat], [health], [note])`
`PATCH /api/nutrition/log/{id}`. Updates fields — pass only what you want to change. **Gated**.
A null/empty value on an optional macro / `note` / `health` clears it.

#### `delete_food_log(id)`
`DELETE /api/nutrition/log/{id}`. Hard-removes the entry (food-log entries have no soft-archive).
**Gated**.

### Weight-loss reads

#### `list_weights([from], [to])`
`GET /api/nutrition/weight`. Lists weigh-ins one line per day **in date order (oldest first,
newest last)** with each weight in kg (and a pounds twin), then the first→last delta as a
trend at the foot. Read-only (works even when the add-on is disabled). `from` (inclusive) /
`to` (exclusive) bound a half-open day window as `YYYY-MM-DD`; with no filters, returns
**all** weigh-ins.

#### `get_nutrition_goal()`
`GET /api/nutrition/goal`. Loads the goal/profile **singleton** and renders sex, age, height,
activity, target weight, desired loss rate, and the weight-unit preference. Read-only. Returns
**"not set"** (no error) when no goal has been configured yet.

#### `get_nutrition_targets()`
`GET /api/nutrition/targets`. The agent-facing **"how am I doing"** read. Computes the full
plan over the goal + weigh-ins + food log and renders: current / trend / target weight +
remaining, estimated **BMR/TDEE** and the **measured** (feedback-loop) TDEE with the basis in
use, the recommended **daily calorie target** + **protein/fat/carb** macros, the effective
deficit, **BMI** now vs at target, the **ETA** to target, today's calories used/remaining, the
**guardrail flags** (always including the leading *not-medical-advice* note), and the
**off-track days** — every logged day whose adherence is `over` / `well_over` (most recent
first). Read-only. When the goal or a weigh-in is missing it reports what still needs
configuring instead of numbers. **It is informational only — not medical advice.**

### Weight-loss lifecycle

#### `log_weight(date, [weightKg], [weightLb], [note])`
`POST /api/nutrition/weight`. Records a weigh-in. **Gated** — the add-on must be enabled.

- `date` **(required)** — the calendar day, `YYYY-MM-DD`. **Upserts by day**: logging the same
  day again **updates** that entry rather than adding a second.
- Provide the weight **exactly one way**: `weightKg` (kilograms) **or** `weightLb` (pounds) —
  pounds are converted to kg server-side (storage is always kilograms). Passing both, or
  neither, is a tool error.
- `note` — optional.
- Returns the `WEIGHT-id` and whether the entry was **created** (HTTP 201) or an existing day
  **updated** (HTTP 200).

#### `set_nutrition_goal(sex, age, heightCm, activity, targetWeightKg, [rateKgPerWeek], [weightUnit])`
`PUT /api/nutrition/goal`. Sets (creates or **replaces**) the goal/profile **singleton** —
there is exactly one. **Gated**.

- `sex` **(required)** — `male | female`.
- `age` **(required)**, years, `> 0`.
- `heightCm` **(required)**, `> 0`.
- `activity` **(required)** — `sedentary | light | moderate | very_active | extra_active`.
- `targetWeightKg` **(required)**, kg, `> 0`.
- `rateKgPerWeek` — DESIRED weekly loss, default `0.5`; the targets engine **clamps** it for
  safety (≤1%/wk of body weight, ≤1.0 kg/wk).
- `weightUnit` — `kg | lb`, a display/entry preference only (storage stays kg); default `kg`.

## Config

`CRM_BASE_URL` — base URL of the board. Default `http://localhost:3000`.

## Install

```bash
cd mcp/nutrition-server && npm install
```

## `.mcp.json` entry (registry name: `nutrition`)

The bridge port for this server is **`8007`** (board = `8001`, openwhispr = `8002`,
calendar = `8003`, guard = `8004`, vault = `8005`, whatsapp = `8006`).

### Option A — HTTP via supergateway (the bridged setup)

Front this server with supergateway on the host, on port **8007**. The LaunchAgent plist is
generated from `mcp/nutrition-server/nutrition.service.json` by `scripts/gen-launchd.mjs` (see
[`mcp/CLAUDE.md`](../CLAUDE.md)); see the `/nutrition-mcp-setup` skill for the runbook. The
`.mcp.json` entry below is generated by `scripts/gen-mcp-json.mjs` (committed + CI-checked):

```json
{
  "mcpServers": {
    "nutrition": { "type": "http", "url": "http://localhost:8007/mcp" }
  }
}
```

### Option B — local stdio (no supergateway, for testing on your own machine)

Claude Code spawns the server itself over stdio:

```json
{
  "mcpServers": {
    "nutrition": {
      "command": "node",
      "args": ["./mcp/nutrition-server/server.mjs"],
      "env": { "CRM_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

## Verify

With the board dev server running (`npm run dev` on :3000):

```bash
cd mcp/nutrition-server && node test-client.mjs
```

It enables the add-on (`PATCH /api/addons/nutrition`), spawns the server over stdio, lists
tools, then exercises the food-log lifecycle — `log_food` → `get_food_log` →
`list_food_log` → `update_food_log` → `delete_food_log` — printing each result and its
`isError` flag, plus a negative (missing-description) check. The `FOOD` id is parsed from
the log result, never hardcoded.
