---
name: nutrition-mcp-setup
description: Stand up the `nutrition` MCP for the "Nutrition & Chef" add-on on a new machine and wire it into both Claude clients — the simplest of the optional add-ons (a pure thin fetch-wrapper over the board's /api/nutrition/* routes, like the calendar server; NO sidecar, NO external repo, all in-repo at mcp/nutrition-server). It is exposed to Claude Code via a supergateway + launchd BRIDGE on $NUTRITION_BRIDGE_PORT/:8007 and to Claude Cowork Desktop as a direct stdio command, and the add-on must be ENABLED (Settings.addons.nutrition.enabled) for its 14 tools' WRITES to land + its /nutrition nav to appear. Use when setting up the nutrition/chef add-on on a new machine, when Cowork or Code can't see the `nutrition` server, when the nutrition bridge (:8007) is down, when log_food / plan_meal / add_pantry_item write but the board 404s them, or when enabling/disabling the Nutrition & Chef add-on.
---

# Nutrition & Chef MCP setup (the simplest add-on — thin fetch-wrapper bridge :8007)

## Why this exists / architecture
`nutrition` is the **first built-in add-on** ("Nutrition & Chef" — food log + pantry + meal
plan). Unlike the openwhispr / whatsapp add-ons it has **no external repo and no sidecar**: the
server lives **in this Cos checkout** at `mcp/nutrition-server/server.mjs`, and it is the **simplest
archetype in the whole system** — a **thin `fetch` wrapper** over the board's `/api/nutrition/*`
HTTP routes on `CRM_BASE_URL`, exactly like the **calendar** server. It makes **no LLM calls** and
needs **no secret**; the *intelligence* (estimating calories/macros) lives in the **operator skill**
(`/nutrition-chef`), not here — the MCP just stores numbers.

It is a **single Node stdio process** and registers into Cos the same two ways the core servers do:

- **Claude Code** reaches it over **HTTP** via a **supergateway + launchd BRIDGE on `:8007`**
  (`$NUTRITION_BRIDGE_PORT`, label `com.chiefofstaff.mcp-nutrition`, IN `.mcp.json`).
- **Claude Cowork Desktop** spawns it as a **direct stdio `command` entry** in
  `claude_desktop_config.json` — identical to how mcp-bridge-setup wires board/calendar/etc.

```
Claude Code   ──HTTP──> localhost:8007/mcp ──supergateway(launchd)──> node nutrition-server (stdio)
                                                                          │ fetch (actor: agent)
                                                                          └──HTTP──> board /api/nutrition/* (:3000)
Cowork Desktop ──spawns stdio directly──────────────────────────────────> node nutrition-server   (§4)
```

> **This is an ADD-ON — its WRITES are GATED, its READS are open.** The "Nutrition & Chef" add-on
> must be **ENABLED** (`Settings.addons.nutrition.enabled` in `cases.json`) for **writes** to land.
> A disabled add-on **404s every write** (the board surfaces it here as a `Not found.` tool error)
> while every **GET read stays open**, and its 3 nav pages 404 + hide. Enabling is itself a step
> (§6) — flip it from the board's **`/addons`** catalog (or `PATCH /api/addons/nutrition`).

This add-on's one process (alongside mcp-bridge-setup's four core servers + two sidecars, and the
optional openwhispr / whatsapp add-ons):
| process | what runs | env | bridge port | launchd label | in `.mcp.json`? |
|---|---|---|---|---|---|
| nutrition (MCP bridge) | `node mcp/nutrition-server/server.mjs` via supergateway | `CRM_BASE_URL` (the board) | 8007 | `com.chiefofstaff.mcp-nutrition` | **yes** (`http://localhost:8007/mcp`) |

**Tools (14):** food log — `log_food`, `list_food_log`, `get_food_log`, `update_food_log`,
`delete_food_log`; pantry — `read_pantry`, `add_pantry_item`, `update_pantry_item`,
`remove_pantry_item`; meal plan — `plan_meal`, `list_meal_plan`, `get_meal_plan`,
`update_meal_plan`, `remove_meal_plan`. The 5 reads (`list_*`/`get_*`/`read_pantry`) are ungated;
the 9 writes are gated. See `mcp/nutrition-server/README.md` for the full contract.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
> `$BOARD_URL`, and the **nutrition keys** — `$NUTRITION_BRIDGE_PORT` (=`8007`) /
> `$NUTRITION_BRIDGE_URL` (=`http://localhost:8007`) — use those instead of hardcoding paths, the
> Homebrew prefix, your username, or the port.

