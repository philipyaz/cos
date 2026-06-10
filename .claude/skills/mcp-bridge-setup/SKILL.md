---
name: mcp-bridge-setup
description: Wire this repo's CORE stdio MCP servers (board, calendar, guard, vault) into Claude Cowork Desktop and Claude Code. (The optional openwhispr voice add-on and the whatsapp add-on each have their OWN setup skill — /openwhispr-mcp-setup, /whatsapp-mcp-setup — so they're out of scope here.) Cowork uses direct stdio `command` entries in claude_desktop_config.json (validated — it does NOT accept HTTP `url` entries); Claude Code uses .mcp.json over the supergateway + launchd HTTP bridge. Use when setting up on a new machine, when Cowork or Code can't see board/calendar/guard/vault, when a bridge is down, or when wiring a new MCP server. Covers the stdio config, supergateway + launchd, the search + guard sidecar LaunchAgents, verification, and the node/simdjson + pm2 gotchas.
---

# MCP bridge setup (stdio → Streamable HTTP for Cowork)

## Why this exists
This skill wires the **four core servers** (board, calendar, guard, vault) — all **stdio** MCP
servers. (The optional **openwhispr** voice add-on and **whatsapp** each live in their own setup
skill — `/openwhispr-mcp-setup`, `/whatsapp-mcp-setup` — because each integrates an *external app*;
the four here are self-contained in this repo.) Two Claude clients consume them, and they register
**differently** — getting this wrong is the usual failure:

- **Claude Cowork Desktop** launches them **directly as stdio `command` servers** in
  `claude_desktop_config.json` (**validated 2026-06-01** — Cowork *can* spawn local stdio
  servers; the earlier "it can't, so bridge over HTTP" assumption was wrong). It does **not**
  accept HTTP `url` entries in that file. → **§5, the primary path for Cowork.**
- **Claude Code** connects over **HTTP** via `REPO/.mcp.json` (`"type":"http"` →
  `localhost:8001`–`8005`). Each HTTP endpoint is a **supergateway** bridge, kept alive by
  **launchd** — the "bridge" this skill is named for. (Claude Code could use stdio too, but a
  long-running bridge gives one supervised, always-on instance independent of which app is open.)

```
Claude Code   ──HTTP──> localhost:8001/mcp ──supergateway(launchd)──> node board-server (stdio)
                        localhost:8003/mcp ──supergateway(launchd)──> node calendar-server (stdio)
                        localhost:8004/mcp ──supergateway(launchd)──> node guard-server (stdio) ──HTTP──> guard sidecar :8009
                        localhost:8005/mcp ──supergateway(launchd)──> node vault-server (stdio) ──Agent SDK──> Anthropic API
Cowork Desktop ──spawns stdio directly──────────────────────────────> node board / calendar / guard / vault   (§5)
```

This repo's servers (`mcp/`):
| server | stdio command | env | bridge port |
|--------|---------------|-----|------|
| board | `node mcp/board-server/server.mjs` | `CRM_BASE_URL=$BOARD_URL` | 8001 |
| calendar | `node mcp/calendar-server/server.mjs` | `CRM_BASE_URL=$BOARD_URL` | 8003 |
| guard | `node mcp/guard-server/server.mjs` | `COS_GUARD_URL=$GUARD_SIDECAR_URL` | 8004 |
| vault | `node mcp/vault-server/server.mjs` | `ANTHROPIC_API_KEY` (from `config/secrets.env` via `launch.sh`) + `COS_VAULT_DIR=$VAULT_DIR` | 8005 |

The core bridge ports above (8001 board, 8003 calendar, 8004 guard, 8005 vault — `:8002` is reserved
for the optional **openwhispr** add-on, `/openwhispr-mcp-setup`) and the sidecar ports (8008/8009)
are the defaults; all are configurable via `config/cos.env` (the loader resolves them into
`$*_BRIDGE_PORT` / `$*_SIDECAR_PORT`).

> The launchd bridges (§2–4) exist for **Claude Code's HTTP** path; **Cowork uses §5 direct
> stdio** and needs no bridge. Keep the bridges for Claude Code (and as the verification
> surface); use §5 to register Cowork.

