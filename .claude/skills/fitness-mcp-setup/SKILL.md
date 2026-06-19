---
name: fitness-mcp-setup
description: Stand up the `fitness` MCP for the "Fitness" add-on on a new machine and wire it into both Claude clients — an in-repo thin fetch-wrapper over the board's /api/fitness/* routes (like the nutrition/calendar servers). Its writes are add-on-gated (attributed to the agent via `x-actor`) and its reads are open. It is exposed to Claude Code via a supergateway + launchd BRIDGE on $FITNESS_BRIDGE_PORT/:8011 and to Claude Cowork Desktop as a direct stdio command, and the add-on must be ENABLED (Settings.addons.fitness.enabled) for its writes to land + its /fitness + /fitness/health nav to appear. Use when setting up the fitness add-on on a new machine, when Cowork or Code can't see the `fitness` server, when the fitness bridge (:8011) is down, when any write 404s (add-on disabled), or when enabling/disabling the Fitness add-on.
---

# Fitness MCP setup (thin fetch-wrapper bridge :8011)

## Why this exists / architecture
`fitness` is the **second built-in add-on** ("Fitness" — Apple Watch health ingestion +
dashboard at `/fitness/health`, plus the athlete training profile + AI coach at `/fitness`). Like
**nutrition**, it has **no external repo and no sidecar**: the server lives **in this Cos checkout**
at `mcp/fitness-server/server.mjs`, and it is the same **thin `fetch` wrapper** archetype over the
board's `/api/fitness/*` HTTP routes on `CRM_BASE_URL`. It makes **no LLM calls** — the *coaching*
intelligence (training plans, weekly reviews, pre-workout briefs) lives on the board's `/api/fitness/*`
routes (server-side Claude calls) and in the operator skill (`/fitness-coach`), not here.

Like nutrition, **every write is add-on-gated** — attributed to the agent via the `x-actor` header
and blocked only when the add-on is disabled. The Apple-Watch ingest endpoint
(`POST /api/fitness/push`) is the same: the MCP's `push_health_data` lands a batch of canonical
entries, gated by the add-on toggle exactly like every other write.

It is a **single Node stdio process** and registers into Cos the same two ways the core servers do:

- **Claude Code** reaches it over **HTTP** via a **supergateway + launchd BRIDGE on `:8011`**
  (`$FITNESS_BRIDGE_PORT`, label `com.chiefofstaff.mcp-fitness`, IN `.mcp.json`).
- **Claude Cowork Desktop** spawns it as a **direct stdio `command` entry** in
  `claude_desktop_config.json` — identical to how mcp-bridge-setup wires board/calendar/etc.

```
Claude Code   ──HTTP──> localhost:8011/mcp ──supergateway(launchd)──> node fitness-server (stdio)
                                                                          │ fetch (x-actor:agent)
                                                                          └──HTTP──> board /api/fitness/* (:3000)
Cowork Desktop ──spawns stdio directly──────────────────────────────────> node fitness-server   (§5)
```

> **This is an ADD-ON — its WRITES are GATED, its READS are open.** The "Fitness" add-on
> must be **ENABLED** (`Settings.addons.fitness.enabled` in `cases.json`) for **writes** to land. A
> disabled add-on **404s every write** (the board surfaces it here as a `Not found — the fitness
> add-on may be disabled.` tool error) while every **GET read stays open**, and its `/fitness` +
> `/fitness/*` nav pages 404 + hide. Enabling is itself a step (§6) — flip it from the board's
> **`/addons`** catalog (or `PATCH /api/addons/fitness`).

This add-on's one process (alongside mcp-bridge-setup's four core servers + two sidecars, and the
optional openwhispr / whatsapp / nutrition add-ons):
| process | what runs | env | bridge port | launchd label | in `.mcp.json`? |
|---|---|---|---|---|---|
| fitness (MCP bridge) | `node mcp/fitness-server/server.mjs` via supergateway | `CRM_BASE_URL` (the board) | 8011 | `com.chiefofstaff.mcp-fitness` | **yes** (`http://localhost:8011/mcp`) |

