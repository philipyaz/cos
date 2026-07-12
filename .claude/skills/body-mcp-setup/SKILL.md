---
name: body-mcp-setup
description: Stand up the `body` MCP for the foundational "Body" add-on on a new machine and wire it into both Claude clients — an in-repo thin fetch-wrapper over the board's /api/body/* routes (like the nutrition/fitness servers). Body is the single owner of body identity, the weight + body-composition series, and the free-text objective that Nutrition + Fitness read. Its writes are add-on-gated (attributed to the agent via `x-actor`) and its reads are open. It is exposed to Claude Code via a supergateway + launchd BRIDGE on $BODY_BRIDGE_PORT/:8012 and to Claude Cowork Desktop as a direct stdio command. The add-on HARD AUTO-ENABLES whenever Nutrition or Fitness is enabled (so it is usually already on). Use when setting up the body add-on on a new machine, when Cowork or Code can't see the `body` server, when the body bridge (:8012) is down, when a body write 404s, or when wiring the /body surface.
---

# Body MCP setup (thin fetch-wrapper bridge :8012)

## Why this exists / architecture
`body` is the **foundational built-in add-on** — the single owner of **body identity** (sex / date of
birth / height / training status / whether you lift), the **weight + body-composition series**, and the
**free-text objective** (the goal). Nutrition & Chef and Fitness both **read** it cross-add-on (current
weight, target, training status, the goal). Like **nutrition** and **fitness**, it has **no external repo
and no sidecar**: the server lives **in this Cos checkout** at `mcp/body-server/server.mjs`, the same
**thin `fetch` wrapper** archetype over the board's `/api/body/*` HTTP routes on `CRM_BASE_URL`. It makes
**no LLM calls** — the board serves deterministic physiology **facts** via `/api/body/status` (BMR / TDEE
/ BMI / trend / fat-free mass), but it **never** computes a recommendation; the daily targets are
authored by the agent (the `nutrition-chef` skill → `save_nutrition_targets`).

Every write is add-on-gated — attributed to the agent via the `x-actor` header and blocked only when the
add-on is disabled. It is a **single Node stdio process** and registers into Cos the same two ways the
core servers do:

- **Claude Code** reaches it over **HTTP** via a **supergateway + launchd BRIDGE on `:8012`**
  (`$BODY_BRIDGE_PORT`, label `com.chiefofstaff.mcp-body`, IN `.mcp.json`).
- **Claude Cowork Desktop** spawns it as a **direct stdio `command` entry** in `claude_desktop_config.json`.

```
Claude Code   ──HTTP──> localhost:8012/mcp ──supergateway(launchd)──> node body-server (stdio)
                                                                          │ fetch (x-actor:agent)
                                                                          └──HTTP──> board /api/body/* (:3000)
Cowork Desktop ──spawns stdio directly──────────────────────────────────> node body-server   (§5)
```

> **This add-on HARD AUTO-ENABLES — it is usually already on.** Unlike nutrition/fitness (which ship
> disabled and need a manual toggle), **body auto-enables in the same write whenever Nutrition or Fitness
> is enabled** (a hard `dependsOn` cascade in `/api/addons/[id]`), because both consumers read body
> identity and are meaningless without it. So once you've enabled a consumer, body is on. It can also be
> enabled directly. Conversely, body **refuses to be disabled** (HTTP **409**) while a hard consumer
> (Nutrition/Fitness) is still enabled — disable the consumer first. Its **writes are GATED** and its
> **reads are open** exactly like the other add-ons; a disabled body 404s every write (`Not found.`) and
> hides/404s the `/body` page.

This add-on's one process (alongside the core servers + sidecars + the other add-ons):
| process | what runs | env | bridge port | launchd label | in `.mcp.json`? |
|---|---|---|---|---|---|
| body (MCP bridge) | `node mcp/body-server/server.mjs` via supergateway | `CRM_BASE_URL` (the board) | 8012 | `com.chiefofstaff.mcp-body` | **yes** (`http://localhost:8012/mcp`) |