> The **search sidecar** (`:8008`) is *not* a bridge here — it's an HTTP daemon the
> board calls, not a stdio MCP server, so it stays out of `.mcp.json` (like Gmail/Calendar).
> But launchd supervises it the same way and `ensure-bridges.sh` nudges it, so its
> LaunchAgent is documented in **["The search sidecar LaunchAgent"](#the-search-sidecar-launchagent-8008)** below.

> Machine config comes from the loader (run the preamble in §1 below): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$UV_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`,
> `$COWORK_CONFIG`, `$VAULT_DIR`, and every bridge /
> sidecar port + URL — use those instead of hardcoding paths, the Homebrew prefix, or your
> username. (The `__REPO__` / `__VAULT_NAME__` plist-template placeholders are runtime-substituted
> from `$REPO_ROOT` / `$VAULT_NAME`; the Anthropic key is NOT a placeholder — it stays in
> `config/secrets.env`, loaded by `launch.sh`.)

## Prerequisites
- Node + npm (Homebrew). Each server's deps installed: `(cd mcp/board-server && npm i)`,
  `(cd mcp/calendar-server && npm i)`, `(cd mcp/guard-server && npm i)`, and
  `(cd mcp/vault-server && npm i)` (vault pulls in the Agent SDK).
- `npm install -g supergateway`
- **`uv`** (Homebrew) for the two Python sidecars — the **search** sidecar (`:8008`) and the
  **guard** sidecar (`:8009`); both self-provision their venv on first launch.

## Steps

### 1. Verify the stdio servers run
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# The loader exports $REPO_ROOT, $BREW_PREFIX, $NODE_BIN, $UV_BIN, $SUPERGATEWAY_BIN,
# $LAUNCH_AGENTS_DIR, $COWORK_CONFIG, $VAULT_DIR,
# and every bridge/sidecar port + URL — use those instead of hardcoding machine paths.
"$NODE_BIN" "$REPO_ROOT/mcp/board-server/server.mjs"      # Ctrl-C; should print "...on stdio"
"$NODE_BIN" "$REPO_ROOT/mcp/calendar-server/server.mjs"   # Ctrl-C; should print "...on stdio"
"$NODE_BIN" "$REPO_ROOT/mcp/guard-server/server.mjs"      # Ctrl-C; prints "...ready ... fail-closed"; talks to the guard sidecar (:8009) via COS_GUARD_URL
ANTHROPIC_API_KEY=sk-ant-… COS_VAULT_DIR="$VAULT_DIR" "$NODE_BIN" "$REPO_ROOT/mcp/vault-server/server.mjs"  # Ctrl-C; embeds the Agent SDK (outbound Anthropic API calls), session scoped to COS_VAULT_DIR
```

### 2. One launchd LaunchAgent per server
Create `~/Library/LaunchAgents/com.chiefofstaff.mcp-board.plist` (and a `-calendar` twin: port `8003`,
server `calendar-server`, env `CRM_BASE_URL` like board; and a `-guard` twin: port `8004`,
server `guard-server`, env `COS_GUARD_URL=http://127.0.0.1:$GUARD_SIDECAR_PORT`; and a `-vault`
twin: port `8005`, server `vault-server`, env `ANTHROPIC_API_KEY` + `COS_VAULT_DIR=$VAULT_DIR`
instead of `CRM_BASE_URL` — see ["The vault server makes outbound LLM calls"](#the-vault-server-makes-outbound-llm-calls)
for why it carries the key and how its inner session is isolated; install from the committed
template at `mcp/vault-server/deploy/`). **All five node bridges (board/calendar/guard/vault/
openwhispr) MUST carry `COS_MCP_IDLE_EXIT_MS=300000`** in their `EnvironmentVariables` (shown
below) — see ["Why bridges set COS_MCP_IDLE_EXIT_MS"](#why-bridges-set-cos_mcp_idle_exit_ms).
The `-guard` bridge has a **second process** — its own
`-guardsvc` **uv sidecar** on `:8009` (see ["The guard sidecar
LaunchAgent"](#the-guard-sidecar-launchagent-8009) below), exactly as search does. Template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chiefofstaff.mcp-board</string>
  <key>ProgramArguments</key><array>
    <string>$BREW_PREFIX/bin/supergateway</string>
    <string>--stdio</string><string>$BREW_PREFIX/bin/node $REPO_ROOT/mcp/board-server/server.mjs</string>
    <string>--outputTransport</string><string>streamableHttp</string>
    <string>--port</string><string>8001</string>
    <string>--streamableHttpPath</string><string>/mcp</string>
    <string>--cors</string>
    <string>--logLevel</string><string>info</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CRM_BASE_URL</key><string>$BOARD_URL</string>
    <!-- Idle-exit OPT-IN — REQUIRED on every node bridge. mcp-kit's idle-exit is OFF by
         default (so a direct stdio client like Cowork never dies on idle); supergateway's
         stateless bridge leaks an idle child, so each bridge opts in to reap it after 5 min
         idle. Omit it and this bridge silently leaks children. -->
    <key>COS_MCP_IDLE_EXIT_MS</key><string>300000</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_ROOT/mcp/logs/board.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_ROOT/mcp/logs/board.err.log</string>
</dict></plist>
```

> When you render this template into the plist, expand `$BREW_PREFIX` / `$REPO_ROOT` / `$BOARD_URL`
> from the loader. launchd cannot expand `$VARS` itself and cannot see an nvm/asdf shim, so the
> plist must carry the literal `$BREW_PREFIX/bin/node` / `$BREW_PREFIX/bin/supergateway` paths —
> not a `command -v node` shim — and a `PATH` that starts with `$BREW_PREFIX/bin`.

**Critical flags / fields**
- `--outputTransport streamableHttp` + `--streamableHttpPath /mcp` → URL is `http://localhost:PORT/mcp`.
- `--cors` is **required** for the HTTP clients (Claude Code over the bridge, and the Desktop
  Connector UI) — they connect from a different origin. (Cowork itself uses §5 stdio, no CORS.)
- `PATH` **must** include `$BREW_PREFIX/bin`: launchd's default PATH lacks Homebrew, but
  supergateway's `#!/usr/bin/env node` shebang and the `--stdio "node ..."` child both need `node`.
- `--stdio "$BREW_PREFIX/bin/node <abs path>"` is **one** array element. Use **absolute** paths
  for the server file and every env path (the servers `path.resolve()` them).
- `COS_MCP_IDLE_EXIT_MS=300000` is **required** on every node bridge (board/calendar/guard/vault/
  openwhispr). It is the bridge's **opt-in** to mcp-kit's idle-child reaper, which is **off by
  default** — see ["Why bridges set COS_MCP_IDLE_EXIT_MS"](#why-bridges-set-cos_mcp_idle_exit_ms).

#### Why bridges set `COS_MCP_IDLE_EXIT_MS`
`packages/mcp-kit/index.mjs` (the shared `start()` every node server uses) keeps the idle-exit
timer **OFF by default**, so a long-lived **direct** stdio client — Claude Cowork Desktop, `node
server.mjs` by hand, any future client — never has its server self-terminate while idle (that was
the *"Server transport closed unexpectedly … process exiting early" → MCP not responding* bug;
direct clients don't respawn). A real client disconnect/quit closes stdin, which already reaps the
child (backstop #1). The **supergateway bridge** is the one path that leaks: in stateless
StreamableHttp mode supergateway spawns a fresh child per request and reaps it only on
child-exit / protocol error, never on a normal POST completion, so idle children pile up until the
bridge dies. Each **bridge plist therefore opts in** with `COS_MCP_IDLE_EXIT_MS=300000` to reap
them (a request in flight disarms the timer; supergateway respawns on the next call). **Do NOT put
this var in the Cowork `claude_desktop_config.json`** — Cowork relies on the safe off-by-default.

Verify every installed node bridge carries the opt-in (board/calendar/guard are authored from the
heredoc above with no committed template, so a dropped line silently reintroduces the leak):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
for s in board calendar guard vault openwhispr; do
  printf '%s: ' "$s"
  plutil -p "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-$s.plist" | grep -o 'COS_MCP_IDLE_EXIT_MS" => "[0-9]*"' || echo "MISSING — add it + reload, or this bridge leaks idle children"
done
```

### 3. Load + auto-start
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
mkdir -p "$REPO_ROOT/mcp/logs"
U=$(id -u)
for svc in board calendar guard vault; do
  launchctl bootout    gui/$U/com.chiefofstaff.mcp-$svc 2>/dev/null   # ignore if not loaded
  launchctl bootstrap  gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-$svc.plist"
done
launchctl list | grep chiefofstaff   # PID present + exit 0 = healthy
```

### 4. Verify each endpoint (real MCP handshake)
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X POST "$BOARD_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
# expect: ...{"serverInfo":{"name":"board",...}}   (board answers even if the board port is down)
```

### 5. Register the endpoints (each client differs!)
The two clients register **differently** — getting this wrong is the usual failure.

#### Claude Cowork Desktop — direct stdio (✅ validated 2026-06-01)
`claude_desktop_config.json` accepts **stdio `command` servers only**. An HTTP `url` entry
(any `"type"`, incl. `streamable-http`) is rejected as *"not valid MCP server configurations …
skipped"* and ignored (older builds silently wiped the whole `mcpServers` block —
anthropics/claude-code#37286). So **do not put the bridge URLs here** — point Claude Desktop
straight at the servers; it spawns them itself (no bridge needed for Cowork). The file lives at
`$COWORK_CONFIG`. Add inside `mcpServers`, alongside the existing `preferences` (strict JSON — no
comments). The `$…` below are shown for clarity — **substitute the resolved values from
`config/cos.env` (the loader resolves them)** before writing them into this JSON, which can't
expand `$VARS`:
```json
{ "mcpServers": {
  "board": {
    "command": "$BREW_PREFIX/bin/node",
    "args": ["$REPO_ROOT/mcp/board-server/server.mjs"],
    "env": { "CRM_BASE_URL": "$BOARD_URL" }
  },
  "calendar": {
    "command": "$BREW_PREFIX/bin/node",
    "args": ["$REPO_ROOT/mcp/calendar-server/server.mjs"],
    "env": { "CRM_BASE_URL": "$BOARD_URL" }
  },
  "guard": {
    "command": "$BREW_PREFIX/bin/node",
    "args": ["$REPO_ROOT/mcp/guard-server/server.mjs"],
    "env": { "COS_GUARD_URL": "$GUARD_SIDECAR_URL" }
  },
  "vault": {
    "command": "$BREW_PREFIX/bin/node",
    "args": ["$REPO_ROOT/mcp/vault-server/server.mjs"],
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-…",
      "COS_VAULT_DIR": "$VAULT_DIR"
    }
  }
}, "preferences": { /* leave intact */ } }
```

**Write it from config — don't hardcode (idempotent).** The JSON above is the *shape*; never
hand-type machine paths or the API key into it. Resolve every value from the config files and
merge it in with this script — it **backs up first**, preserves `preferences`/other keys, and
refreshes all four entries from the **resolved** config, so a path/port/vault-name change in
`config/cos.env` propagates and **re-running it fixes drift** (e.g. a missing `vault` — the most
common gap, since it's the only one needing the key + a vault dir):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # resolves NODE_BIN/REPO_ROOT/VAULT_DIR/*_URL/COWORK_CONFIG from config/cos.env
set -a; . "$REPO_ROOT/config/secrets.env"; set +a                 # the loader deliberately does NOT source secrets — ANTHROPIC_API_KEY (vault only) lives ONLY here
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env;
if (!(E.ANTHROPIC_API_KEY||'').startsWith('sk-')) { console.error('FATAL: ANTHROPIC_API_KEY missing — see config/secrets.env'); process.exit(1); }
const node = E.NODE_BIN, srv = s => `${E.REPO_ROOT}/mcp/${s}-server/server.mjs`;
const servers = {                                  // core four — always refreshed; every value comes from the loader / secrets.env, nothing hardcoded
  board:    { command: node, args: [srv('board')],    env: { CRM_BASE_URL: E.BOARD_URL } },
  calendar: { command: node, args: [srv('calendar')], env: { CRM_BASE_URL: E.BOARD_URL } },
  guard:    { command: node, args: [srv('guard')],    env: { COS_GUARD_URL: E.GUARD_SIDECAR_URL } },
  vault:    { command: node, args: [srv('vault')],    env: { ANTHROPIC_API_KEY: E.ANTHROPIC_API_KEY, COS_VAULT_DIR: E.VAULT_DIR } },
};
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
cfg.mcpServers = { ...(cfg.mcpServers||{}), ...servers };   // refresh OURS; keep any other servers + preferences intact
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');       // back up before write
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
```
> Only `vault` carries `ANTHROPIC_API_KEY` (it makes outbound LLM calls — see
> ["The vault server makes outbound LLM calls"](#the-vault-server-makes-outbound-llm-calls));
> the other four are localhost-only and carry no secret. The key is read from
> `config/secrets.env` at write time and **never printed** — if you ever hand-edit instead, pull
> it from there, don't paste a literal. To add **one** server (not refresh all), keep the same
> preamble and assign just that key into `cfg.mcpServers`.

- **Absolute `node` path** (`$BREW_PREFIX/bin/node`, from the loader): Claude Desktop's spawn
  env, like launchd's, lacks Homebrew on `PATH` (same gotcha as §2).
- **Absolute** server + env paths — Claude Desktop, like launchd, `path.resolve()`s nothing for you.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then board,
  calendar, guard + vault appear in Cowork's tools (**Settings → Connectors** lists the local
  servers). On first use Cowork prompts to allow each server's tools — choose **"Always allow"** so
  routine agent runs aren't interrupted by a per-call prompt (or approve per-tool if you prefer).
- board tool *calls* still need the Next app on `:3000` (`cd board && npm run dev`);
  `initialize`/`tools/list` work without it. Semantic `search` flows on to the `:8008` sidecar.
- **Validate the exact command+env before trusting it** — spawn each with the SDK
  `StdioClientTransport` and run `listTools()` + one `callTool` (how confirmed: board → 26 tools
  + semantic search; calendar → 6 tools;
  guard → 4 tools (scan_email, classify_text, check_sender, block_sender) + non-error fail-closed verdicts (2026-06-03);
  vault → 2 tools (ingest, query), `serverInfo.name=vault` (2026-06-08)).

#### Claude Code — HTTP via the bridge
`REPO/.mcp.json` *does* accept a `url` (`"type":"http"`, `"streamable-http"` as an alias),
pointing at the supergateway bridges from §2–4:
```json
{ "mcpServers": {
  "board":      { "type": "http", "url": "http://localhost:8001/mcp" },
  "calendar":   { "type": "http", "url": "http://localhost:8003/mcp" },
  "guard":      { "type": "http", "url": "http://localhost:8004/mcp" },
  "vault":      { "type": "http", "url": "http://localhost:8005/mcp" }
}}
```
> The optional `openwhispr` (`:8002`) and `whatsapp` (`:8006`) entries are added by their own
> setup skills (`/openwhispr-mcp-setup`, `/whatsapp-mcp-setup`), merged alongside these four.

#### Claude Desktop — HTTP alternatives (only if you prefer the bridge / can't use stdio)
- **Custom Connector UI** — Settings → Connectors → Add custom connector →
  `$BOARD_BRIDGE_URL/mcp` (and the other bridge URLs). Uses the §2–4 bridges; no config-file entry, no
  OAuth for a localhost no-auth endpoint. (The bridges serve plain streamable-HTTP — verify
  with the SDK `StreamableHTTPClientTransport`, which connects + lists tools.)
- **`mcp-remote` stdio shim** — `{"command":"npx","args":["-y","mcp-remote","<url>"]}` — the
  generic config-file workaround for HTTP servers, but it currently chokes on supergateway
  with `Unexpected content type: null`. Prefer the direct stdio above (it's simpler anyway).

### 6. Couple the bridges to the app (one-way)
Make starting the app guarantee the bridges are up. Create `mcp/ensure-bridges.sh`
(then `chmod +x mcp/ensure-bridges.sh`):

```sh
#!/bin/sh
# Ensure the MCP HTTP bridges are loaded + running. Called before the app starts.
# One-way on purpose: NEVER stops them — Cowork needs the bridges even when the app
# is down. launchd still owns lifecycle.
# Always exits 0 (best-effort) so a bridge hiccup can't block the app.
# (The optional openwhispr/whatsapp add-ons append themselves to BOTH loops below from
#  their own setup skills — keying off whether their plist exists — so a machine without
#  them never WARNs about :8002/:8006.)
set -u
U=$(id -u); LA="$HOME/Library/LaunchAgents"
REPO=$(cd "$(dirname "$0")/.." && pwd)
for svc in board calendar guard vault; do
  label="com.chiefofstaff.mcp-$svc"
  launchctl bootstrap gui/"$U" "$LA/$label.plist" 2>/dev/null   # load if not loaded
  launchctl kickstart "gui/$U/$label" 2>/dev/null               # start if not running
done
sleep 1
for pair in "8001 board" "8003 calendar" "8004 guard" "8005 vault"; do
  port=${pair%% *}; name=${pair#* }
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 \
    && echo "[mcp] $name bridge up on :$port" \
    || echo "[mcp] WARN: $name bridge DOWN on :$port — see $REPO/mcp/logs/$name.err.log"
done
exit 0
```

Chain it into `board/package.json` so the app brings the bridges up first:
```json
"dev":   "../mcp/ensure-bridges.sh && next dev",
"start": "../mcp/ensure-bridges.sh && next start"
```

**Keep it one-way** — do not tear the bridges down on app exit: Cowork needs them even
when the dev app is down. launchd stays the real
supervisor (boot + crash-restart); this step only guarantees "they're up right now"
whenever the app starts. (No root launcher exists; if you start the app another way, call
`mcp/ensure-bridges.sh` there too.)

The same `ensure-bridges.sh` also nudges the two **uv sidecars** — **search** (`:8008`) and
**guard** (`:8009`): it bootstraps + kickstarts `com.chiefofstaff.mcp-search` and
`com.chiefofstaff.mcp-guardsvc` alongside the bridges, then probes each `/healthz` (not a bare
port-listen — a cold sidecar listens before its model is warm) and only **WARNs** if one isn't
up yet. The board's `POST /api/search` falls back to a keyword scan in that window, and the
guard MCP **fails CLOSED** (an unreachable scan returns `UNAVAILABLE → untrusted`), so a
missing/cold/absent sidecar never blocks `next dev` (see `docs/reference/search.md` / `docs/security/guard.md`).

> **The guard has TWO processes — bridge `:8004` *and* its own sidecar `:8009`.** The
> `guard` MCP bridge (`:8004`, in the table + `.mcp.json` above) is just a thin node
> stdio server; the real work lives in a **guard SIDECAR** (`guard/sidecar.py`, run by
> **`uv`**) on **`:8009`** — a uv FastAPI daemon **exactly like the search sidecar**:
> its own **`com.chiefofstaff.mcp-guardsvc`** LaunchAgent, supervised by launchd,
> **NOT** in `.mcp.json` (it's an HTTP backend, not an MCP server). `ensure-bridges.sh`
> nudges it alongside the search sidecar and probes its **`/healthz` leniently** (the
> classifier warms at startup, so a cold sidecar listens before it's ready — WARN, don't
> fail). Its **first real model** is the **gated** Meta `Llama-Prompt-Guard-2-86M`, which
> needs a HuggingFace login + license acceptance (`huggingface-cli login`); in **`auto`**
> mode (default) the sidecar **falls back to a deterministic heuristic** classifier when
> the model is unavailable, so the bridge works **offline** out of the box (degraded, and
> the classifier name in every response says so). See `docs/security/guard.md` for the full contract.

### The vault server makes outbound LLM calls

The `vault` server (bridge `:8005`) is unlike the other four bridges: it **embeds the Agent
SDK** and makes **outbound LLM calls** to the Anthropic API. So it needs an `ANTHROPIC_API_KEY`
(the other bridges talk only to localhost and never carry a key). It also passes
`COS_VAULT_DIR=$VAULT_DIR` (i.e. `$REPO_ROOT/vault/$VAULT_NAME`) so the inner session is scoped
to the vault tree.

**The key lives in `config/secrets.env`, not in the plist.** launchd never inherits your login
shell and never expands `$VARS` inside a plist, so rather than baking the literal secret into
the installed plist, the plist's `ProgramArguments` runs the launch wrapper
**`mcp/vault-server/launch.sh`**, which sources the gitignored **`config/secrets.env`** at
startup and exports the key before exec'ing supergateway. So the secret lives in exactly one
machine-local file — never in `~/Library/LaunchAgents`, never committed. One-time setup:

```bash
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
cp "$REPO_ROOT/config/secrets.env.example" "$REPO_ROOT/config/secrets.env"   # then edit in your sk-ant-… key
# render + install the plist (no secret in it). The template's __REPO__ / __VAULT_NAME__
# placeholders are runtime-substituted from $REPO_ROOT / $VAULT_NAME (the API key has no
# placeholder — it lives in config/secrets.env):
sed -e "s#__REPO__#$REPO_ROOT#g" -e "s#__VAULT_NAME__#$VAULT_NAME#g" \
  "$REPO_ROOT/mcp/vault-server/deploy/com.chiefofstaff.mcp-vault.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist"
U=$(id -u)
launchctl bootout   gui/$U/com.chiefofstaff.mcp-vault 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-vault.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-vault
```

**Rotate** the key by editing `config/secrets.env` and `launchctl kickstart -k …/com.chiefofstaff.mcp-vault` —
no plist edit. If the file is missing/empty the bridge still boots; the vault tools just return
a clean auth error per call (fail-soft).

Because it spawns its own inner Agent SDK session, that session is **isolated** so it can't
re-enter the repo's own tools/config: `strictMcpConfig: true`, `mcpServers: {}` (no nested
MCP servers), `settingSources: ['project']` (only project settings, not user/global), and a
**scoped `cwd`** (the vault dir, not the repo root). Those four options are load-bearing —
without them the inner session would inherit this repo's MCP servers and settings and could
loop back on itself.

## The search sidecar LaunchAgent (`:8008`)

The semantic-search **sidecar** (`search/sidecar.py`, run by **`uv`**) is an HTTP daemon — not
a stdio MCP server — so it does **not** go in `.mcp.json` (same as Gmail/Calendar). It's an
*optional ranking accelerator*: the board reads the same `cases.json` and falls back to a
keyword scan whenever the sidecar is down, so this LaunchAgent is **best-effort, never required**
(see `docs/reference/search.md` for the full contract). launchd supervises it the same way as the bridges.

Create `$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-search.plist` (no supergateway — `uv`
self-provisions the venv on first launch and runs uvicorn directly):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chiefofstaff.mcp-search</string>
  <key>ProgramArguments</key><array>
    <string>$BREW_PREFIX/bin/uv</string>
    <string>run</string>
    <string>--directory</string><string>$REPO_ROOT/search</string>
    <string>uvicorn</string><string>sidecar:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8008</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- ABSOLUTE — the board writes process.cwd()/data/cases.json with cwd=board/,
         so a relative default would diverge when the board is started from repo root. -->
    <key>COS_BOARD_DATA</key><string>$REPO_ROOT/board/data/cases.json</string>
    <!-- After the one-time prefetch below, pin offline so a flaky network can't
         stall startup — the model is already in ~/.cache/huggingface. -->
    <key>HF_HUB_OFFLINE</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT/search</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_ROOT/mcp/logs/search.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_ROOT/mcp/logs/search.err.log</string>
</dict></plist>
```
> Expand `$BREW_PREFIX` / `$REPO_ROOT` from the loader when rendering this into the plist —
> launchd cannot expand `$VARS` and cannot see an nvm/asdf shim, so the `uv` path must be the
> literal `$BREW_PREFIX/bin/uv` and `PATH` must start with `$BREW_PREFIX/bin`.

**One-time model prefetch** (run once, while online, *before* setting `HF_HUB_OFFLINE=1`):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$UV_BIN" run --directory "$REPO_ROOT/search" python -c \
  "from model2vec import StaticModel; StaticModel.from_pretrained('minishlab/potion-base-8M')"
```
This downloads the ~30MB `potion-base-8M` static embedding into `~/.cache/huggingface`; from
then on the sidecar starts fully offline. (Skip it — and drop `HF_HUB_OFFLINE` — if you run
the deterministic `COS_SEARCH_EMBEDDER=hash` embedder, which needs no model.)

**Fields that matter**
- `uv run --directory "$REPO_ROOT/search"` — `uv` reads `search/pyproject.toml`, builds the venv on
  first launch (so there's no manual `pip install`), and runs `uvicorn sidecar:app`.
- `COS_BOARD_DATA` is **absolute** — see the comment above; a relative path is the classic
  cwd-divergence bug (board cwd is `board/`, not the repo root).
- The embedder is **warmed at FastAPI startup**, so `/healthz` only returns `{"ok":true}` once
  the model is loaded — which is exactly what `ensure-bridges.sh` probes (no false "up").
- `KeepAlive` + `RunAtLoad` mirror the bridges: it starts at login and restarts on crash.

Load it the same way as the bridges:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
U=$(id -u)
launchctl bootout   gui/$U/com.chiefofstaff.mcp-search 2>/dev/null
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-search.plist"
curl -s "$SEARCH_SIDECAR_URL/healthz"   # {"ok":true,...} once the model is warm
```

> **Port `:8008`** sits clear of the bridges (`:8001`/`:8002`) and the board (`:3000`). If a
> *foreign* process already holds `:8008`, the board's `POST /api/search` gets a non-JSON /
> non-2xx reply → it falls back to keyword (degrades safely); the `/healthz` probe (not a bare
> `lsof`) is what stops a false "search up".

## The guard sidecar LaunchAgent (`:8009`)

The **guard MCP** (`:8004`, in `.mcp.json`) is a thin stdio→HTTP bridge; the real classification
work lives in the **guard sidecar** (`guard/sidecar.py`, run by **`uv`**) on **`:8009`** — a uv
FastAPI daemon **exactly like the search sidecar** (its own LaunchAgent, **not** in `.mcp.json` —
it's an HTTP backend the *bridge* calls, not an MCP server). Unlike search, the guard is a
**security control**, so the MCP **fails CLOSED** when the sidecar is down (an unreachable scan
returns an `UNAVAILABLE → untrusted` verdict, never a silent "clean").

Create `$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-guardsvc.plist` — same shape as the search
plist with three differences: port `8009`, `--directory "$REPO_ROOT/guard"`, and env
`COS_GUARD_TRUST_FILE` instead of `COS_BOARD_DATA` (and **no** `HF_HUB_OFFLINE` pin — see below):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chiefofstaff.mcp-guardsvc</string>
  <key>ProgramArguments</key><array>
    <string>$BREW_PREFIX/bin/uv</string>
    <string>run</string>
    <string>--directory</string><string>$REPO_ROOT/guard</string>
    <string>uvicorn</string><string>sidecar:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8009</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- ABSOLUTE — the sidecar's ONLY writable state is this sender-trust whitelist. -->
    <key>COS_GUARD_TRUST_FILE</key><string>$REPO_ROOT/guard/data/trusted-senders.json</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT/guard</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_ROOT/mcp/logs/guardsvc.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_ROOT/mcp/logs/guardsvc.err.log</string>
</dict></plist>
```
> Expand `$BREW_PREFIX` / `$REPO_ROOT` from the loader when rendering this into the plist —
> launchd cannot expand `$VARS` and cannot see an nvm/asdf shim, so the `uv` path must be the
> literal `$BREW_PREFIX/bin/uv` and `PATH` must start with `$BREW_PREFIX/bin`.

**The classifier model is GATED.** With only the default deps (`fastapi`+`uvicorn`) the sidecar
runs in **`auto`** mode and falls back to a **deterministic heuristic** classifier — so it works
**offline out of the box** (degraded; `/healthz` reports `heuristic-fallback`, which is *why* the
plist does **not** pin `HF_HUB_OFFLINE`: there's no model cached to go offline against yet). To
switch on the real model (Meta `Llama-Prompt-Guard-2-86M`), one-time while online:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# accept the Llama license at huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M, then:
huggingface-cli login
(cd "$REPO_ROOT/guard" && "$UV_BIN" sync --extra model)   # installs torch + transformers
# (optional) prefetch the model, then add HF_HUB_OFFLINE=1 to the plist env so later starts are offline
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-guardsvc
curl -s "$GUARD_SIDECAR_URL/healthz"                   # classifier flips to promptguard:meta-llama/...
```

Load it the same way as the bridges/search sidecar (`launchctl bootout` then `bootstrap`), and
verify: `curl -s "$GUARD_SIDECAR_URL/healthz"` → `{"ok":true,"classifier":...}` once warm.
`ensure-bridges.sh` nudges it alongside search and probes `/healthz` **leniently** (a cold
sidecar listens before it's ready → WARN, not fail; the fail-closed MCP keeps you safe meanwhile).
See `docs/security/guard.md` for the full contract and the board **`/security`** whitelist UI it backs.

> For the **end-to-end model setup** — picking a named model preset, accepting the gated Llama
> license + authenticating with the current `hf` CLI, prefetching the model, the
> `COS_GUARD_MODEL`/`THRESHOLD`/`CLASSIFIER` precedence, the committed plist template, and verifying
> the real model loaded (not the heuristic) — follow the **guard-setup** skill.

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-board   # restart one
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-board   # stop one
tail -f mcp/logs/board.err.log                                    # logs
```
Add a *bridge* server: new plist (next free port), entries in both config files, the
`ensure-bridges.sh` loop, then re-bootstrap. (The search sidecar above is an HTTP daemon, not
a bridge — its plist + `ensure-bridges.sh` loop entry, but **no** `.mcp.json` entry.)

> **openwhispr add-on (`/openwhispr-mcp-setup`).** The optional voice server, `openwhispr` on
> **`:8002`**, surfaces the external OpenWhispr desktop app's local transcript store. It's wired
> exactly like the core four (a supergateway bridge in `.mcp.json` + a Cowork stdio entry) but
> lives in its **own** skill because of that external-app dependency — run
> **`/openwhispr-mcp-setup`** to add it (and `/second-brain-ingest` + the voice recipe own the
> board-side routing).
>
> **WhatsApp add-on (`/whatsapp-mcp-setup`).** Another optional server, `whatsapp`, lives in an
> **external** repo and is a worked example of wiring **both** a bridge AND a sidecar at once: the
> Python MCP as a supergateway bridge on **`:8006`** (in `.mcp.json` + Cowork stdio, exactly like
> the core four above) and the Go whatsmeow bridge as a launchd **sidecar** on **`:8010`** (like
> search/guardsvc — NOT in `.mcp.json`). Its committed plist templates are under
> `mcp/whatsapp/deploy/`. It needs a one-time **QR pairing**; follow **`/whatsapp-mcp-setup`** for
> the full runbook. Heads-up: the upstream Python server reads `WHATSAPP_BRIDGE_PORT` only for the
> **Go** bridge, so cos names its supergateway port `WHATSAPP_MCP_BRIDGE_PORT` to keep the two
> distinct.

## Gotchas (learned the hard way)
- **`brew install <anything>` can break Node.** Installing another formula may bump a shared
  lib and leave Node dangling: `dyld: Library not loaded: .../libsimdjson.NN.dylib, Referenced
  from .../bin/node`. Every `node` call (and thus every bridge) then dies (exit 133/134).
  **Fix:** `brew reinstall node` (relinks Node to the current lib). Verify: `node -v`.
- **pm2 is not used here.** pm2 6.x failed to fork on this machine (God daemon:
  `Cannot find module ProcessContainerFork.js` / `Could not _load() the script`) under the
  system Node. launchd is the supervisor. Don't reintroduce pm2.
- **supergateway exits if its stdin closes** in some shells, but launchd's `/dev/null` stdin
  is fine — it stays up. If you ever run it by hand under a wrapper that closes stdin, feed it
  `< <(tail -f /dev/null)`.
- **board needs the Next.js app on `:3000`** for tool *calls* (`npm run dev` in `board/`);
  `initialize`/`tools/list` work without it. (The openwhispr real-store-vs-fixtures gotcha now
  lives in `/openwhispr-mcp-setup`.)
- **Ports** 8001/8003/8004/8005 (core bridges) and 8008/8009 (search + guard sidecars) must be
  free (`lsof -nP -iTCP:8001 -sTCP:LISTEN`). `:8002` (openwhispr) and `:8006` (whatsapp) belong to
  the optional add-ons, wired by their own skills. The board itself runs on `:3000`.
- **search sidecar's first launch needs the network once** (to fetch the ~30MB model) and
  takes ~30s to green `/healthz`. Run the one-time prefetch above, then `HF_HUB_OFFLINE=1`
  makes every later start offline. A missing `uv` or a cold sidecar is harmless — the board
  degrades to keyword search and `ensure-bridges.sh` only WARNs.
