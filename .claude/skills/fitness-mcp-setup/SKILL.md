---
name: fitness-mcp-setup
description: Stand up the `fitness` MCP for the "Fitness" add-on on a new machine and wire it into both Claude clients — an in-repo thin fetch-wrapper over the board's /api/fitness/* routes (like the nutrition/calendar servers), with ONE machine-local secret (FITNESS_PUSH_TOKEN) it attaches as the `x-fitness-token` header on its write tools. It is exposed to Claude Code via a supergateway + launchd BRIDGE on $FITNESS_BRIDGE_PORT/:8011 and to Claude Cowork Desktop as a direct stdio command, and the add-on must be ENABLED (Settings.addons.fitness.enabled) for its writes to land + its /fitness + /fitness/health nav to appear. Use when setting up the fitness add-on on a new machine, when Cowork or Code can't see the `fitness` server, when the fitness bridge (:8011) is down, when push_health_data / delete_health_data write but the board 404s or 401s them, or when enabling/disabling the Fitness add-on.
---

# Fitness MCP setup (thin fetch-wrapper bridge :8011, one ingest secret)

## Why this exists / architecture
`fitness` is the **second built-in add-on** ("Fitness" — Apple Watch health ingestion +
dashboard at `/fitness/health`, plus the athlete training profile + AI coach at `/fitness`). Like
**nutrition**, it has **no external repo and no sidecar**: the server lives **in this Cos checkout**
at `mcp/fitness-server/server.mjs`, and it is the same **thin `fetch` wrapper** archetype over the
board's `/api/fitness/*` HTTP routes on `CRM_BASE_URL`. It makes **no LLM calls** — the *coaching*
intelligence (training plans, weekly reviews, pre-workout briefs) lives on the board's `/api/fitness/*`
routes (server-side Claude calls) and in the operator skill (`/fitness-coach`), not here.

The **one difference from nutrition**: this server carries a single machine-local **secret**,
`FITNESS_PUSH_TOKEN`. The board's ingest endpoint (`POST /api/fitness/push`) is **token-gated** via
the `x-fitness-token` header — the same token the iPhone Health Auto Export shortcut sends — and the
MCP's **write** tools (`push_health_data` / `delete_health_data`) attach it automatically. **Reads
are ungated**, so an unset token only disables the two writes.

It is a **single Node stdio process** and registers into Cos the same two ways the core servers do:

- **Claude Code** reaches it over **HTTP** via a **supergateway + launchd BRIDGE on `:8011`**
  (`$FITNESS_BRIDGE_PORT`, label `com.chiefofstaff.mcp-fitness`, IN `.mcp.json`).
- **Claude Cowork Desktop** spawns it as a **direct stdio `command` entry** in
  `claude_desktop_config.json` — identical to how mcp-bridge-setup wires board/calendar/etc.

```
Claude Code   ──HTTP──> localhost:8011/mcp ──supergateway(launchd)──> node fitness-server (stdio)
                                                                          │ fetch (+ x-fitness-token on writes)
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
| fitness (MCP bridge) | `node mcp/fitness-server/server.mjs` via supergateway | `CRM_BASE_URL` + `FITNESS_PUSH_TOKEN` | 8011 | `com.chiefofstaff.mcp-fitness` | **yes** (`http://localhost:8011/mcp`) |

**Tools (7):** ingest — `push_health_data` (canonical entries), `delete_health_data`; reads —
`list_health_data`, `get_health_summary`, `get_daily_summary` (health + nutrition for one day),
`get_health_trends`, `ingest_health_to_vault` (composes a report for the vault MCP). The 2 writes
(`push_health_data` / `delete_health_data`) attach `x-fitness-token` and are gated; the 5 reads are
ungated. See `mcp/fitness-server/README.md` for the full contract.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
> `$BOARD_URL`, and the **fitness keys** — `$FITNESS_BRIDGE_PORT` (=`8011`) /
> `$FITNESS_BRIDGE_URL` (=`http://localhost:8011`) — use those instead of hardcoding paths, the
> Homebrew prefix, your username, or the port. The **secret** (`FITNESS_PUSH_TOKEN`) is read from
> `config/secrets.env` (§4), not `cos.env`.

## Prerequisites
- **Node + npm** (Homebrew) and the server's deps: `(cd mcp/fitness-server && npm i)`. The server
  imports the shared `packages/mcp-kit` by RELATIVE path, so no workspace install is needed.
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for **Claude Code**
  (`:8011`), exactly as in mcp-bridge-setup.
- **The board** reachable at `CRM_BASE_URL` (default `http://localhost:3000`). The server is a pure
  wrapper over the board's `/api/fitness/*` routes — there is no other backend, no external app, no
  pairing, no login. (Unlike whatsapp/openwhispr, there is **nothing external** to install.)
