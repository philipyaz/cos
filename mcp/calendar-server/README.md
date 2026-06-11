# calendar MCP server (v1)

A stdio MCP server (registry name **`calendar`**) that creates and maintains **calendar
events / appointments** on the Cos board. Every tool wraps the board's
`/api/events` HTTP routes over `fetch` on `CRM_BASE_URL`; the server never shells out to
`curl`. Used by the router and skills so an appointment can be driven from the sandboxed
Cowork VM (which can't call the API directly).

The MCP is the **agent's twin** of the board UI: both write through the same HTTP API.
The UI writes are attributed to **`human`**; every write this server makes is attributed
to **`agent`** (see [Actor attribution](#actor-attribution)), so the case audit trail
(`event_linked` / `event_updated` / `event_unlinked`) records who did what.

The calendar is intentionally **basic** — title, day, optional time, description, location,
domain — and it lives **alongside** the board. The headline idea is the **link**: an event's
`caseId` is the **single source of truth** for the case↔event link, so an appointment can
**roll up under** the case it belongs to.

## The house guardrail — prefer linking to a case

**PREFER linking an appointment to an existing case.** This agent ALSO has the **`board`**
MCP: before creating a standalone event, call its **`search`** (and **`get_tree`**) FIRST to
find a matching case — by client/person, account number, or topic. If a strong match exists,
set **`caseId`** so the appointment rolls up under that case and its related data. If nothing
matches, create the event **STANDALONE** (omit `caseId`) and leave it as is. This guardrail is
baked into the `create_event` and `link_event` tool descriptions.

## Actor attribution

Every **write** (anything that isn't a `GET`) is attributed to the agent two ways, for
robustness against either route convention:

- an **`x-actor: agent`** request header, and
- **`{ "actor": "agent" }`** folded into the JSON body (added even to bodyless writes
  like a `DELETE`).

The board reads either signal and stamps the linked case's `activity[]` entry with
`actor: "agent"`. You never pass `actor` yourself — the server adds it.

## The calendar-event model

Defined in `board/lib/types.ts` as `CalendarEvent` (schema v4 — purely additive over v3;
old files still read, `events` defaults to `[]`). No new enums — `domain` reuses
`CaseDomain` / `VALID_DOMAIN`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `EVT-<n>`, minted like `CASE-<n>` / `M-<n>` |
| `title` | `string` | **required**, non-empty |
| `date` | `string` | ISO calendar day `YYYY-MM-DD` (the day it falls on; start day for a timed event) |
| `allDay` | `boolean` | defaults `false` |
| `startTime` | `string?` | `HH:MM` 24h, present when `!allDay` |
| `endTime` | `string?` | `HH:MM` 24h, optional |
| `description` | `string?` | optional |
| `location` | `string?` | optional |
| `caseId` | `string?` | **optional link to a `CaseRecord` — the single source of truth for the case↔event link** |
| `domain` | `CaseDomain?` | `work` \| `life` — optional/advisory (may mirror the linked case's domain) |
| `createdAt` / `updatedAt` | `string` | ISO |

## Tools

`[x]` marks optional args.

### Reads

#### `list_events([from], [to], [caseId], [domain])`
`GET /api/events`. Lists events as a compact one-line-per-event list (day · time-or-`all-day` ·
title · linked `caseId`). Read-only. `from` (inclusive) / `to` (exclusive) bound a half-open day
window as `YYYY-MM-DD`; `caseId` narrows to one case's events; `domain` restricts to `work` / `life`.
With no filters, returns **all** events (sorted chronologically by day then start time).

#### `get_event(id)`
`GET /api/events/{id}`. Loads a single event by id (e.g. `EVT-1`) and renders title, date,
time (or **all-day**), description, location, domain, and the **linked `caseId`** (or that it's
standalone). Unknown id → tool error.

### Event lifecycle

#### `create_event(title, date, [allDay], [startTime], [endTime], [description], [location], [caseId], [domain])`
`POST /api/events`. Creates an appointment.

- `title` **(required)**, non-empty.
- `date` **(required)** — the calendar day as `YYYY-MM-DD` (start day for a timed event).
- `allDay` — defaults `false`. For a timed event set `startTime` (`HH:MM` 24h) and optionally `endTime`.
- `domain` — `work | life`, advisory (may mirror the linked case's side).
- `caseId` — **PREFER setting this** to roll the event up under an existing case (see the guardrail
  above). An unknown `caseId` is **rejected with a 400** surfaced as a tool error.
- Returns the minted `EVT-id`, the day/time, and whether it linked or is standalone.

#### `update_event(id, [title], [date], [allDay], [startTime], [endTime], [description], [location], [domain], [caseId])`
`PATCH /api/events/{id}`. Updates fields — pass only what you want to change. `caseId` (re)links
the appointment to a case; **`caseId: null` UNLINKS it** (leaves it standalone). A non-empty
`caseId` that doesn't reference an existing case is rejected with a 400.

#### `delete_event(id)`
`DELETE /api/events/{id}`. Hard-removes the event (events have no soft-archive). If it was linked
to a case, that link is dropped — the case itself is untouched.

### Linking sugar

#### `link_event(id, [caseId])`
`PATCH /api/events/{id} { caseId }`. Sugar for the common case of rolling an appointment up under a
case. **PREFER linking** (see the guardrail): pass a `caseId` to link; pass `null`/empty (or omit) to
**unlink** it from any case. An unknown `caseId` is rejected with a 400.

## Config

`CRM_BASE_URL` — base URL of the board. Default `http://localhost:3000`.

## Install

```bash
cd mcp/calendar-server && npm install
```

## `.mcp.json` entry (registry name: `calendar`)

The bridge port for this server is **`8003`** (board = `8001`, openwhispr = `8002`,
search = `8008`).

### Option A — HTTP via supergateway (the bridged setup)

Front this server with supergateway on the host, on port **8003**. Add to your
`start-mcp-servers.sh`:

```bash
# start-mcp-servers.sh  (run on the host, outside the sandbox)
CRM_BASE_URL=http://localhost:3000 \
  supergateway --stdio "node /ABSOLUTE/PATH/TO/mcp/calendar-server/server.mjs" \
  --port 8003 --baseUrl /mcp &
```

Point `.mcp.json` at the bridge:

```json
{
  "mcpServers": {
    "calendar": { "type": "http", "url": "http://localhost:8003/mcp" }
  }
}
```

### Option B — local stdio (no supergateway, for testing on your own machine)

Claude Code spawns the server itself over stdio:

```json
{
  "mcpServers": {
    "calendar": {
      "command": "node",
      "args": ["./mcp/calendar-server/server.mjs"],
      "env": { "CRM_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

## Verify

With the board dev server running (`npm run dev` on :3000):

```bash
cd mcp/calendar-server && node test-client.mjs
```

It spawns the server over stdio, lists tools, then exercises the event lifecycle —
`create_event` → `get_event` → `list_events` → `update_event` → `link_event` (to a real case
if one is findable via the board, else it skips the link) → `delete_event` — printing each
result and its `isError` flag, plus a negative (missing-title) check. The `EVT` id is parsed
from the create result, never hardcoded.
