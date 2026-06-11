---
name: whatsapp-mcp-setup
description: Stand up WhatsApp on a new machine and wire the `whatsapp` MCP into both Claude clients — the WhatsApp add-on alongside mcp-bridge-setup. It builds the external whatsapp-mcp repo's TWO processes (the Go whatsmeow bridge, run as a launchd SIDECAR like search/guard on $WHATSAPP_GO_PORT/:8010; the Python stdio MCP, exposed to Claude Code via a supergateway bridge on $WHATSAPP_MCP_BRIDGE_PORT/:8006 and to Cowork as a direct stdio command), does the one-time QR pairing against your phone's Linked Devices, and registers `whatsapp` in `.mcp.json` + the Cowork config. Use when setting up WhatsApp on a new machine, when Cowork or Code can't see the `whatsapp` server, when the Go bridge is down, when /whatsapp-triage can't reach WhatsApp, or when the linked device was removed / the session expired and you must re-pair the QR.
---

# WhatsApp MCP setup (Go bridge sidecar :8010 + Python stdio MCP bridge :8006)

## Why this exists / architecture
`whatsapp-mcp` is an **external repo** (the user's fork
[`verygoodplugins/whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp)) checked out
**outside** this Cos repo at **`$WHATSAPP_MCP_DIR`**. It is **two processes**, and they register
into Cos the same two ways the existing servers + sidecars do — getting this split wrong is the
usual failure:

- **(a) The Go whatsmeow bridge (`:8010`)** — `whatsapp-bridge/`, a long-running HTTP daemon that
  holds the WhatsApp Web session and writes the SQLite stores. It is **treated exactly like the
  search / guard SIDECARS**: an HTTP backend, **NOT** a stdio MCP server, so it is **NOT in
  `.mcp.json`**. launchd supervises it under label **`com.chiefofstaff.mcp-whatsappbridge`**. (Its
  port is `$WHATSAPP_GO_PORT`, default **8010** — whatsmeow's own default is `8080`, but that is
  commonly taken on a dev box, so cos pins it to 8010.)
- **(b) The Python stdio MCP (`whatsapp-mcp-server/main.py`)** — a FastMCP **stdio** server
  (`mcp.run(transport="stdio")`, confirmed at `main.py:396`). It is exposed to **Claude Code** over
  HTTP via a **supergateway + launchd BRIDGE on `:8006`** (`$WHATSAPP_MCP_BRIDGE_PORT`, label
  **`com.chiefofstaff.mcp-whatsapp`**, IN `.mcp.json`), and to **Claude Cowork Desktop** as a
  **direct stdio `command` entry** — identical to how mcp-bridge-setup wires board/openwhispr/etc.

```
Claude Code   ──HTTP──> localhost:8006/mcp ──supergateway(launchd)──> uv run main.py (Python stdio MCP)
                                                                          │  reads SQLite directly (messages.db)
                                                                          └──HTTP (bearer)──> Go bridge :8010 ──whatsmeow──> WhatsApp Web
Cowork Desktop ──spawns stdio directly──> uv run --directory $WHATSAPP_MCP_DIR/whatsapp-mcp-server main.py   (§6)
                          Go bridge :8010  =  launchd SIDECAR (com.chiefofstaff.mcp-whatsappbridge), NOT in .mcp.json   (§4)
```

The Python MCP reads **`messages.db` directly** for all the READ tools, so **board-only triage
tolerates the Go bridge being down** — but a **fresh pairing or any send** needs the bridge live
(see Gotchas). The data flow mirrors the upstream contract: *AI client → Python MCP → reads SQLite
**or** calls the bridge REST (`$WHATSAPP_API_URL`) → Go bridge → WhatsApp Web.*

This add-on's processes (alongside mcp-bridge-setup's four core servers + two sidecars, and the
optional `openwhispr` voice add-on):
| process | what runs | env | port | launchd label | in `.mcp.json`? |
|---|---|---|---|---|---|
| whatsappbridge (sidecar) | `whatsapp-bridge/whatsapp-bridge` (Go) | `WHATSAPP_BRIDGE_PORT` | 8010 | `com.chiefofstaff.mcp-whatsappbridge` | **no** (HTTP backend) |
| whatsapp (MCP bridge) | `uv run --directory …/whatsapp-mcp-server main.py` via supergateway | `WHATSAPP_DB_PATH` / `WHATSMEOW_DB_PATH` / `WHATSAPP_API_URL` | 8006 | `com.chiefofstaff.mcp-whatsapp` | **yes** (`http://localhost:8006/mcp`) |

> **The bearer token is read from a file, not the env.** The Python server resolves the Go bridge's
> bearer token from `$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token` (computed relative to its
> own `__file__`), so **neither** the plist **nor** the Cowork entry needs to carry it — the live
> secret never lands in `~/Library/LaunchAgents`, and a token rotation needs no re-render.

> **Board-only.** Cos's `/whatsapp-triage` uses ONLY the **READ** subset of this MCP
> (`search_contacts`, `get_contact`, `list_messages`, `list_chats`, `get_chat`,
> `get_direct_chat_by_contact`, `get_contact_chats`, `get_last_interaction`,
> `get_message_context`, `download_media`) — it reconciles WhatsApp onto the Cos board exactly like
> mail-to-board reconciles Gmail, and **never** calls `send_message` / `send_file` /
> `send_audio_message`. This setup skill stands up the plumbing; triage owns the board side.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$UV_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`,
> `$COWORK_CONFIG`, and the **new WhatsApp keys** — `$WHATSAPP_MCP_DIR` (the external checkout),
> `$WHATSAPP_MCP_BRIDGE_PORT` (=`8006`), `$WHATSAPP_GO_PORT` (=`8010`), and the derived
> `$WHATSAPP_MCP_BRIDGE_URL` (=`http://localhost:8006`) / `$WHATSAPP_GO_URL`
> (=`http://localhost:8010`) — use those instead of hardcoding paths, the Homebrew prefix, your
> username, or ports.

## Prerequisites
- **`go`** (Homebrew: `brew install go`) — builds the whatsmeow bridge (`go build`). Required; the
  bridge is a compiled binary, there is no prebuilt one.
- **`uv`** (Homebrew: `brew install uv`) — runs the Python MCP server and provisions its venv
  (`uv sync`).
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for **Claude Code**
  (`:8006`), exactly as in mcp-bridge-setup.
- **`ffmpeg`** (optional; `brew install ffmpeg`) — only for the MCP's `send_audio_message`
  voice-note conversion. **Triage never sends**, so this is not needed for Cos; install only if you
  want outbound voice notes from other workflows.
- A **phone running WhatsApp** for the one-time QR pairing (§3) — the analog of guard's gated-model
  HuggingFace login.

Run the loader preamble as the first line of every shell block below — it exports `$REPO_ROOT`,
`$WHATSAPP_MCP_DIR`, `$UV_BIN`, `$NODE_BIN`, `$BREW_PREFIX`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
the WhatsApp ports/URLs, etc., so nothing below is hardcoded. `$U=$(id -u)` is derived inline where
`launchctl` needs it.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

## Steps

### 1. Get the source (clone the fork, or point at an existing checkout)
The whatsapp-mcp repo lives **outside** this Cos checkout; `$WHATSAPP_MCP_DIR` (from `cos.env`) is
its path. Clone the user's fork there, or set `WHATSAPP_MCP_DIR` to a checkout you already have.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
if [ -d "$WHATSAPP_MCP_DIR/.git" ]; then
  echo "whatsapp-mcp already at $WHATSAPP_MCP_DIR"
  git -C "$WHATSAPP_MCP_DIR" remote -v | grep origin   # origin should be verygoodplugins/whatsapp-mcp (the fork)
else
  git clone https://github.com/verygoodplugins/whatsapp-mcp "$WHATSAPP_MCP_DIR"
fi
```
> `$WHATSAPP_MCP_DIR` is a **`cos.env` key** (e.g. `~/Code/whatsapp-mcp`); set it there once. The
> `origin` remote is the **fork** `verygoodplugins/whatsapp-mcp`, not the upstream
> `lharries/whatsapp-mcp` — PRs/issues against this checkout target the fork.

- **CHECKPOINT** — the two components are present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  ls "$WHATSAPP_MCP_DIR/whatsapp-bridge/main.go" "$WHATSAPP_MCP_DIR/whatsapp-mcp-server/main.py" \
    && echo "source OK"
  ```

### 2. Build the bridge + install the server's deps
The Go bridge is compiled to a binary; the Python server's venv is provisioned by `uv`.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
( cd "$WHATSAPP_MCP_DIR/whatsapp-bridge"     && go build -o whatsapp-bridge . )   # produces ./whatsapp-bridge
( cd "$WHATSAPP_MCP_DIR/whatsapp-mcp-server" && "$UV_BIN" sync )                  # builds the venv from pyproject
```
- **CHECKPOINT** — the binary exists and the server imports:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  test -x "$WHATSAPP_MCP_DIR/whatsapp-bridge/whatsapp-bridge" && echo "bridge binary OK"
  "$UV_BIN" run --directory "$WHATSAPP_MCP_DIR/whatsapp-mcp-server" python -c "import main; print('server import OK')"
  ```

### 3. First-run QR pairing (HUMAN-IN-THE-LOOP — the one-time external auth)
Like guard's gated-model HuggingFace login, the bridge needs a **one-time interactive
authorization**: it prints a **QR code** you scan with your phone to link this machine as a
WhatsApp **device**. Run the bridge **by hand once** (foreground, NOT under launchd yet), on the
cos port so it doesn't collide with whatever holds `:8080`:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
cd "$WHATSAPP_MCP_DIR/whatsapp-bridge"
WHATSAPP_BRIDGE_PORT="$WHATSAPP_GO_PORT" ./whatsapp-bridge   # prints a QR code in the terminal; leave it running
```
On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**, then scan the QR. On
success the bridge logs **`Connected to WhatsApp`** and begins history backfill, and it creates,
under `whatsapp-bridge/store/` (all **gitignored** in the whatsapp-mcp repo — real chat history +
PII):
- `whatsapp.db` — the whatsmeow session/contacts/LID map (`$WHATSMEOW_DB_PATH`),
- `messages.db` — the bridge's chats + messages, the **read source of truth** for the MCP
  (`$WHATSAPP_DB_PATH`),
- `.bridge-token` — the **bearer token** every REST call to the Go bridge must present (the Python
  server reads this file itself; you don't pass it anywhere).

Once you see `Connected to WhatsApp` and the stores exist, **Ctrl-C** — launchd will own the
process from §4.
> **History backfill is controlled by the phone** (the primary device), not this machine — the
> bridge can request more (it supports a `--full-history-pair` flag) but the phone has the final
> word. A freshly paired machine may show only recent history at first; triage's per-chat cursor
> simply starts from what `messages.db` has.

- **CHECKPOINT** — the three store files exist:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  ls "$WHATSAPP_MCP_DIR/whatsapp-bridge/store/whatsapp.db" \
     "$WHATSAPP_MCP_DIR/whatsapp-bridge/store/messages.db" \
     "$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token" && echo "store OK"
  ```

### 4. Install the Go bridge as a launchd SIDECAR (`:8010`)
The bridge is an HTTP daemon (like search/guard sidecars), so it gets a LaunchAgent but **no
`.mcp.json` entry**. Install from the committed template — same pattern as the guardsvc/vault
templates — substituting the loader's absolute paths + the Go port (launchd cannot expand `$VARS`,
so the rendered plist carries literal values):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
sed -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__WHATSAPP_MCP_DIR__#$WHATSAPP_MCP_DIR#g" \
    -e "s#__BREW_PREFIX__#$BREW_PREFIX#g" \
    -e "s#__WHATSAPP_GO_PORT__#$WHATSAPP_GO_PORT#g" \
  "$REPO_ROOT/mcp/whatsapp/deploy/com.chiefofstaff.mcp-whatsappbridge.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-whatsappbridge.plist"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-whatsappbridge 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-whatsappbridge.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-whatsappbridge
```
The template runs the built `whatsapp-bridge` binary with `WHATSAPP_BRIDGE_PORT=$WHATSAPP_GO_PORT`,
`WorkingDirectory` = `$WHATSAPP_MCP_DIR/whatsapp-bridge` (so it finds `store/`), `RunAtLoad` +
`KeepAlive`, a `PATH` that starts with `$BREW_PREFIX/bin`, and logs to
`$REPO_ROOT/mcp/logs/whatsappbridge.{out,err}.log`.

> **Probe leniently — it is bearer-token protected.** The REST API requires the `.bridge-token`
> bearer, so an **unauthenticated** `curl` returns **401, not 200** — a bare 200 is NOT the health
> signal. The signal is: **the port is listening** AND the log says **`Connected to WhatsApp`** (the
> session is live). Don't treat the 401 as a failure.
- **CHECKPOINT** — port up + session connected:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  lsof -nP -iTCP:"$WHATSAPP_GO_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "bridge listening on :$WHATSAPP_GO_PORT"
  grep -q "Connected to WhatsApp" "$REPO_ROOT/mcp/logs/whatsappbridge.out.log" 2>/dev/null && echo "session connected"
  # An authenticated probe (optional) — should NOT be 401 with the token:
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat "$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token")" \
    "$WHATSAPP_GO_URL/api/chats" ; echo
  ```

### 5. Install the Python MCP supergateway BRIDGE (`:8006`)
The stdio MCP is bridged to HTTP for Claude Code exactly like mcp-bridge-setup's servers — one
supergateway LaunchAgent on `:8006`. Install from the committed template, substituting the loader's
paths + both ports:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
sed -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__WHATSAPP_MCP_DIR__#$WHATSAPP_MCP_DIR#g" \
    -e "s#__BREW_PREFIX__#$BREW_PREFIX#g" \
    -e "s#__WHATSAPP_MCP_BRIDGE_PORT__#$WHATSAPP_MCP_BRIDGE_PORT#g" \
    -e "s#__WHATSAPP_GO_PORT__#$WHATSAPP_GO_PORT#g" \
  "$REPO_ROOT/mcp/whatsapp/deploy/com.chiefofstaff.mcp-whatsapp.plist.template" \
  > "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-whatsapp.plist"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-whatsapp 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-whatsapp.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-whatsapp
```
The plist's `EnvironmentVariables` carry the **three** vars the Python server reads to find its
stores + the Go bridge (all absolute / explicit):
- `WHATSAPP_DB_PATH` = `$WHATSAPP_MCP_DIR/whatsapp-bridge/store/messages.db`,
- `WHATSMEOW_DB_PATH` = `$WHATSAPP_MCP_DIR/whatsapp-bridge/store/whatsapp.db`,
- `WHATSAPP_API_URL` = **`http://localhost:$WHATSAPP_GO_PORT/api`** (pinned to the Go bridge — see the Gotcha).

The bearer token is **not** in the plist — the server reads `store/.bridge-token` itself.

> **Do NOT set `WHATSAPP_BRIDGE_PORT` in this plist.** It is read by the **Go** bridge only (the
> port it binds); the Python MCP ignores it and reaches the Go bridge solely via `WHATSAPP_API_URL`.
> Setting it here would be a silent no-op. The supergateway bridge port (8006) is named
> **`WHATSAPP_MCP_BRIDGE_PORT`** in `cos.env` and passed to supergateway's `--port`. (See Gotchas.)

- **CHECKPOINT** — an MCP `initialize` on `:8006` returns `serverInfo.name == "whatsapp"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$WHATSAPP_MCP_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"whatsapp"' && echo "whatsapp MCP bridge OK"
  ```

### 6. Register BOTH clients (each registers differently!)
As in mcp-bridge-setup, the two clients register **differently** — getting this wrong is the usual
failure.

**Claude Code — HTTP via the bridge.** Add `whatsapp` to `$REPO_ROOT/.mcp.json` pointing at the
`:8006` supergateway bridge from §5:
```json
{ "mcpServers": {
  "whatsapp": { "type": "http", "url": "http://localhost:8006/mcp" }
}}
```
(Merge it alongside the existing `board`/`openwhispr`/`calendar`/`guard`/`vault` entries — don't
clobber them.)

**Claude Cowork Desktop — direct stdio.** `claude_desktop_config.json` (`$COWORK_CONFIG`) accepts
**stdio `command` servers only** (an HTTP `url` is rejected — same validated rule as
mcp-bridge-setup §5). Cowork spawns the Python MCP itself via `uv`. Write it from config with a
**backup-first node merge** that preserves the other servers + `preferences` and refreshes the
`whatsapp` entry from the **resolved** loader values — mirroring mcp-bridge-setup's Cowork merge
script exactly:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # resolves UV_BIN/WHATSAPP_MCP_DIR/ports/COWORK_CONFIG from cos.env
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env;
const store = `${E.WHATSAPP_MCP_DIR}/whatsapp-bridge/store`;
const goPort = E.WHATSAPP_GO_PORT || '8010';
const server = {
  command: E.UV_BIN,
  args: ['run', '--directory', `${E.WHATSAPP_MCP_DIR}/whatsapp-mcp-server`, 'main.py'],
  env: {                                            // the SAME three vars as the §5 bridge (token read from store/.bridge-token)
    WHATSAPP_DB_PATH:  `${store}/messages.db`,
    WHATSMEOW_DB_PATH: `${store}/whatsapp.db`,
    WHATSAPP_API_URL:  `http://localhost:${goPort}/api`,   // pin to the Go bridge port — NOT the :8006 MCP-bridge port
  },
};
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
cfg.mcpServers = { ...(cfg.mcpServers||{}), whatsapp: server };   // refresh OURS; keep other servers + preferences intact
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');            // back up before write
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
```
> The `whatsapp` Cowork entry carries the **same three vars** as the §5 bridge — `WHATSAPP_API_URL`
> pinned to the **Go bridge** (`http://localhost:$WHATSAPP_GO_PORT/api`), never the `:8006`
> MCP-bridge port; the token is read from `store/.bridge-token` by the server. To add ONLY this
> server (not refresh all), keep the same preamble and assign just `cfg.mcpServers.whatsapp`.

- **Absolute `uv` path** (`$UV_BIN`, from the loader): Claude Desktop's spawn env, like launchd's,
  lacks Homebrew on `PATH`.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `whatsapp`
  appears in Cowork's tools.

- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"whatsapp"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.whatsapp?0:1)' \
    && echo "Cowork config OK"
  ```

### 7. Wire into `mcp/ensure-bridges.sh`
Add the two processes to the existing nudge loops so `npm run dev/start` brings WhatsApp up with the
rest. `ensure-bridges.sh` has a `for svc in …` bootstrap/kickstart loop and a `for pair in "<port>
<name>" …` probe loop (port first):
- Add **`whatsapp whatsappbridge`** to the `for svc in board openwhispr … guardsvc` loop (each maps
  to `com.chiefofstaff.mcp-$svc`).