**Tools (8):** identity — `get_body_profile`, `set_body_profile`; the free-text objective —
`get_body_objective`, `set_body_objective`; the weight + composition series — `log_weight` (upsert by
day; + optional bodyFatPct/leanMassKg/waistCm), `list_weights`, `delete_weight`; and the physiology
**baseline** — `get_body_status` (facts only, never a recommendation). **The 4 writes
(`set_body_profile` / `set_body_objective` / `log_weight` / `delete_weight`) are add-on-gated**
(blocked 404 when disabled, attributed to the agent via `x-actor`); the 4 reads are ungated. See
`mcp/body-server/README.md` for the full contract.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`, `$BREW_PREFIX`,
> `$NODE_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`, `$BOARD_URL`, and the **body
> keys** — `$BODY_BRIDGE_PORT` (=`8012`) / `$BODY_BRIDGE_URL` (=`http://localhost:8012`) — use those
> instead of hardcoding paths, the Homebrew prefix, your username, or the port.

## Prerequisites
- **Node + npm** (Homebrew) and the server's deps: `(cd mcp/body-server && npm i)`. The server imports
  the shared `packages/mcp-kit` by RELATIVE path, so no workspace install is needed to run it.
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for **Claude Code** (`:8012`).
- **The board** reachable at `CRM_BASE_URL` (default `http://localhost:3000`). The server is a pure
  wrapper over the board's `/api/body/*` routes — there is nothing external to install, pair, or log in to.

Run the loader preamble as the first line of every shell block below.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

## Steps

### 1. Confirm the config + install the server's deps
The bridge port is a `cos.env` key (the loader seeds the `8012` default when absent). Confirm it, and
install the server's deps:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
echo "BODY_BRIDGE_PORT=$BODY_BRIDGE_PORT  ($BODY_BRIDGE_URL)"   # expect 8012
(cd "$REPO_ROOT/mcp/body-server" && npm i >/dev/null 2>&1)
```
> `BODY_BRIDGE_PORT` is already in `config/cos.env.example` + `config/load-config.sh` (default **8012**,
> after the fitness bridge `:8011`). If `8012` is taken on this machine, change it in `config/cos.env` and
> re-render §3/§4.
- **CHECKPOINT** — the port resolves and the server is present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  test "${BODY_BRIDGE_PORT:-}" = 8012 && echo "port OK (or note your override)"
  ls "$REPO_ROOT/mcp/body-server/server.mjs" && echo "server present"
  ```

### 2. Verify the stdio server runs
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
CRM_BASE_URL="$BOARD_URL" "$NODE_BIN" "$REPO_ROOT/mcp/body-server/server.mjs"   # Ctrl-C
# prints "body MCP server v1 ready (tools: get_body_profile, set_body_profile, …; CRM_BASE_URL=…)"
```
- **CHECKPOINT** — the ready line prints the 8 tool names and echoes the `CRM_BASE_URL`. (This only
  proves the server boots; §3 proves the bridge serves it, §7 proves a tool round-trips.)

### 3. Ensure the `.mcp.json` body http entry (Claude Code)
`.mcp.json` is a **generated** artifact of the service manifest (rendered from
`mcp/body-server/body.service.json` by `scripts/gen-mcp-json.mjs`, CI-verified with `--check`) — **never
hand-edit it**. The repo already ships the `body` http entry pointing at the `:8012` bridge:
```json
{ "mcpServers": {
  "body": { "type": "http", "url": "http://localhost:8012/mcp" }
}}
```
- **CHECKPOINT** — the entry is present and in sync:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"body"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json body entry OK"
  node "$REPO_ROOT/scripts/gen-mcp-json.mjs" --check && echo ".mcp.json in sync with the manifest"
  ```
  If somehow missing or drifted, regenerate from the manifest (do not edit by hand):
  `node "$REPO_ROOT/scripts/gen-mcp-json.mjs"`.