**Tools (18):** ingest — `push_health_data` (canonical entries), `delete_health_data`; reads —
`list_health_data`, `get_health_summary`, `get_daily_summary` (health + nutrition for one day),
`get_health_trends`, `ingest_health_to_vault` (composes a report for the vault MCP); **athlete
profile + computed signals** — `get_athlete_profile`, `set_athlete_profile` (the goal/level/
availability/sports/equipment singleton; the board validates the enums),
`get_form_score` (board-computed daily readiness 0-100), `get_correlations` (board-computed sleep-vs-
performance correlation over N days); **coaching artifacts** (v13) — `save_training_plan`,
`save_weekly_review`, `save_pre_workout_brief`, `save_correlation_report` (the four `save_*` writers,
one per kind), `list_coaching_artifacts`, `get_coaching_artifact`, `delete_coaching_artifact`. **Gating:
all 8 writes are add-on-gated** (blocked 404 when the add-on is disabled, attributed to the agent via
`x-actor`); the 10 reads are ungated. So the `save_*` / `set_athlete_profile` writes let Cowork persist
a profile + a generated plan / review / brief / report **without the board's Anthropic key**. See
`mcp/fitness-server/README.md` for the full contract.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
> `$BOARD_URL`, and the **fitness keys** — `$FITNESS_BRIDGE_PORT` (=`8011`) /
> `$FITNESS_BRIDGE_URL` (=`http://localhost:8011`) — use those instead of hardcoding paths, the
> Homebrew prefix, your username, or the port.

## Prerequisites
- **Node + npm** (Homebrew) and the server's deps: `(cd mcp/fitness-server && npm i)`. The server
  imports the shared `packages/mcp-kit` by RELATIVE path, so no workspace install is needed.
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for **Claude Code**
  (`:8011`), exactly as in mcp-bridge-setup.
- **The board** reachable at `CRM_BASE_URL` (default `http://localhost:3000`). The server is a pure
  wrapper over the board's `/api/fitness/*` routes — there is no other backend, no external app, no
  pairing, no login. (Unlike whatsapp/openwhispr, there is **nothing external** to install.)

Run the loader preamble as the first line of every shell block below — it exports `$REPO_ROOT`,
`$NODE_BIN`, `$BREW_PREFIX`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
`$BOARD_URL`, the bridge port/URL, etc., so nothing below is hardcoded. `$U=$(id -u)` is derived
inline where `launchctl` needs it.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

## Steps

### 1. Confirm the config + install the server's deps
The bridge port is a `cos.env` key (the loader seeds the `8011` default when absent). Confirm it,
and install the server's deps:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
echo "FITNESS_BRIDGE_PORT=$FITNESS_BRIDGE_PORT  ($FITNESS_BRIDGE_URL)"   # expect 8011
(cd "$REPO_ROOT/mcp/fitness-server" && npm i >/dev/null 2>&1)
```
> `FITNESS_BRIDGE_PORT` is already in `config/cos.env.example` + `config/load-config.sh` (default
> **8011**, after the search/guardsvc/whatsapp-Go sidecars `:8008`–`:8010`). If `8011` is taken on
> this machine, change it in `config/cos.env` and re-render §3/§4.
- **CHECKPOINT** — the port resolves and the server's deps are present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  test "${FITNESS_BRIDGE_PORT:-}" = 8011 && echo "port OK (or note your override)"
  ls "$REPO_ROOT/mcp/fitness-server/server.mjs" && echo "server present"
  ```

### 2. Verify the stdio server runs
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
CRM_BASE_URL="$BOARD_URL" "$NODE_BIN" "$REPO_ROOT/mcp/fitness-server/server.mjs"   # Ctrl-C
# prints "fitness MCP server v1 ready (tools: push_health_data, list_health_data, …; CRM_BASE_URL=…)"
```
- **CHECKPOINT** — the ready line prints the 18 tool names and echoes the `CRM_BASE_URL` it will talk
  to. (This only proves the server boots; §3 proves the bridge serves it, §7 proves a tool
  round-trips against the board.)

### 3. Ensure the `.mcp.json` fitness http entry (Claude Code)
`.mcp.json` is a **generated** artifact of the service manifest (rendered from
`mcp/fitness-server/fitness.service.json` by `scripts/gen-mcp-json.mjs`, CI-verified with `--check`)
— **never hand-edit it**. The repo already ships the `fitness` http entry pointing at the `:8011`
bridge:
```json
{ "mcpServers": {
  "fitness": { "type": "http", "url": "http://localhost:8011/mcp" }
}}
```
- **CHECKPOINT** — the entry is present and in sync with the manifest:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"fitness"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json fitness entry OK"
  node "$REPO_ROOT/scripts/gen-mcp-json.mjs" --check && echo ".mcp.json in sync with the manifest"
  ```
  If it is somehow missing or drifted, regenerate it from the manifest (do not edit by hand):
  `node "$REPO_ROOT/scripts/gen-mcp-json.mjs"` (see `mcp/CLAUDE.md`).

