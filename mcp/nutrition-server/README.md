# nutrition MCP server (v1)

A stdio MCP server (registry name **`nutrition`**) for the Cos **"Nutrition & Chef"**
add-on — the **food-log** vertical. Every tool wraps the board's `/api/nutrition/log`
HTTP routes over `fetch` on `CRM_BASE_URL`; the server never shells out to `curl`. Used by
the router and skills so the food log can be driven from the sandboxed Cowork VM (which
can't call the API directly).

The MCP is the **agent's twin** of the board's food-log UI: both write through the same
HTTP API. The UI writes are attributed to **`human`**; every write this server makes is
attributed to **`agent`** (see [Actor attribution](#actor-attribution)).

This is an **add-on**, not a core server. Phase 1 ships the **food-log** tools only; the
**pantry** and **meal-plan** verticals are later phases.

## This is an add-on — writes are GATED

The "Nutrition & Chef" add-on must be **enabled** for food-log **writes** to succeed. The
enabled flag lives in the board's store (`Settings.addons.nutrition.enabled` in
`cases.json`) and is toggled from the board's **`/addons`** catalog (or
`PATCH /api/addons/nutrition { "enabled": true }`).

- **Writes** (`log_food`, `update_food_log`, `delete_food_log`) on a **disabled** add-on are
  rejected by the board with a 404, surfaced here as a **`Not found.`** tool error. Enable
  the add-on from `/addons` and retry.
- **Reads** (`list_food_log`, `get_food_log`) are **NOT gated** — a disabled add-on's data
  stays viewable.

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

Front this server with supergateway on the host, on port **8007**. The committed
LaunchAgent template (`deploy/com.chiefofstaff.mcp-nutrition.plist.template`) does exactly
this; see the `/nutrition-mcp-setup` skill for the runbook. Point `.mcp.json` at the bridge:

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