- Add **`"8006 whatsapp"`** and **`"8010 whatsappbridge"`** to the `for pair in …` probe list. Both
  fall through to the standard `lsof … LISTEN` branch (not the `/healthz` branch, which is only for
  the search/guardsvc uv sidecars). A cold/unpaired Go bridge that isn't listening yet just prints a
  `WARN … DOWN` — board-only triage still reads SQLite, so that's a nudge, not a hard failure.
- **CHECKPOINT** — the script bootstraps both and reports them up:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  "$REPO_ROOT/mcp/ensure-bridges.sh" | grep -Ei 'whatsapp'
  # expect: "[mcp] whatsapp bridge up on :8006" and "[mcp] whatsappbridge bridge up on :8010"
  ```

### 8. End-to-end verify
Confirm the whole add-on works from the MCP surface, not just the ports:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# (a) list_chats through the whatsapp MCP returns real chats (reads messages.db):
curl -s -X POST "$WHATSAPP_MCP_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_chats","arguments":{"limit":3}}}' \
  | grep -o '"jid"' | head -1 && echo "list_chats returned data"
# (b) the Go bridge session is live:
grep -q "Connected to WhatsApp" "$REPO_ROOT/mcp/logs/whatsappbridge.out.log" && echo "bridge connected"
```
- **CHECKPOINT** — `list_chats` returns chat data, the bridge log shows `Connected to WhatsApp`,
  and both clients see `whatsapp` after a ⌘Q reopen. The **cursor/board flow** (per-chat watermark
  at `$REPO_ROOT/config/whatsapp-triage-state.json`, guard-scanned untrusted input, board
  reconciliation) is then exercised by **`/whatsapp-triage`** — that skill owns the board side; this
  one only proves the plumbing.

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-whatsapp        # restart the MCP bridge
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-whatsappbridge  # restart the Go sidecar
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-whatsapp        # stop the MCP bridge
tail -f mcp/logs/whatsappbridge.out.log                                  # Go bridge log ("Connected to WhatsApp")
tail -f mcp/logs/whatsapp.err.log                                        # supergateway / Python MCP log
```
Re-pair after a session loss: stop both agents, repeat **§3** (foreground
`WHATSAPP_BRIDGE_PORT=$WHATSAPP_GO_PORT ./whatsapp-bridge`, scan the new QR), then `kickstart -k`
both agents. The token may rotate, but the server reads it from `store/.bridge-token` at runtime, so
**no plist/Cowork re-render is needed** — just restart the agents to pick up a fresh session.

## Gotchas (read before editing)
- **`WHATSAPP_BRIDGE_PORT` is the GO bridge's var — the Python MCP never reads it.** Only the Go
  whatsmeow bridge (`whatsapp-bridge/main.go`) reads `WHATSAPP_BRIDGE_PORT`, as the port it **binds**.
  The Python MCP server reads only `WHATSAPP_DB_PATH`, `WHATSMEOW_DB_PATH`, `WHATSAPP_API_URL`, and
  `WHATSAPP_BRIDGE_TOKEN` (`whatsapp.py`) — it locates the Go bridge **solely via `WHATSAPP_API_URL`**.
  So: the **Go sidecar plist** sets `WHATSAPP_BRIDGE_PORT=$WHATSAPP_GO_PORT`; the **Python MCP plist**
  must **not** set it (a silent no-op). On the cos side the two ports get **distinct names** —
  `WHATSAPP_MCP_BRIDGE_PORT` (the supergateway bridge, 8006) and `WHATSAPP_GO_PORT` (the Go sidecar,
  8010) — keeping the literal `WHATSAPP_BRIDGE_PORT` confined to the one plist that owns it. Pin
  `WHATSAPP_API_URL=http://localhost:$WHATSAPP_GO_PORT/api` so the server reaches the Go bridge
  explicitly, no matter what.