## Prerequisites
- **Node + npm** (Homebrew) and the server's deps: `(cd mcp/nutrition-server && npm i)`. The server
  imports the shared `packages/mcp-kit` by RELATIVE path, so no workspace install is needed.
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for **Claude Code**
  (`:8007`), exactly as in mcp-bridge-setup.
- **The board** reachable at `CRM_BASE_URL` (default `http://localhost:3000`). The server is a pure
  wrapper over the board's `/api/nutrition/*` routes — there is no other backend, no external app,
  no pairing, no login. (Unlike whatsapp/openwhispr, there is **nothing external** to install.)

Run the loader preamble as the first line of every shell block below — it exports `$REPO_ROOT`,
`$NODE_BIN`, `$BREW_PREFIX`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
`$BOARD_URL`, the bridge port/URL, etc., so nothing below is hardcoded. `$U=$(id -u)` is derived
inline where `launchctl` needs it.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

## Steps

### 1. Confirm the config + install the server's deps
The bridge port is a `cos.env` key (the loader seeds the `8007` default when absent). Confirm it,
and install the server's deps:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
echo "NUTRITION_BRIDGE_PORT=$NUTRITION_BRIDGE_PORT  ($NUTRITION_BRIDGE_URL)"   # expect 8007
(cd "$REPO_ROOT/mcp/nutrition-server" && npm i >/dev/null 2>&1)
```
> `NUTRITION_BRIDGE_PORT` is already in `config/cos.env.example` + `config/load-config.sh` (default
> **8007**, between whatsapp `:8006` and the search sidecar `:8008`). If `8007` is taken on this
> machine, change it in `config/cos.env` and re-render §3/§4.
- **CHECKPOINT** — the port resolves and the server's deps are present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  test "${NUTRITION_BRIDGE_PORT:-}" = 8007 && echo "port OK (or note your override)"
  ls "$REPO_ROOT/mcp/nutrition-server/server.mjs" && echo "server present"
  ```

### 2. Verify the stdio server runs
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
CRM_BASE_URL="$BOARD_URL" "$NODE_BIN" "$REPO_ROOT/mcp/nutrition-server/server.mjs"   # Ctrl-C
# prints "nutrition MCP server v1 ready (tools: log_food, list_food_log, …; CRM_BASE_URL=…)"
```
- **CHECKPOINT** — the ready line prints the 14 tool names and echoes the `CRM_BASE_URL` it will
  talk to. (This only proves the server boots; §3 proves the bridge serves it, §7 proves a tool
  round-trips against the board.)

### 3. Ensure the `.mcp.json` nutrition http entry (Claude Code)
The repo already ships the `nutrition` http entry in `$REPO_ROOT/.mcp.json` (it was added in an
earlier phase). Confirm it points at the `:8007` bridge — do **not** clobber the other servers:
```json
{ "mcpServers": {
  "nutrition": { "type": "http", "url": "http://localhost:8007/mcp" }
}}
```
- **CHECKPOINT** — the entry is present alongside the core servers:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"nutrition"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json nutrition entry OK"
  ```
  If it is somehow missing, add the one entry above (merged into the existing `mcpServers`).

### 4. Install the launchd BRIDGE (`:8007`)
Install from the **committed template**
`mcp/nutrition-server/deploy/com.chiefofstaff.mcp-nutrition.plist.template` — same pattern as the
guardsvc/vault/whatsapp templates — substituting the loader's absolute paths + the bridge port
(launchd cannot expand `$VARS`, so the rendered plist carries literal values):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
mkdir -p "$REPO_ROOT/mcp/logs"
sed -e "s#__BREW_PREFIX__#$BREW_PREFIX#g" \
    -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__NUTRITION_BRIDGE_PORT__#${NUTRITION_BRIDGE_PORT:-8007}#g" \
  "$REPO_ROOT/mcp/nutrition-server/deploy/com.chiefofstaff.mcp-nutrition.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-nutrition.plist"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-nutrition 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-nutrition.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-nutrition