### 4. Install the launchd BRIDGE (`:8011`)
The plist is **generated from the co-located descriptor** `mcp/fitness-server/fitness.service.json` by
`scripts/gen-launchd.mjs` (see `mcp/CLAUDE.md`) — there is **no committed `*.plist.template` to `sed`**.
The generator resolves the descriptor against the loader's absolute paths + bridge port (launchd can't
expand `$VARS`, so the rendered plist carries literal values) and, on macOS, renders + bootout →
bootstrap → kickstart in one step:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install fitness
```
The bridge runs supergateway DIRECTLY around the node child (no launch wrapper — like
board/calendar/nutrition, because this server needs **no secret**). The generated plist's env (from
the descriptor) is:
- `PATH` starting with `$BREW_PREFIX/bin` (launchd can't see an nvm/asdf shim),
- `CRM_BASE_URL=${BOARD_URL}` (the board; from `env` in the descriptor, pinned so it doesn't depend on the launchd cwd),
- `COS_MCP_IDLE_EXIT_MS=300000` — the idle-exit **OPT-IN** (`idleExit:true`), on the bridge only, never in
  the direct-stdio Cowork config (see Gotchas).

- **CHECKPOINT** — an MCP `initialize` on `:8011` returns `serverInfo.name == "fitness"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"fitness"' && echo "fitness bridge OK"
  ```

### 5. Register Cowork (direct stdio)
`.mcp.json` (§3) covers **Claude Code**. **Claude Cowork Desktop** registers **differently**:
`claude_desktop_config.json` (`$COWORK_CONFIG`) accepts **stdio `command` servers only** (an HTTP
`url` is rejected — the same validated rule as mcp-bridge-setup). Cowork spawns the node server
itself. The Cowork entry is **generated from the same descriptor** by `scripts/gen-cowork-config.mjs`
— a **backup-first** merge that preserves the other servers + `preferences` and refreshes only the
`fitness` entry from the resolved loader values, omitting `idleExit` on the Cowork entry automatically:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-cowork-config.mjs" fitness
```
- **Absolute `node` path** (`$NODE_BIN`, from the loader): Claude Desktop's spawn env, like
  launchd's, lacks Homebrew on `PATH` — the generator writes it.
- **No `COS_MCP_IDLE_EXIT_MS` on the Cowork entry** — the generator never sets it; Cowork holds one
  long-lived stdio child, so the idle-exit opt-in belongs only in the §4 bridge plist.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `fitness`
  appears in Cowork's tools.
- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"fitness"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.fitness?0:1)' \
    && echo "Cowork config OK"
  ```

### 6. ENABLE the add-on (the gate — writes 404 until you do this)
The plumbing is up, but the add-on ships **DISABLED**: until you enable it, every WRITE 404s and the
`/fitness` + `/fitness/*` nav + pages are hidden. Flip it on — either the **`/addons` UI toggle** (with
the board app running) or the API (the toggle the UI calls):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/fitness" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' ; echo
# → {"addon":{"id":"fitness","enabled":true}, "version":<n>}
```
Enabling flips `Settings.addons.fitness.enabled` to `true` in `cases.json`, bumps `db.version` → SSE,
so the sidebar's **Add-ons** nav group + the `/fitness` overview + `/fitness/health` + the four
`/fitness/*` coaching pages light up live (no reload), and writes start landing.
> **Soft dependency on Nutrition.** The fitness manifest declares `dependsOn: [{id:"nutrition",
> required:false}]` — the `get_daily_summary` + weekly-review fold `db.foodLogs` into the coaching
> context. This is a SOFT edge: it degrades gracefully when Nutrition is off (the food side just
> reads empty), so you do **not** need the Nutrition add-on enabled for Fitness to work — it just
> works *better* with it (the catalog surfaces this as "works better with Nutrition").
- **CHECKPOINT** — the catalog reports it enabled:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s "$BOARD_URL/api/addons" | grep -o '"id":"fitness"[^}]*"enabled":true' && echo "add-on enabled"
  ```

### 7. End-to-end verify (a tool call round-trips through the board)
Confirm the whole add-on works from the MCP surface, not just the ports — and that the gate is live:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# (a) a GATED write round-trips now the add-on is enabled — push one canonical entry:
curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"push_health_data","arguments":{"entries":[{"id":"setup-smoke-1","ts":"2026-06-16","type":"steps","data":{"value":8000}}]}}}' \
  | grep -o '"accepted"' && echo "write round-trips (add-on enabled)"
# (b) an UNGATED read works regardless — list_health_data:
curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_health_data","arguments":{"type":"steps"}}}' \
  | grep -o 'setup-smoke-1' && echo "read works"
# (c) clean up the smoke-test entry (also exercises the gated delete write):
curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_health_data","arguments":{"ids":["setup-smoke-1"]}}}' \
  | grep -o '"deleted"' && echo "delete round-trips (cleanup done)"
```
If you call (a) BEFORE §6 you'll see `Not found — the fitness add-on may be disabled.` — that's the
gate working, not a failure; enable the add-on and retry.
- **CHECKPOINT** — `push_health_data` returns an `accepted` count, `list_health_data` echoes the
  entry, `delete_health_data` returns `deleted`, and both clients see `fitness` after a ⌘Q reopen. The
  day-to-day driving (ingesting from the iPhone, reading summaries/trends, setting the athlete
  profile, generating a training plan / weekly review / pre-workout brief, pushing a plan to the
  calendar, ingesting to the vault) is then owned by **`/fitness-coach`** — that skill owns the
  operation; this one only proves the plumbing.

### 8. (Optional) confirm `mcp/ensure-bridges.sh` brings it up
`mcp/ensure-bridges.sh` is a **thin consumer** of the service manifest: it reads
`node mcp/service-manifest.mjs --probe-list` rather than a hardcoded list, so `fitness` appears
automatically from its co-located descriptor `mcp/fitness-server/fitness.service.json` — **no
service-list entry and no skip-`case` to maintain**. Because the descriptor carries `addon:"fitness"`,
the probe treats the bridge as **OPTIONAL** and skips it silently on a board that never installed it
(no `WARN … DOWN` about `:8011`), while `npm run dev/start` brings it up with the rest once the plist
exists. No edit needed; just confirm:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$REPO_ROOT/mcp/ensure-bridges.sh" | grep -i fitness   # expect: "[mcp] fitness bridge up on :8011"
```

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-fitness   # restart the bridge
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-fitness   # stop the bridge
tail -f mcp/logs/fitness.err.log                                   # supergateway / server log
```
**Disable the add-on (keep the plumbing):** flip it off — the nav + pages hide and writes 404 again,
but the bridge stays loaded and the data stays on disk + readable:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/fitness" -H 'Content-Type: application/json' -d '{"enabled":false}' ; echo
```

## --uninstall (remove the add-on plumbing — the inverse of §3–§6)
Tear the bridge + registrations down (a machine that won't run fitness). This is the inverse of the
install; it does **NOT** delete data (see the data-purge note below):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
# 1. Flag the add-on OFF (writes 404, nav hides) — do this first so the surface is dormant:
curl -s -X PATCH "$BOARD_URL/api/addons/fitness" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null 2>&1 || true
# 2. Stop + remove the launchd bridge:
launchctl bootout gui/$U/com.chiefofstaff.mcp-fitness 2>/dev/null || true
rm -f "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-fitness.plist"
# 3. Drop the Cowork entry (backup-first node merge; preserves the other servers + preferences):
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env, p = E.COWORK_CONFIG;
if (fs.existsSync(p)) {
  const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
  if (cfg.mcpServers) delete cfg.mcpServers.fitness;
  fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers||{}).join(', '));
}
NODE
# 4. Leave .mcp.json ALONE — it is a GENERATED, CI-checked artifact (rendered from the descriptor).
#    Hand-deleting the fitness entry would drift it from the manifest and fail `gen-mcp-json.mjs --check`.
#    A stray http entry pointing at a dead :8011 is harmless (Claude Code just shows it unreachable).
echo "Uninstalled the fitness bridge + the Cowork entry. ⌘Q + reopen Cowork to drop it from the tool list."
```
> `.mcp.json` is a **generated artifact** of the manifest (rendered from
> `mcp/fitness-server/fitness.service.json` by `gen-mcp-json.mjs`, CI-checked) — do **not** hand-delete
> the fitness entry on a tracked file (it would fail `--check`). There is **no `ensure-bridges.sh`
> line** to remove either — the probe is fully manifest-derived. For a per-machine opt-out, leaving
> the plist uninstalled is enough — the probe skips fitness silently (its descriptor's `addon:` field),
> so a stray `.mcp.json`
> entry pointing at a dead `:8011` is harmless (Claude Code just shows the server as unreachable).

> **SEPARATE — purge the data (DESTRUCTIVE, explicit, opt-in).** Uninstall leaves the
> `healthEntries` array AND the `athleteProfile` singleton in `board/data/cases.json` untouched (so a
> re-enable finds your history). To actually **erase** the health data, set `healthEntries` to `[]`
> and remove `athleteProfile` in the store by hand (or delete entries via `delete_health_data` — but
> there is no API to drop the profile). The store is **backed up daily** (the arrays ride
> `cases.json` in the encrypted off-site backup), so take a fresh backup first if you want a restore
> point. This is intentionally NOT part of `--uninstall` — disabling/removing the plumbing must never
> silently destroy a user's biometric history.

## Gotchas (read before editing)
- **The add-on must be ENABLED for writes; reads are always open.** The gate is
  `Settings.addons.fitness.enabled` in `cases.json` (`assertAddonEnabled` inside the board's
  `mutate()` lock). A disabled add-on 404s every WRITE (surfaced as `Not found — the fitness add-on
  may be disabled.`) and hides/404s the `/fitness` + `/fitness/*` pages, but GET reads stay open and
  the **`/addons` catalog link stays reachable**. So "push_health_data keeps failing with Not found."
  is almost always *the add-on is off* (§6), not a bridge fault — check `/api/addons`.
- **The COACHING intelligence is NOT in the MCP — the `save_*` tools PERSIST, they don't generate.**
  The 18 tools push/read health data, read/set the athlete profile, read the board-computed form
  score + correlations, compose a vault report, and **persist/list/delete already-built
  coaching artifacts**. The four `save_*` tools (`save_training_plan` / `save_weekly_review` /
  `save_pre_workout_brief` / `save_correlation_report`) take a structured artifact the CALLER built
  (the board's `/api/fitness/*` Claude routes, or Cowork generating it itself) and store it on
  `db.coachingArtifacts` — they make **no LLM call**. So an agent can author + persist an artifact
  via `save_*` (no board Anthropic key needed — `save_*` is add-on-gated only), but no
  MCP tool "thinks up" a plan; the generation lives in the board routes + the operator skill
  (`/fitness-coach`).
- **`COS_MCP_IDLE_EXIT_MS` lives ONLY in the bridge plist, never in the Cowork config.** mcp-kit's
  idle-exit is OFF by default so Cowork's long-lived stdio child never dies on idle; the §4
  supergateway bridge opts in (`300000`) to reap supergateway's leaked idle stateless child. Setting
  it in the Cowork entry manifests as the dreaded "server transport closed unexpectedly". Same rule
  as every other bridge.
- **No sidecar, no external repo, no secret.** Unlike whatsapp (Go + Python, external checkout, QR
  pairing) and openwhispr (external app store), fitness is the **nutrition archetype**: an in-repo
  Node `fetch` wrapper that needs only the board on `CRM_BASE_URL`. There is nothing to clone, build,
  or pair.
- **The board must be reachable on `CRM_BASE_URL`.** Every tool is a `fetch` to `/api/fitness/*`. If
  the board app isn't up on `:3000` (or wherever `CRM_BASE_URL` points), tool calls fail with a
  connection error — start the board (`cd board && npm run dev`).
- **Port `8011` must be free** (`lsof -nP -iTCP:8011 -sTCP:LISTEN`). It sits after the search/guardsvc
  sidecars (`:8008`/`:8009`) and the WhatsApp Go bridge (`:8010`). A foreign process on it breaks §4
  — change `FITNESS_BRIDGE_PORT` in `cos.env` and re-render §3/§4.
- **launchd cannot expand `$VARS`.** As with every Cos plist, the **rendered** plist in
  `~/Library/LaunchAgents` carries **literal absolute paths** + a `PATH` that starts with
  `$BREW_PREFIX/bin` (launchd never inherits your login shell and can't see an nvm/asdf shim). The
  generated plist invokes supergateway by its **absolute** `$BREW_PREFIX/bin/supergateway` path; the
  inner `--stdio "node …/server.mjs"` child resolves `node` via that `$BREW_PREFIX/bin`-leading
  `PATH`, which is why the `PATH` is load-bearing.
- **The node/simdjson + pm2 gotchas in mcp-bridge-setup apply here too** — same Node, same
  supergateway, same launchd supervisor. If the bridge dies with a `libsimdjson` dyld error after a
  `brew install`, `brew reinstall node`. Don't reintroduce pm2 — launchd owns the lifecycle (the pm2
  mechanism has been retired).