- **Why :8010, not :8080.** whatsmeow's default bridge port is `8080`, which is commonly already
  taken on a dev machine. cos pins the Go bridge to `$WHATSAPP_GO_PORT` (default **8010**) in the
  sidecar plist and the §3 pairing run, and points `WHATSAPP_API_URL` at it. If `8010` is also taken,
  change `WHATSAPP_GO_PORT` in `cos.env` and re-render §4/§5.
- **Reads work straight from SQLite even if the Go bridge is down.** The Python MCP reads
  `messages.db` directly for all READ tools, so **board-only `/whatsapp-triage` tolerates a down Go
  bridge** (it never needs the bridge for reads). But a **fresh pairing or ANY send** needs the
  bridge live — so keep the sidecar's probe in §7 lenient and don't make triage depend on it.
- **Re-pair when the linked device is removed or the session expires.** If you remove this machine
  from the phone's **Linked Devices**, or WhatsApp expires the session, the bridge logs a
  disconnect and reads go stale. Redo **§3** (foreground `./whatsapp-bridge` on `$WHATSAPP_GO_PORT`,
  scan the new QR), then restart both agents.
- **A Go toolchain is required to build.** There is no prebuilt bridge binary — `go build` is
  mandatory in §2. Missing `go` → no daemon → no pairing and no sends (reads still work off an
  existing `messages.db`, but a fresh machine has none until §3 runs).
- **`store/` holds real chat history + PII and is gitignored in the whatsapp-mcp repo.**
  `whatsapp.db`, `messages.db`, the per-chat media under `store/{chat_jid}/`, and `.bridge-token`
  are all sensitive and machine-local — never commit them. The token never enters a committed file
  or the installed plist (the server reads it from `store/`). Cos's encrypted backup covers the Cos
  repo's own stores, **not** this external `store/`.
- **Ports `8006` and `8010` must be free** (`lsof -nP -iTCP:8006 -sTCP:LISTEN`,
  `lsof -nP -iTCP:8010 -sTCP:LISTEN`). `8006` sits just past mcp-bridge-setup's `8001–8005`
  bridges; `8010` sits just past the `8008/8009` sidecars. A foreign process on either breaks the
  corresponding step — pick another free port in `cos.env` if so.
- **launchd cannot expand `$VARS`.** As with every Cos plist, the **rendered** plists in
  `~/Library/LaunchAgents` carry **literal absolute paths** (`sed`-substituted from the loader in
  §4/§5) and a `PATH` that starts with `$BREW_PREFIX/bin` — launchd never inherits your login shell
  and can't see an nvm/asdf shim, so the `uv` / `go`-built binary paths must be literal, not a
  `command -v` shim.