### 4. Install the launchd BRIDGE (`:8012`)
The plist is **generated from the co-located descriptor** `mcp/body-server/body.service.json` by
`scripts/gen-launchd.mjs` (see `mcp/CLAUDE.md`) — there is **no committed `*.plist.template` to `sed`**.
On macOS the generator renders + bootout → bootstrap → kickstart in one step:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install body
```
The bridge runs supergateway DIRECTLY around the node child (no launch wrapper — this server needs **no
secret**). The generated plist's env (from the descriptor) is: a `PATH` starting with `$BREW_PREFIX/bin`,
`CRM_BASE_URL=${BOARD_URL}`, and `COS_MCP_IDLE_EXIT_MS=300000` (the idle-exit **OPT-IN**, on the bridge
only, never in the Cowork config).
- **CHECKPOINT** — an MCP `initialize` on `:8012` returns `serverInfo.name == "body"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$BODY_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"body"' && echo "body bridge OK"
  ```

### 5. Register Cowork (direct stdio)
**Claude Cowork Desktop** registers **differently** from Claude Code: `claude_desktop_config.json`
(`$COWORK_CONFIG`) accepts **stdio `command` servers only** (an HTTP `url` is rejected). The Cowork entry
is **generated from the same descriptor** by `scripts/gen-cowork-config.mjs` — a **backup-first** merge
that preserves the other servers + `preferences` and refreshes only the `body` entry, omitting `idleExit`
automatically:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-cowork-config.mjs" body
```
- **Absolute `node` path** (`$NODE_BIN`) — Claude Desktop's spawn env lacks Homebrew on `PATH`.
- **No `COS_MCP_IDLE_EXIT_MS` on the Cowork entry** — Cowork holds one long-lived stdio child.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `body` appears.
- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"body"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.body?0:1)' \
    && echo "Cowork config OK"
  ```

### 6. ENABLE the add-on (usually already on — the hard auto-enable)
Unlike the other add-ons, **body is normally already enabled** — enabling Nutrition or Fitness
**auto-enables body** in the same write (the hard `dependsOn` cascade). If you've set up either consumer,
skip this. To enable body **directly** (e.g. on a board with neither consumer on yet):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/body" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' ; echo
# → {"addon":{"id":"body","enabled":true}, "version":<n>}
```
Enabling flips `Settings.addons.body.enabled` to `true`, bumps `db.version` → SSE, so the **/body** nav +
page light up live and writes start landing.
> **You cannot disable body while Nutrition or Fitness is enabled** — `PATCH {"enabled":false}` returns
> **409** ("Cannot disable \"body\" while \"nutrition\"/\"fitness\" is enabled"). Disable the consumer(s)
> first. This keeps the invariant "a consumer is never pointing at a disabled provider".
- **CHECKPOINT** — the catalog reports it enabled:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s "$BOARD_URL/api/addons" | grep -o '"id":"body"[^}]*"enabled":true' && echo "add-on enabled"
  ```

### 7. End-to-end verify (a tool call round-trips through the board)
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# (a) a GATED write round-trips now the add-on is enabled — set the free-text objective:
curl -s -X POST "$BODY_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"set_body_objective","arguments":{"goalText":"setup smoke test","activity":"moderate"}}}' \
  | grep -o 'Objective set' && echo "write round-trips (add-on enabled)"
# (b) an UNGATED read works regardless — the physiology baseline facts:
curl -s -X POST "$BODY_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_body_status","arguments":{}}}' \
  | grep -o 'physiology' && echo "read works"
```
If you call (a) BEFORE §6 (and no consumer is on) you'll see `Not found.` — that's the gate working;
enable the add-on (or a consumer) and retry.
- **CHECKPOINT** — `set_body_objective` reports it saved, `get_body_status` returns the facts, and both
  clients see `body` after a ⌘Q reopen. The day-to-day driving (the free-text goal, identity, weigh-ins +
  composition, reading the facts) is owned by **`/body-profile`**; the daily targets by **`/nutrition-chef`**.

