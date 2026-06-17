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
> username. (The plists are **generated** from the co-located `mcp/<name>-server/<name>.service.json`
> descriptors by `scripts/gen-launchd.mjs`, which resolves every `${VAR}` from the loader — see
> `mcp/CLAUDE.md`; the Anthropic key is never in a descriptor/plist — it stays in
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

### 2. Render + install the LaunchAgent plists from the manifest
Each service is declared once in a co-located descriptor `mcp/<name>-server/<name>.service.json`
(+ `guard/guardsvc.service.json`, `search/search.service.json`), resolved by
`mcp/service-manifest.mjs` against `config/load-config.sh`. `scripts/gen-launchd.mjs` renders the
plist from that descriptor — expanding `$BREW_PREFIX` / `$REPO_ROOT` / `$BOARD_URL` / the port from
the loader (board → `8001` + `CRM_BASE_URL`; calendar → `8003` + `CRM_BASE_URL`; guard → `8004` +
`COS_GUARD_URL`; vault → `8005` + `ANTHROPIC_API_KEY` (via its secret-wrapper `launch.sh`) +
`COS_VAULT_DIR=$VAULT_DIR`) — and on macOS `--install` also does the `launchctl bootout → bootstrap
→ kickstart` reload in the **same step**. With no names it installs the **core** services
(board calendar guard vault search guardsvc):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install   # core: board calendar guard vault search guardsvc
```

> `--print <name>` renders one plist to stdout for review, `--out <dir>` writes copies without
> touching `~/Library/LaunchAgents`; only `--install` touches the real LaunchAgents dir. The
> installed plists stay gitignored + machine-specific (absolute paths) exactly as before — only
> their SOURCE moved from per-server `*.plist.template` files to the descriptors. See `mcp/CLAUDE.md`
> for the descriptor schema.

The generator handles the details the old hand-authored plist spelled out, so they still hold:
- `--outputTransport streamableHttp` + `--streamableHttpPath /mcp` → URL is `http://localhost:PORT/mcp`.
- `--cors` is **required** for the HTTP clients (Claude Code over the bridge, and the Desktop
  Connector UI) — they connect from a different origin. (Cowork itself uses §5 stdio, no CORS.)
- `PATH` leads with `$BREW_PREFIX/bin`: launchd's default PATH lacks Homebrew, but
  supergateway's `#!/usr/bin/env node` shebang and the `--stdio "node ..."` child both need `node`.
  launchd cannot expand `$VARS` and cannot see an nvm/asdf shim, so the plist carries literal
  `$BREW_PREFIX/bin/node` / `$BREW_PREFIX/bin/supergateway` paths — the resolver bakes these in.
- `--stdio "$BREW_PREFIX/bin/node <abs path>"` is **one** array element. Absolute paths throughout
  (the servers `path.resolve()` them).
- `COS_MCP_IDLE_EXIT_MS=300000` is set on every node **bridge** (the descriptor's `idleExit:true`),
  the bridge's **opt-in** to mcp-kit's idle-child reaper, which is **off by default** — see
  ["Why bridges set COS_MCP_IDLE_EXIT_MS"](#why-bridges-set-cos_mcp_idle_exit_ms). It is never set
  on the sidecars or the Cowork direct-stdio entry.

The `-guard` bridge has a **second process** — its own `-guardsvc` **uv sidecar** on `:8009` (see
["The guard sidecar LaunchAgent"](#the-guard-sidecar-launchagent-8009) below), exactly as search
does; both are core, so the `--install` above renders them too.

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

Verify every installed node bridge carries the opt-in (the generator sets it from each bridge
descriptor's `idleExit:true`, so this is a quick post-install sanity check that the render landed):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
for s in board calendar guard vault openwhispr; do
  printf '%s: ' "$s"
  plutil -p "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-$s.plist" | grep -o 'COS_MCP_IDLE_EXIT_MS" => "[0-9]*"' || echo "MISSING — add it + reload, or this bridge leaks idle children"
done
```

### 3. Confirm they loaded
The `--install` in §2 already did the `bootout → bootstrap → kickstart` reload on macOS, so the
agents are loaded + running with `RunAtLoad`+`KeepAlive` (login boot + crash-restart). Confirm:
```sh
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
hand-type machine paths or the API key into it. `scripts/gen-cowork-config.mjs` builds each entry
from the same manifest the launchd/Windows supervisors read, **backs up first** (to `.bak`),
preserves `preferences`/other keys, and inlines the `vault` secret from `config/secrets.env`. Name
the four core servers (a named merge is additive and won't touch a third-party server you added by
hand); re-running it fixes drift (e.g. a missing `vault` — the most common gap, since it's the only
one needing the key + a vault dir):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# Precondition: $COWORK_CONFIG must point at the REAL Cowork config (cos-setup detects + records it;
# default macOS path below, %APPDATA%/Claude on Windows). Confirm its dir exists before merging —
# the generator refuses a missing dir rather than writing an orphan config Cowork never reads.
[ -d "$(dirname "$COWORK_CONFIG")" ] || echo "FIX FIRST: set COWORK_CONFIG in config/cos.env to your real claude_desktop_config.json (dir '$(dirname "$COWORK_CONFIG")' missing — Cowork installed?)"
node "$REPO_ROOT/scripts/gen-cowork-config.mjs" board calendar guard vault
```
> Only `vault` carries `ANTHROPIC_API_KEY` (it makes outbound LLM calls — see
> ["The vault server makes outbound LLM calls"](#the-vault-server-makes-outbound-llm-calls)); the
> generator inlines it from `config/secrets.env` (Cowork can't run the macOS secret-wrapper) — the
> other servers are localhost-only and carry no secret. `--print` shows the generated block with the
> key value redacted. With **no** names it's a full resync of every cos bridge (and prunes cos-owned
> entries the manifest no longer defines); add-ons name just their own server from their own skill.

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
pointing at the supergateway bridges from §2–3. It is **committed + CI-checked** and **generated**
from the manifest — don't hand-edit it; just regenerate (a no-op if already in sync):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-mcp-json.mjs"   # writes REPO/.mcp.json from the manifest (CI verifies it matches)
```
The generated entries look like (one per `claude-code` bridge, port-ascending):
```json
{ "mcpServers": {
  "board":      { "type": "http", "url": "http://localhost:8001/mcp" },
  "calendar":   { "type": "http", "url": "http://localhost:8003/mcp" },
  "guard":      { "type": "http", "url": "http://localhost:8004/mcp" },
  "vault":      { "type": "http", "url": "http://localhost:8005/mcp" }
}}
```
> The optional `openwhispr` (`:8002`) and `whatsapp` (`:8006`) entries land in `.mcp.json` once their
> own setup skills (`/openwhispr-mcp-setup`, `/whatsapp-mcp-setup`) install the descriptor and
> regenerate — the generator picks up every bridge in the manifest, so nothing is merged by hand.

#### Claude Desktop — HTTP alternatives (only if you prefer the bridge / can't use stdio)
- **Custom Connector UI** — Settings → Connectors → Add custom connector →
  `$BOARD_BRIDGE_URL/mcp` (and the other bridge URLs). Uses the §2–4 bridges; no config-file entry, no
  OAuth for a localhost no-auth endpoint. (The bridges serve plain streamable-HTTP — verify
  with the SDK `StreamableHTTPClientTransport`, which connects + lists tools.)
- **`mcp-remote` stdio shim** — `{"command":"npx","args":["-y","mcp-remote","<url>"]}` — the
  generic config-file workaround for HTTP servers, but it currently chokes on supergateway
  with `Unexpected content type: null`. Prefer the direct stdio above (it's simpler anyway).

### 6. The app brings the bridges up (already wired — no edit)
`mcp/ensure-bridges.sh` + `mcp/ensure-bridges.cjs` are **committed**; you don't author them. And
`board/package.json` already chains them via `predev`/`prestart` so starting the app guarantees the
bridges are up first (cross-platform, no `sh` in the npm script):
```json
"predev":   "node ../mcp/ensure-bridges.cjs",
"prestart": "node ../mcp/ensure-bridges.cjs"
```
`ensure-bridges.cjs` is the platform dispatcher: on Windows it runs `mcp/cos-services.cjs start`;
everywhere else it runs `mcp/ensure-bridges.sh`. That shell script is a **thin consumer of the
service manifest** — it iterates `node mcp/service-manifest.mjs --probe-list` (NOT a hardcoded
service list), and on macOS bootstraps + kickstarts each installed LaunchAgent then probes it.

**One-way on purpose** — it NEVER stops a bridge (Cowork needs them even when the dev app is down),
launchd stays the real supervisor (boot + crash-restart), and it always exits 0 so a bridge hiccup
can't block `next dev`. An optional add-on with no installed plist is skipped silently (no WARN
about `:8002`/`:8006`). If you start the app another way, run `sh mcp/ensure-bridges.sh` there too.

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
# render + install the plist (no secret in it). The vault plist is generated from
# mcp/vault-server/vault.service.json by scripts/gen-launchd.mjs — its ProgramArguments runs the
# secret-wrapper launch.sh (which sources config/secrets.env), and $REPO_ROOT / $VAULT_DIR resolve
# from the loader; the API key has no placeholder — it lives only in config/secrets.env. --install
# also reloads via launchctl. (This is included in the core `gen-launchd.mjs --install` in §2.)
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install vault
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

The search plist is generated from `search/search.service.json` by `scripts/gen-launchd.mjs` (no
supergateway — `uv` self-provisions the venv on first launch and runs uvicorn directly): the
descriptor declares port `8008`, `--directory "$REPO_ROOT/search"`, and the env `COS_BOARD_DATA`
(absolute — the board writes `process.cwd()/data/cases.json` with cwd `board/`) + `HF_HUB_OFFLINE=1`
(pins offline once the model is cached, after the one-time prefetch below). `search` is core, so the
default `gen-launchd.mjs --install` in §2 already installs + reloads it; to (re)do just this one:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install search
curl -s "$SEARCH_SIDECAR_URL/healthz"   # {"ok":true,...} once the model is warm
```

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
- `KeepAlive` + `RunAtLoad` mirror the bridges (the descriptor renders them): it starts at login
  and restarts on crash.

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

The guardsvc plist is generated from `guard/guardsvc.service.json` by `scripts/gen-launchd.mjs` —
same shape as the search sidecar with three differences: port `8009`, `--directory "$REPO_ROOT/guard"`,
and env `COS_GUARD_TRUST_FILE` (absolute — the sidecar's only writable state, the sender-trust
whitelist) instead of `COS_BOARD_DATA` (and **no** `HF_HUB_OFFLINE` pin — see below). `guardsvc` is
core, so the default `gen-launchd.mjs --install` in §2 already installs + reloads it; to (re)do just
this one: `node "$REPO_ROOT/scripts/gen-launchd.mjs" --install guardsvc`.

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
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install guardsvc   # re-render + reload the sidecar
curl -s "$GUARD_SIDECAR_URL/healthz"                   # classifier flips to promptguard:meta-llama/...
```

`ensure-bridges.sh` nudges it alongside search and probes `/healthz` **leniently** (a cold
sidecar listens before it's ready → WARN, not fail; the fail-closed MCP keeps you safe meanwhile).
See `docs/security/guard.md` for the full contract and the board **`/security`** whitelist UI it backs.

> For the **end-to-end model setup** — picking a named model preset, accepting the gated Llama
> license + authenticating with the current `hf` CLI, prefetching the model, setting
> `COS_GUARD_MODEL`/`COS_GUARD_THRESHOLD` in `config/cos.env`, and verifying the real model loaded
> (not the heuristic) — follow the **guard-setup** skill.

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-board   # restart one
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-board   # stop one
tail -f mcp/logs/board.err.log                                    # logs
```
Add a *bridge* server: the port in `config/load-config.sh`, one descriptor
`mcp/<name>-server/<name>.service.json`, then the generators — `gen-launchd.mjs --install <name>`,
`gen-mcp-json.mjs`, `gen-cowork-config.mjs <name>`. No second port map, no `ensure-bridges.sh` edit
(it reads the manifest). See the **"Add a new MCP — the checklist"** in `mcp/CLAUDE.md`. (The search
sidecar above is an HTTP daemon, not a bridge — its descriptor has `clients:[]`, so **no** `.mcp.json`
or Cowork entry.)

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
> search/guardsvc — NOT in `.mcp.json`). Its plists are generated from the descriptors under
> `mcp/whatsapp/` by `scripts/gen-launchd.mjs` (see `mcp/CLAUDE.md`). It needs a one-time **QR
> pairing**; follow **`/whatsapp-mcp-setup`** for
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