```
The template runs supergateway DIRECTLY around the node child (no launch wrapper — like
board/calendar, UNLIKE vault, because this server needs **no secret**). Its only env is:
- `PATH` starting with `$BREW_PREFIX/bin` (launchd can't see an nvm/asdf shim),
- `CRM_BASE_URL=http://localhost:3000` (the board; pinned so it doesn't depend on the launchd cwd),
- `COS_MCP_IDLE_EXIT_MS=300000` — the idle-exit **OPT-IN**, set **ONLY here** (the bridge), never in
  the direct-stdio Cowork config (see Gotchas).

- **CHECKPOINT** — an MCP `initialize` on `:8007` returns `serverInfo.name == "nutrition"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$NUTRITION_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"nutrition"' && echo "nutrition bridge OK"
  ```

### 5. Register Cowork (direct stdio)
`.mcp.json` (§3) covers **Claude Code**. **Claude Cowork Desktop** registers **differently**:
`claude_desktop_config.json` (`$COWORK_CONFIG`) accepts **stdio `command` servers only** (an HTTP
`url` is rejected — the same validated rule as mcp-bridge-setup §5). Cowork spawns the node server
itself. Write it with a **backup-first node merge** that preserves the other servers + `preferences`
and refreshes only the `nutrition` entry from the **resolved** loader values — mirroring
mcp-bridge-setup's Cowork merge exactly:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # resolves NODE_BIN/REPO_ROOT/BOARD_URL/COWORK_CONFIG from cos.env
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env;
const server = {
  command: E.NODE_BIN,
  args: [`${E.REPO_ROOT}/mcp/nutrition-server/server.mjs`],
  env: { CRM_BASE_URL: E.BOARD_URL || 'http://localhost:3000' },   // the board; NO secret, NO idle-exit here
};
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
cfg.mcpServers = { ...(cfg.mcpServers||{}), nutrition: server };   // refresh OURS; keep other servers + preferences intact
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');             // back up before write
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
```
- **Absolute `node` path** (`$NODE_BIN`, from the loader): Claude Desktop's spawn env, like
  launchd's, lacks Homebrew on `PATH`.
- **Do NOT set `COS_MCP_IDLE_EXIT_MS` in the Cowork entry** — Cowork holds one long-lived stdio
  child for the session; the idle-exit opt-in belongs only in the §4 bridge plist (Gotchas).
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `nutrition`
  appears in Cowork's tools.
- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"nutrition"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.nutrition?0:1)' \
    && echo "Cowork config OK"
  ```