### 8. (Optional) confirm `mcp/ensure-bridges.sh` brings it up
`mcp/ensure-bridges.sh` is a **thin consumer** of the service manifest (`node mcp/service-manifest.mjs
--probe-list`), so `body` appears automatically from its descriptor. Because the descriptor carries
`addon:"body"`, the probe treats the bridge as **OPTIONAL** and skips it silently on a board that never
installed it. No edit needed; confirm:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$REPO_ROOT/mcp/ensure-bridges.sh" | grep -i body   # expect: "[mcp] body bridge up on :8012"
```

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-body   # restart the bridge
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-body   # stop the bridge
tail -f mcp/logs/body.err.log                                   # supergateway / server log
```
**Disable the add-on (keep the plumbing):** only possible when **no** consumer (Nutrition/Fitness) is
enabled (else 409). Flip it off — the `/body` nav + page hide and writes 404 again, but the bridge stays
loaded and the data stays on disk + readable:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/body" -H 'Content-Type: application/json' -d '{"enabled":false}' ; echo
```

## --uninstall (remove the add-on plumbing — the inverse of §3–§6)
Tear the bridge + registrations down. Does **NOT** delete data (see the purge note):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
# 1. (Only if no consumer is on) flag the add-on OFF:
curl -s -X PATCH "$BOARD_URL/api/addons/body" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null 2>&1 || true
# 2. Stop + remove the launchd bridge:
launchctl bootout gui/$U/com.chiefofstaff.mcp-body 2>/dev/null || true
rm -f "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-body.plist"
# 3. Drop the Cowork entry (backup-first node merge; preserves the other servers + preferences):
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env, p = E.COWORK_CONFIG;
if (fs.existsSync(p)) {
  const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
  if (cfg.mcpServers) delete cfg.mcpServers.body;
  fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers||{}).join(', '));
}
NODE
# 4. Leave .mcp.json ALONE — it is a GENERATED, CI-checked artifact (rendered from the descriptor).
echo "Uninstalled the body bridge + the Cowork entry. ⌘Q + reopen Cowork to drop it from the tool list."
```

> **SEPARATE — purge the data (DESTRUCTIVE, explicit, opt-in).** Uninstall leaves `db.weights` AND the
> `db.bodyProfile` + `db.bodyObjective` singletons in `board/data/cases.json` untouched (so a re-enable
> finds your history + goal). To actually **erase** them, clear `weights` to `[]` and remove
> `bodyProfile`/`bodyObjective` in the store by hand (`delete_weight` drops a weigh-in; there is no API to
> drop the singletons). The store is **backed up daily**, so take a fresh backup first if you want a
> restore point. This is intentionally NOT part of `--uninstall` — removing the plumbing must never
> silently destroy a user's body history.

## Gotchas (read before editing)
- **Body HARD auto-enables under Nutrition/Fitness, and refuses to disable while one is on (409).** This
  is the opt-in/cascade difference from the other add-ons. "A body write 404s" almost always means
  *nothing is enabled* — enable a consumer (or body directly), not a bridge fault.
- **The board serves FACTS, not a recommendation.** `get_body_status` is BMR/TDEE/BMI/trend/FFM only; the
  agent authors the daily targets (`nutrition-chef` → `save_nutrition_targets`). Don't expect a calorie
  target from this server.
- **`COS_MCP_IDLE_EXIT_MS` lives ONLY in the bridge plist, never in the Cowork config** (same rule as
  every other bridge — setting it in Cowork manifests as "server transport closed unexpectedly").
- **No sidecar, no external repo, no secret.** Body is the nutrition/fitness archetype: an in-repo Node
  `fetch` wrapper that needs only the board on `CRM_BASE_URL`.
- **The board must be reachable on `CRM_BASE_URL`.** Every tool is a `fetch` to `/api/body/*`.
- **Port `8012` must be free** (`lsof -nP -iTCP:8012 -sTCP:LISTEN`). It sits after the fitness bridge
  (`:8011`). A foreign process on it breaks §4 — change `BODY_BRIDGE_PORT` in `cos.env` and re-render §3/§4.
- **launchd cannot expand `$VARS`** — the rendered plist carries literal absolute paths + a `PATH` that
  starts with `$BREW_PREFIX/bin`. **The node/simdjson + pm2 gotchas in mcp-bridge-setup apply here too.**