- A **`FITNESS_PUSH_TOKEN`** in `config/secrets.env` (§4). Any random string — it's machine-local and
  never committed.

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
- **CHECKPOINT** — the ready line prints the 7 tool names and echoes the `CRM_BASE_URL` it will talk
  to. (This only proves the server boots; §3 proves the bridge serves it, §7 proves a tool
  round-trips against the board.)

### 3. Ensure the `.mcp.json` fitness http entry (Claude Code)
The repo already ships the `fitness` http entry in `$REPO_ROOT/.mcp.json`. Confirm it points at the
`:8011` bridge — do **not** clobber the other servers:
```json
{ "mcpServers": {
  "fitness": { "type": "http", "url": "http://localhost:8011/mcp" }
}}
```
- **CHECKPOINT** — the entry is present alongside the core servers:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"fitness"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json fitness entry OK"
  ```
  If it is somehow missing, add the one entry above (merged into the existing `mcpServers`).

### 4. Seed the ingest secret (`FITNESS_PUSH_TOKEN`)
The two write tools authenticate to the board with a shared secret. Seed it in `config/secrets.env`
(gitignored) — any random string. The same value is what the iPhone Health Auto Export shortcut
sends as `x-fitness-token`, so reuse it there too:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
SEC="$REPO_ROOT/config/secrets.env"
[ -f "$SEC" ] || cp "$REPO_ROOT/config/secrets.env.example" "$SEC"
grep -q '^FITNESS_PUSH_TOKEN=' "$SEC" || printf 'FITNESS_PUSH_TOKEN=%s\n' "$(openssl rand -hex 20)" >> "$SEC"
# If it's still the placeholder, replace it with a real random token:
grep -q '^FITNESS_PUSH_TOKEN=replace-with-a-random-token' "$SEC" \
  && { TOK=$(openssl rand -hex 20); sed -i '' "s/^FITNESS_PUSH_TOKEN=.*/FITNESS_PUSH_TOKEN=$TOK/" "$SEC"; } || true
```
> The board side reads the SAME token: the ingest route validates `x-fitness-token` against
> `FITNESS_PUSH_TOKEN` from the environment the **board** process sees (it sources `config/secrets.env`
> on boot). If you set/rotate the token here, **restart the board** so it picks up the new value, or
> the bridge's writes will 401.
- **CHECKPOINT** — a real (non-placeholder) token is present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '^FITNESS_PUSH_TOKEN=' "$REPO_ROOT/config/secrets.env" \
    && ! grep -q '^FITNESS_PUSH_TOKEN=replace-with-a-random-token' "$REPO_ROOT/config/secrets.env" \
    && echo "FITNESS_PUSH_TOKEN seeded"
  ```

### 5. Install the launchd BRIDGE (`:8011`)
Install from the **committed template**
`mcp/fitness-server/deploy/com.chiefofstaff.mcp-fitness.plist.template` — same pattern as the
nutrition/guardsvc/vault templates — substituting the loader's absolute paths, the bridge port, AND
the secret (launchd cannot expand `$VARS`, so the rendered plist carries literal values). Source
`secrets.env` first so `$FITNESS_PUSH_TOKEN` is in scope:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
set -a; . "$REPO_ROOT/config/secrets.env"; set +a   # export FITNESS_PUSH_TOKEN for the sed below
mkdir -p "$REPO_ROOT/mcp/logs"
sed -e "s#__BREW_PREFIX__#$BREW_PREFIX#g" \
    -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__FITNESS_BRIDGE_PORT__#${FITNESS_BRIDGE_PORT:-8011}#g" \
    -e "s#__FITNESS_PUSH_TOKEN__#${FITNESS_PUSH_TOKEN}#g" \
  "$REPO_ROOT/mcp/fitness-server/deploy/com.chiefofstaff.mcp-fitness.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-fitness.plist"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-fitness 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-fitness.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-fitness
```
The template runs supergateway DIRECTLY around the node child (no launch wrapper — like
nutrition/board/calendar, UNLIKE vault, because this server makes no LLM calls). Its env is:
- `PATH` starting with `$BREW_PREFIX/bin` (launchd can't see an nvm/asdf shim),
- `CRM_BASE_URL=http://localhost:3000` (the board; pinned so it doesn't depend on the launchd cwd),
- `FITNESS_PUSH_TOKEN=…` — the substituted-in ingest secret (the one machine-local credential),
- `COS_MCP_IDLE_EXIT_MS=300000` — the idle-exit **OPT-IN**, set **ONLY here** (the bridge), never in
  the direct-stdio Cowork config (see Gotchas).

> The rendered plist now contains the literal token. It lives in `~/Library/LaunchAgents` (NOT
> version-controlled) — that's fine; just don't paste the rendered plist anywhere public, and
> re-render it (this step) after rotating the token.

- **CHECKPOINT** — an MCP `initialize` on `:8011` returns `serverInfo.name == "fitness"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"fitness"' && echo "fitness bridge OK"
  ```

### 6. Register Cowork (direct stdio)
`.mcp.json` (§3) covers **Claude Code**. **Claude Cowork Desktop** registers **differently**:
`claude_desktop_config.json` (`$COWORK_CONFIG`) accepts **stdio `command` servers only** (an HTTP
`url` is rejected — the same validated rule as mcp-bridge-setup). Cowork spawns the node server
itself. Write it with a **backup-first node merge** that preserves the other servers + `preferences`
and refreshes only the `fitness` entry from the **resolved** loader values + the secret — mirroring
mcp-bridge-setup's Cowork merge exactly:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # resolves NODE_BIN/REPO_ROOT/BOARD_URL/COWORK_CONFIG
set -a; . "$REPO_ROOT/config/secrets.env"; set +a                  # FITNESS_PUSH_TOKEN into env for the merge
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env;
const server = {
  command: E.NODE_BIN,
  args: [`${E.REPO_ROOT}/mcp/fitness-server/server.mjs`],
  env: {
    CRM_BASE_URL: E.BOARD_URL || 'http://localhost:3000',  // the board
    FITNESS_PUSH_TOKEN: E.FITNESS_PUSH_TOKEN || '',          // the ingest secret; NO idle-exit here
  },
};
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
cfg.mcpServers = { ...(cfg.mcpServers||{}), fitness: server };   // refresh OURS; keep other servers + preferences intact
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');            // back up before write
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
```
- **Absolute `node` path** (`$NODE_BIN`, from the loader): Claude Desktop's spawn env, like
  launchd's, lacks Homebrew on `PATH`.
- **The secret rides in the Cowork `env`** (Cowork has no `config/secrets.env` access at spawn) — so
  the write tools work from Cowork too. **Do NOT set `COS_MCP_IDLE_EXIT_MS` in the Cowork entry** —
  Cowork holds one long-lived stdio child; the idle-exit opt-in belongs only in the §5 bridge plist.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `fitness`
  appears in Cowork's tools.
- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"fitness"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.fitness?0:1)' \
    && echo "Cowork config OK"
  ```

### 7. ENABLE the add-on (the gate — writes 404 until you do this)
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

### 8. End-to-end verify (a tool call round-trips through the board)
Confirm the whole add-on works from the MCP surface, not just the ports — and that the gate + token
are live:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# (a) a GATED, TOKEN-AUTHED write round-trips now the add-on is enabled — push one canonical entry:
curl -s -X POST "$FITNESS_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"push_health_data","arguments":{"entries":[{"id":"setup-smoke-1","ts":"2026-06-16","type":"steps","data":{"value":8000}}]}}}' \
  | grep -o '"accepted"' && echo "write round-trips (add-on enabled + token OK)"
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
If you call (a) BEFORE §7 you'll see `Not found — the fitness add-on may be disabled.` — that's the
gate working, not a failure; enable the add-on and retry. A `401 / Unauthorized — check
FITNESS_PUSH_TOKEN` means the bridge's token doesn't match the board's (rotate both + restart the
board, §4).
- **CHECKPOINT** — `push_health_data` returns an `accepted` count, `list_health_data` echoes the
  entry, `delete_health_data` returns `deleted`, and both clients see `fitness` after a ⌘Q reopen. The
  day-to-day driving (ingesting from the iPhone, reading summaries/trends, setting the athlete
  profile, generating a training plan / weekly review / pre-workout brief, pushing a plan to the
  calendar, ingesting to the vault) is then owned by **`/fitness-coach`** — that skill owns the
  operation; this one only proves the plumbing.

### 9. (Optional) confirm `mcp/ensure-bridges.sh` brings it up
`fitness` is **already wired** into `mcp/ensure-bridges.sh` as an **OPTIONAL** bridge (`"fitness
${FITNESS_BRIDGE_PORT:-8011}"` in the service list; in the
`openwhispr|whatsapp|whatsappbridge|vaultjobs|nutrition|fitness` skip-if-no-plist case), so `npm run
dev/start` brings it up with the rest **only when the plist exists** — a machine without the add-on
is skipped silently (no `WARN … DOWN` about `:8011`). No edit needed; just confirm:
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
**Rotate the token:** edit `FITNESS_PUSH_TOKEN` in `config/secrets.env`, **restart the board** (so it
re-reads the new value), then **re-render the plist** (§5) and **re-merge Cowork** (§6) so both
clients carry the new token, and re-pair your iPhone shortcut with the same value.

**Disable the add-on (keep the plumbing):** flip it off — the nav + pages hide and writes 404 again,
but the bridge stays loaded and the data stays on disk + readable:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X PATCH "$BOARD_URL/api/addons/fitness" -H 'Content-Type: application/json' -d '{"enabled":false}' ; echo
```

## --uninstall (remove the add-on plumbing — the inverse of §3–§7)
Tear the bridge + registrations down (a machine that won't run fitness). This is the inverse of the
install; it does **NOT** delete data (see the data-purge note below):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
# 1. Flag the add-on OFF (writes 404, nav hides) — do this first so the surface is dormant:
curl -s -X PATCH "$BOARD_URL/api/addons/fitness" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null 2>&1 || true
# 2. Stop + remove the launchd bridge (the rendered plist carried the token — remove it):
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
# 4. Drop the .mcp.json entry (backup-first; keep the other servers):
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env, p = `${E.REPO_ROOT}/.mcp.json`;
const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
if (cfg.mcpServers) delete cfg.mcpServers.fitness;
fs.copyFileSync(p, p + '.bak');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('.mcp.json mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
echo "Uninstalled the fitness bridge + both registrations. ⌘Q + reopen Cowork to drop it from the tool list."
```
> The `FITNESS_PUSH_TOKEN` line stays in `config/secrets.env` (harmless; re-enabling reuses it). The
> repo SHIPS the `.mcp.json` fitness entry and the `ensure-bridges.sh` line; removing them from a
> tracked file leaves a local diff. For a per-machine opt-out, leaving the plist uninstalled is
> enough — `ensure-bridges.sh` skips fitness silently when no plist exists, so a stray `.mcp.json`
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
  is almost always *the add-on is off* (§7), not a bridge fault — check `/api/addons`.
- **The token is the SECOND auth layer — distinct from the add-on gate.** A `401` (not `404`) means
  the bridge's `FITNESS_PUSH_TOKEN` doesn't match what the board sees. Both must carry the SAME value:
  the bridge gets it via §5 (plist) / §6 (Cowork env); the board reads it from `config/secrets.env`
  at boot. After any rotation, **restart the board** and re-render both client wirings (§4 manage).
- **The COACHING intelligence is NOT in the MCP.** The 7 tools just push/read health data + compose a
  vault report. The training plans / weekly reviews / pre-workout briefs are generated by the board's
  `/api/fitness/*` routes (server-side Claude calls) and orchestrated by the operator skill
  (`/fitness-coach`). Don't expect an MCP tool to "generate a plan".
- **`COS_MCP_IDLE_EXIT_MS` lives ONLY in the bridge plist, never in the Cowork config.** mcp-kit's
  idle-exit is OFF by default so Cowork's long-lived stdio child never dies on idle; the §5
  supergateway bridge opts in (`300000`) to reap supergateway's leaked idle stateless child. Setting
  it in the Cowork entry manifests as the dreaded "server transport closed unexpectedly". Same rule
  as every other bridge.
- **No sidecar, no external repo, ONE secret.** Unlike whatsapp (Go + Python, external checkout, QR
  pairing) and openwhispr (external app store), fitness is the **nutrition archetype plus a token**:
  an in-repo Node `fetch` wrapper that needs the board on `CRM_BASE_URL` and `FITNESS_PUSH_TOKEN` for
  its writes. There is nothing to clone, build, or pair.
- **The board must be reachable on `CRM_BASE_URL`.** Every tool is a `fetch` to `/api/fitness/*`. If
  the board app isn't up on `:3000` (or wherever `CRM_BASE_URL` points), tool calls fail with a
  connection error — start the board (`cd board && npm run dev`).
- **Port `8011` must be free** (`lsof -nP -iTCP:8011 -sTCP:LISTEN`). It sits after the search/guardsvc
  sidecars (`:8008`/`:8009`) and the WhatsApp Go bridge (`:8010`). A foreign process on it breaks §5
  — change `FITNESS_BRIDGE_PORT` in `cos.env` and re-render §3/§5.
- **launchd cannot expand `$VARS`.** As with every Cos plist, the **rendered** plist in
  `~/Library/LaunchAgents` carries **literal absolute paths** + the **literal token** (`sed`-
  substituted from the loader + `secrets.env` in §5) and a `PATH` that starts with `$BREW_PREFIX/bin`
  — launchd never inherits your login shell and can't see an nvm/asdf shim. The template invokes
  supergateway by its **absolute** `$BREW_PREFIX/bin/supergateway` path; the inner `--stdio "node
  …/server.mjs"` child resolves `node` via that `$BREW_PREFIX/bin`-leading `PATH`.
- **The node/simdjson + pm2 gotchas in mcp-bridge-setup apply here too** — same Node, same
  supergateway, same launchd supervisor. If the bridge dies with a `libsimdjson` dyld error after a
  `brew install`, `brew reinstall node`. Don't reintroduce pm2 — launchd owns the lifecycle (the pm2
  mechanism has been retired).