### 6. ENABLE the add-on (the gate — writes 404 until you do this)
The plumbing is up, but the add-on ships **DISABLED**: until you enable it, every WRITE 404s and the
`/nutrition` nav + pages are hidden. Flip it on — either the **`/addons` UI toggle** (with the board
app running) or the API (the toggle the UI calls):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/nutrition" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' ; echo
# → {"addon":{"id":"nutrition","enabled":true}, "version":<n>}
```
Enabling flips `Settings.addons.nutrition.enabled` to `true` in `cases.json`, bumps `db.version` →
SSE, so the sidebar's **Add-ons** nav group + the three `/nutrition/*` pages light up live (no
reload), and writes start landing.
- **CHECKPOINT** — the catalog reports it enabled (and the bridge reachable):
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s "$BOARD_URL/api/addons" | grep -o '"id":"nutrition"[^}]*"enabled":true' && echo "add-on enabled"
  ```

### 7. End-to-end verify (a tool call round-trips through the board)
Confirm the whole add-on works from the MCP surface, not just the ports — and that the gate is live:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# (a) a GATED write round-trips now the add-on is enabled — log_food mints a FOOD-id:
curl -s -X POST "$NUTRITION_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"log_food","arguments":{"date":"2026-06-13","slot":"lunch","description":"setup smoke test"}}}' \
  | grep -o 'Logged FOOD-[0-9]*' && echo "write round-trips (add-on enabled)"
# (b) an UNGATED read works regardless — list_food_log:
curl -s -X POST "$NUTRITION_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_food_log","arguments":{"date":"2026-06-13"}}}' \
  | grep -o 'Food log' && echo "read works"
```
Delete the smoke-test entry afterwards (`delete_food_log` with the FOOD-id from (a)), or leave it —
it's harmless. If you call (a) BEFORE §6 you'll see `Not found.` — that's the gate working, not a
failure; enable the add-on and retry.
- **CHECKPOINT** — `log_food` returns `Logged FOOD-<n>`, `list_food_log` returns `Food log …`, and
  both clients see `nutrition` after a ⌘Q reopen. The day-to-day driving (estimating calories,
  planning a week, linking a meal to the calendar) is then owned by **`/nutrition-chef`** — that
  skill owns the operation; this one only proves the plumbing.

### 8. (Optional) confirm `mcp/ensure-bridges.sh` brings it up
`nutrition` is **already wired** into `mcp/ensure-bridges.sh` as an **OPTIONAL** bridge (`"nutrition
${NUTRITION_BRIDGE_PORT:-8007}"` in the service list; in the `openwhispr|whatsapp|whatsappbridge|nutrition`
skip-if-no-plist case), so `npm run dev/start` brings it up with the rest **only when the plist
exists** — a machine without the add-on is skipped silently (no `WARN … DOWN` about `:8007`). No
edit needed; just confirm:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$REPO_ROOT/mcp/ensure-bridges.sh" | grep -i nutrition   # expect: "[mcp] nutrition bridge up on :8007"
```

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-nutrition   # restart the bridge
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-nutrition   # stop the bridge
tail -f mcp/logs/nutrition.err.log                                   # supergateway / server log
```
**Disable the add-on (keep the plumbing):** flip it off — the nav + pages hide and writes 404
again, but the bridge stays loaded and the data stays on disk + readable:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/nutrition" -H 'Content-Type: application/json' -d '{"enabled":false}' ; echo
```

## --uninstall (remove the add-on plumbing — the inverse of §3–§6)
Tear the bridge + registrations down (a machine that won't run nutrition). This is the inverse of
the install; it does **NOT** delete data (see the data-purge note below):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
# 1. Flag the add-on OFF (writes 404, nav hides) — do this first so the surface is dormant:
curl -s -X PATCH "$BOARD_URL/api/addons/nutrition" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null 2>&1 || true
# 2. Stop + remove the launchd bridge:
launchctl bootout gui/$U/com.chiefofstaff.mcp-nutrition 2>/dev/null || true
rm -f "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-nutrition.plist"
# 3. Drop the Cowork entry (backup-first node merge; preserves the other servers + preferences):
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env, p = E.COWORK_CONFIG;
if (fs.existsSync(p)) {
  const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
  if (cfg.mcpServers) delete cfg.mcpServers.nutrition;
  fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers||{}).join(', '));
}
NODE
# 4. Drop the .mcp.json entry (backup-first; keep the other servers):
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env, p = `${E.REPO_ROOT}/.mcp.json`;
const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
if (cfg.mcpServers) delete cfg.mcpServers.nutrition;
fs.copyFileSync(p, p + '.bak');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('.mcp.json mcpServers ->', Object.keys(cfg.mcpServers||{}).join(', '));
NODE
echo "Uninstalled the nutrition bridge + both registrations. ⌘Q + reopen Cowork to drop it from the tool list."
```
> The repo SHIPS the `.mcp.json` nutrition entry and the `ensure-bridges.sh` line; removing them
> from a tracked file leaves a local diff. If you intend to permanently un-ship the add-on (not just
> this machine), do it in a commit. For a per-machine opt-out, leaving the plist uninstalled is
> enough — `ensure-bridges.sh` skips nutrition silently when no plist exists, so a stray `.mcp.json`
> entry pointing at a dead `:8007` is harmless (Claude Code just shows the server as unreachable).

> **SEPARATE — purge the data (DESTRUCTIVE, explicit, opt-in).** Uninstall leaves the
> `foodLogs` / `pantryItems` / `mealPlanEntries` arrays in `board/data/cases.json` untouched (so a
> re-enable finds your history). To actually **erase** the nutrition data, edit those three arrays
> to `[]` in the store — there is no API to bulk-delete them; do it by hand (or one-by-one via
> `delete_food_log` / `remove_pantry_item` / `remove_meal_plan`). The store is **backed up daily**
> (the arrays ride `cases.json` in the encrypted off-site backup), so take a fresh backup first if
> you want a restore point, and know the purge is irreversible once the retention sweep rolls past
> it. This is intentionally NOT part of `--uninstall` — disabling/removing the plumbing must never
> silently destroy a user's food/pantry/meal history.

## Gotchas (read before editing)
- **The add-on must be ENABLED for writes; reads are always open.** The gate is
  `Settings.addons.nutrition.enabled` in `cases.json` (`assertAddonEnabled` inside the board's
  `mutate()` lock). A disabled add-on 404s every WRITE (surfaced as a `Not found.` tool error) and
  hides/404s the `/nutrition/*` pages, but GET reads (`list_*`, `get_*`, `read_pantry`) stay open
  and the **`/addons` catalog link stays reachable**. So the classic "log_food keeps failing with
  Not found." is almost always *the add-on is off* (§6), not a bridge fault — check `/api/addons`.
- **The estimation INTELLIGENCE is NOT in the MCP.** The 14 tools just store the numbers you give
  them; the MCP never estimates calories/macros. That judgment lives in the operator skill
  (`/nutrition-chef`). Don't expect `log_food` to fill in calories from a description — pass them.
- **`COS_MCP_IDLE_EXIT_MS` lives ONLY in the bridge plist, never in the Cowork config.** mcp-kit's
  idle-exit is OFF by default so Cowork's long-lived stdio child never dies on idle; the §4
  supergateway bridge opts in (`300000`) to reap supergateway's leaked idle stateless child. Setting
  it in the Cowork entry would manifest as the dreaded "server transport closed unexpectedly". Same
  rule as every other bridge (see mcp-bridge-setup → "Why bridges set COS_MCP_IDLE_EXIT_MS").
- **No sidecar, no external repo, no secret.** Unlike whatsapp (Go + Python, external checkout,
  QR pairing) and openwhispr (external app store) and vault (Agent SDK + `ANTHROPIC_API_KEY`),
  nutrition is the **calendar archetype**: an in-repo Node `fetch` wrapper that only needs the board
  on `CRM_BASE_URL`. There is nothing to clone, build, pair, or authenticate.
- **The board must be reachable on `CRM_BASE_URL`.** Every tool is a `fetch` to `/api/nutrition/*`.
  If the board app isn't up on `:3000` (or wherever `CRM_BASE_URL` points), tool calls fail with a
  connection error — start the board (`cd board && npm run dev`).
- **Port `8007` must be free** (`lsof -nP -iTCP:8007 -sTCP:LISTEN`). It sits between whatsapp `:8006`
  and the search sidecar `:8008`. A foreign process on it breaks §4 — change `NUTRITION_BRIDGE_PORT`
  in `cos.env` and re-render §3/§4.
- **launchd cannot expand `$VARS`.** As with every Cos plist, the **rendered** plist in
  `~/Library/LaunchAgents` carries **literal absolute paths** (`sed`-substituted from the loader in
  §4) and a `PATH` that starts with `$BREW_PREFIX/bin` — launchd never inherits your login shell and
  can't see an nvm/asdf shim. The template invokes supergateway by its **absolute**
  `$BREW_PREFIX/bin/supergateway` path; the inner `--stdio "node …/server.mjs"` child resolves
  `node` via that `$BREW_PREFIX/bin`-leading `PATH` (supergateway's own `#!/usr/bin/env node` shebang
  needs it too), which is why the `PATH` placeholder is load-bearing.
- **The node/simdjson + pm2 gotchas in mcp-bridge-setup apply here too** — same Node, same
  supergateway, same launchd supervisor. If the bridge dies with a `libsimdjson` dyld error after a
  `brew install`, `brew reinstall node`. Don't reintroduce pm2 (the template notes pm2 6.x can't
  fork on this machine — launchd owns the lifecycle).
