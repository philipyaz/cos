---
name: openwhispr-mcp-setup
description: Stand up the `openwhispr` voice-notes MCP on a new machine and wire it into both Claude clients — the OpenWhispr add-on alongside mcp-bridge-setup (like whatsapp-mcp-setup). It exposes the external OpenWhispr desktop app's local transcript store (a SQLite DB + `.webm` recordings under `~/Library/Application Support/open-whispr/`) as a stdio MCP, fronted by a supergateway + launchd bridge on $OPENWHISPR_BRIDGE_PORT/:8002 for Claude Code and a direct stdio command for Cowork, and owns the watermark that makes voice ingestion idempotent. Use when setting up OpenWhispr/voice on a new machine, when Cowork or Code can't see the `openwhispr` server, when the openwhispr bridge (:8002) is down, when the voice ingest loop can't find notes, or when list_transcripts is stuck on fixtures instead of the real store.
---

# OpenWhispr MCP setup (voice-notes add-on — stdio MCP bridge :8002)

## Why this exists / architecture
`openwhispr` is the **optional voice add-on**. Unlike the core Cos servers (board, calendar,
guard, vault), it has an **external-app dependency**: it does nothing but expose the
[OpenWhispr](https://openwhispr.com) desktop app's **local transcript store**, so it only makes
sense on a machine where you actually use OpenWhispr. That's why it lives in its own skill — the
same shape as **whatsapp-mcp-setup** (which integrates an external app + needs pairing). board /
calendar / guard / vault stay in **mcp-bridge-setup**; this skill adds the one optional voice
server on top.

It is a **single process** — `mcp/openwhispr-server/server.mjs`, a Node **stdio** MCP server — and
it registers into Cos the same two ways the core servers do:

- **Claude Code** reaches it over **HTTP** via a **supergateway + launchd BRIDGE on `:8002`**
  (`$OPENWHISPR_BRIDGE_PORT`, label `com.chiefofstaff.mcp-openwhispr`, IN `.mcp.json`).
- **Claude Cowork Desktop** spawns it as a **direct stdio `command` entry** in
  `claude_desktop_config.json` — identical to how mcp-bridge-setup wires board/calendar/etc.

```
Claude Code   ──HTTP──> localhost:8002/mcp ──supergateway(launchd)──> node openwhispr-server (stdio)
                                                                          │ reads READ-ONLY (sqlite3 CLI)
                                                                          └──> ~/Library/Application Support/open-whispr/
                                                                               transcriptions.db + audio/*.webm
Cowork Desktop ──spawns stdio directly──────────────────────────────────> node openwhispr-server   (§4)
```

The server reads the store **read-only** (via the `sqlite3` CLI; WAL lets it read safely alongside a
running OpenWhispr — though a *clean* shutdown can transiently remove the `-shm` file a read-only open
needs, see **Gotchas**) and owns the **watermark** (`state/watermark.json`) that
makes the voice ingest loop idempotent — `list_transcripts → route → mark_processed` never
re-emits a routed note. The board-side routing is owned by `/second-brain-ingest` + the voice
recipe; this skill only stands up the plumbing.

This add-on's one process (alongside mcp-bridge-setup's four core servers + two sidecars):
| process | what runs | env | bridge port | launchd label | in `.mcp.json`? |
|---|---|---|---|---|---|
| openwhispr (MCP bridge) | `node mcp/openwhispr-server/server.mjs` via supergateway | `OPENWHISPR_DB` + `OPENWHISPR_AUDIO_DIR` (the **real** store) | 8002 | `com.chiefofstaff.mcp-openwhispr` | **yes** (`http://localhost:8002/mcp`) |

**Tools (4):** `list_transcripts` (unprocessed-by-default, watermark-filtered), `get_transcript`
(full text + `audio_path` metadata), `get_watermark`, `mark_processed` (advances the watermark —
the idempotency primitive). See `mcp/openwhispr-server/README.md` for the full contract.

> Machine config comes from the loader (run the preamble in §1): it exports `$REPO_ROOT`,
> `$BREW_PREFIX`, `$NODE_BIN`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
> `$OPENWHISPR_DB`, `$OPENWHISPR_AUDIO_DIR`, and `$OPENWHISPR_BRIDGE_PORT` (=`8002`) /
> `$OPENWHISPR_BRIDGE_URL` (=`http://localhost:8002`) — use those instead of hardcoding paths, the
> Homebrew prefix, your username, or the port.

## Prerequisites
- **Node + npm** (Homebrew) and the server's deps: `(cd mcp/openwhispr-server && npm i)`.
- **`supergateway`** (`npm install -g supergateway`) — the stdio→HTTP bridge for Claude Code,
  exactly as in mcp-bridge-setup.
- **The OpenWhispr desktop app installed, with at least one recorded note** — this is the external
  dependency (the analog of whatsapp's phone pairing / guard's HuggingFace login). Without it there
  is no `transcriptions.db` to read; you can still wire everything against the bundled **fixtures**
  for a dry run (§1), but production needs the real store.

Run the loader preamble as the first line of every shell block below — it exports `$REPO_ROOT`,
`$NODE_BIN`, `$BREW_PREFIX`, `$SUPERGATEWAY_BIN`, `$LAUNCH_AGENTS_DIR`, `$COWORK_CONFIG`,
`$OPENWHISPR_DB`, `$OPENWHISPR_AUDIO_DIR`, the bridge port/URL, etc., so nothing below is
hardcoded. `$U=$(id -u)` is derived inline where `launchctl` needs it.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

## Steps

### 1. Confirm the OpenWhispr store (the external dependency)
The server reads OpenWhispr's Electron `userData` dir — `transcriptions.db` (transcript text) +
`audio/*.webm` (recordings, mapped to each note by the trailing `-<id>`). Check it exists:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
[ -f "$OPENWHISPR_DB" ] && echo "OpenWhispr store found: $OPENWHISPR_DB" \
                       || echo "No store at $OPENWHISPR_DB — install OpenWhispr + record a note, or use fixtures (below)"
ls -d "$OPENWHISPR_AUDIO_DIR" 2>/dev/null && echo "audio dir OK"
```
- **No store yet?** Either install OpenWhispr and record one note, or wire everything against the
  bundled **fixtures** for a dry run by setting `OPENWHISPR_FIXTURES="$REPO_ROOT/mcp/openwhispr-server/fixtures"`
  in §2–4 instead of `OPENWHISPR_DB` — but **never leave `OPENWHISPR_FIXTURES` set in the real
  plist/Cowork config** (that's the classic "stuck on fixtures" bug — see Gotchas).
- **CHECKPOINT** — `$OPENWHISPR_DB` exists (or you've consciously chosen the fixtures path).

### 2. Verify the stdio server runs
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
(cd "$REPO_ROOT/mcp/openwhispr-server" && npm i >/dev/null 2>&1)
OPENWHISPR_DB="$OPENWHISPR_DB" OPENWHISPR_AUDIO_DIR="$OPENWHISPR_AUDIO_DIR" \
  "$NODE_BIN" "$REPO_ROOT/mcp/openwhispr-server/server.mjs"   # Ctrl-C; prints "openwhispr MCP server ready (tools: …)"
```
- **CHECKPOINT** — the ready line prints the four tool names. (To prove it sees the **real** store,
  §6's `list_transcripts` will report `Source: sqlite`.)

### 3. Install the launchd BRIDGE (`:8002`)
Unlike vault/whatsapp there is **no committed plist template** — author the plist inline, exactly
like mcp-bridge-setup's board plist but on port `8002`, server `openwhispr-server`, and env
`OPENWHISPR_DB` + `OPENWHISPR_AUDIO_DIR` (the **real** voice store) instead of `CRM_BASE_URL`.
Expand `$BREW_PREFIX` / `$REPO_ROOT` / `$OPENWHISPR_DB` / `$OPENWHISPR_AUDIO_DIR` from the loader
when rendering it (launchd cannot expand `$VARS` and cannot see an nvm/asdf shim, so the paths must
be **literal absolute** and `PATH` must start with `$BREW_PREFIX/bin`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chiefofstaff.mcp-openwhispr</string>
  <key>ProgramArguments</key><array>
    <string>$BREW_PREFIX/bin/supergateway</string>
    <string>--stdio</string><string>$BREW_PREFIX/bin/node $REPO_ROOT/mcp/openwhispr-server/server.mjs</string>
    <string>--outputTransport</string><string>streamableHttp</string>
    <string>--port</string><string>8002</string>
    <string>--streamableHttpPath</string><string>/mcp</string>
    <string>--cors</string>
    <string>--logLevel</string><string>info</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- ABSOLUTE — the server path.resolve()s these; point at the REAL store, never fixtures. -->
    <key>OPENWHISPR_DB</key><string>$OPENWHISPR_DB</string>
    <key>OPENWHISPR_AUDIO_DIR</key><string>$OPENWHISPR_AUDIO_DIR</string>
    <!-- Idle-exit OPT-IN — like the core bridges. mcp-kit's idle-exit is OFF by default (so a
         direct stdio client never dies on idle); this supergateway bridge opts in to reap
         supergateway's leaked idle stateless child. See mcp-bridge-setup → "Why bridges set
         COS_MCP_IDLE_EXIT_MS". Do NOT set this in the Cowork config (it relies on the default). -->
    <key>COS_MCP_IDLE_EXIT_MS</key><string>300000</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_ROOT/mcp/logs/openwhispr.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_ROOT/mcp/logs/openwhispr.err.log</string>
</dict></plist>
```
Load it the same way as the core bridges:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"; U=$(id -u)
mkdir -p "$REPO_ROOT/mcp/logs"
launchctl bootout   gui/$U/com.chiefofstaff.mcp-openwhispr 2>/dev/null || true
launchctl bootstrap gui/$U "$LAUNCH_AGENTS_DIR/com.chiefofstaff.mcp-openwhispr.plist"
launchctl kickstart -k gui/$U/com.chiefofstaff.mcp-openwhispr
```
- **CHECKPOINT** — an MCP `initialize` on `:8002` returns `serverInfo.name == "openwhispr"`:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  curl -s -X POST "$OPENWHISPR_BRIDGE_URL/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"openwhispr"' && echo "openwhispr bridge OK"
  ```

### 4. Register BOTH clients (each registers differently!)
As in mcp-bridge-setup, the two clients register **differently** — getting this wrong is the usual
failure.

**Claude Code — HTTP via the bridge.** Add `openwhispr` to `$REPO_ROOT/.mcp.json` pointing at the
`:8002` bridge from §3 (merge it alongside the core `board`/`calendar`/`guard`/`vault` entries —
don't clobber them):
```json
{ "mcpServers": {
  "openwhispr": { "type": "http", "url": "http://localhost:8002/mcp" }
}}
```

**Claude Cowork Desktop — direct stdio.** `claude_desktop_config.json` (`$COWORK_CONFIG`) accepts
**stdio `command` servers only** (an HTTP `url` is rejected — same validated rule as
mcp-bridge-setup §5). Write it from config with a **backup-first node merge** that preserves the
other servers + `preferences` and refreshes only the `openwhispr` entry from the **resolved**
loader values — mirroring mcp-bridge-setup's Cowork merge exactly:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # resolves NODE_BIN/REPO_ROOT/OPENWHISPR_*/COWORK_CONFIG from cos.env
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs'), E = process.env;
const server = {
  command: E.NODE_BIN,
  args: [`${E.REPO_ROOT}/mcp/openwhispr-server/server.mjs`],
  env: { OPENWHISPR_DB: E.OPENWHISPR_DB, OPENWHISPR_AUDIO_DIR: E.OPENWHISPR_AUDIO_DIR },  // REAL store, never OPENWHISPR_FIXTURES
};
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
cfg.mcpServers = { ...(cfg.mcpServers||{}), openwhispr: server };   // refresh OURS; keep other servers + preferences intact
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');              // back up before write
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('Cowork mcpServers ->', Object.keys(cfg.mcpServers).join(', '));
NODE
```
- **Absolute `node` path** (`$NODE_BIN`, from the loader): Claude Desktop's spawn env, like
  launchd's, lacks Homebrew on `PATH`.
- **Quit + reopen Claude Desktop (⌘Q)** — it reads this file only at launch; then `openwhispr`
  appears in Cowork's tools.
- **CHECKPOINT** — both registrations present:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  grep -q '"openwhispr"' "$REPO_ROOT/.mcp.json" && echo ".mcp.json OK"
  "$NODE_BIN" -e 'const c=require(process.env.COWORK_CONFIG);process.exit(c.mcpServers&&c.mcpServers.openwhispr?0:1)' \
    && echo "Cowork config OK"
  ```

### 5. Wire into `mcp/ensure-bridges.sh`
Add openwhispr to the existing nudge loops so `npm run dev/start` brings it up with the core
bridges. `ensure-bridges.sh` drives a `for svc in …` bootstrap/kickstart loop and a `for pair in
"<port> <name>" …` probe loop:
- Add **`openwhispr`** to the `for svc in board calendar guard vault …` loop (it maps to
  `com.chiefofstaff.mcp-openwhispr`).
- Add **`"8002 openwhispr"`** to the probe list. It falls through to the standard `lsof … LISTEN`
  branch (not the `/healthz` branch, which is only for the search/guardsvc uv sidecars). If
  openwhispr isn't installed on this machine, omit both — or guard the entry on the plist existing
  (`[ -f "$LA/com.chiefofstaff.mcp-openwhispr.plist" ]`) so a machine without the add-on doesn't WARN.
- **CHECKPOINT** — the script bootstraps it and reports it up:
  ```sh
  source "$(git rev-parse --show-toplevel)/config/load-config.sh"
  "$REPO_ROOT/mcp/ensure-bridges.sh" | grep -i openwhispr   # expect: "[mcp] openwhispr bridge up on :8002"
  ```

### 6. End-to-end verify (proves it reads the REAL store)
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
curl -s -X POST "$OPENWHISPR_BRIDGE_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_transcripts","arguments":{"limit":3}}}'
# expect the result text to begin "Source: sqlite | watermark: …" — NOT "Source: fixtures"
```
- **CHECKPOINT** — `list_transcripts` returns `Source: sqlite` (your live notes) and both clients
  see `openwhispr` after a ⌘Q reopen. The voice ingest loop (`list_transcripts → get_transcript →
  route to vault/board → mark_processed`) is then exercised by **`/second-brain-ingest`** + the
  voice recipe — those own the routing; this skill only proves the plumbing.

## Manage
```sh
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-openwhispr   # restart the bridge
launchctl bootout      gui/$(id -u)/com.chiefofstaff.mcp-openwhispr   # stop the bridge (e.g. on a machine without OpenWhispr)
tail -f mcp/logs/openwhispr.err.log                                   # supergateway / server log
```
**Remove the add-on entirely** (machine without OpenWhispr): `launchctl bootout` the agent, delete
`~/Library/LaunchAgents/com.chiefofstaff.mcp-openwhispr.plist`, drop the `openwhispr` line from
`.mcp.json`, delete `cfg.mcpServers.openwhispr` from the Cowork config (rerun the §4 merge after
removing the key), and drop its `ensure-bridges.sh` entries.

## Gotchas (read before editing)
- **Never leave `OPENWHISPR_FIXTURES` set in the real plist/Cowork config.** It is the
  highest-precedence source and **wins over the real DB** — so a stray `OPENWHISPR_FIXTURES` (handy
  for a dry run in §1–2) silently serves the three bundled test notes instead of your voice notes.
  The tell: `list_transcripts` reports `Source: fixtures` instead of `Source: sqlite`. Production
  sets only `OPENWHISPR_DB` + `OPENWHISPR_AUDIO_DIR`.
- **The bridge reads the store directly — the OpenWhispr app need not be running.** It uses the
  `sqlite3` CLI read-only (WAL allows concurrent readers), and maps each transcript to its `.webm`
  by the trailing `-<id>`. OpenWhispr's own loopback "CLI bridge" (random port 8200–8219) exposes
  **no read endpoint for audio** and vanishes when the app quits, so this server never depends on it.
  (One caveat — next bullet — a *clean* OpenWhispr shutdown can transiently remove the WAL `-shm` file a
  read-only open needs.)
- **WAL + read-only: a missing `-shm` can fail the open (SQLite error 14).** A read-only open needs the
  WAL `-shm` shared-memory file, and a `-readonly` connection **cannot create** it — so after OpenWhispr
  does a clean shutdown (which checkpoints and removes `-wal`/`-shm`), `list_transcripts` can fail with
  `unable to open database file`. It recovers as soon as any writer recreates `-shm`: **open the
  OpenWhispr app once** (it self-heals on its next write). The containing dir must also be writable — it
  is by default (`~/Library/Application Support/open-whispr`, `drwx------`, yours). To make the server
  immune, harden its `sqliteJson` open to retry with `immutable=1` when the plain `-readonly` open fails
  — that fallback only triggers when `-shm` is absent (i.e. the WAL was already checkpointed), so it sees
  complete data with no staleness risk.
- **The watermark is this server's only writable state** — `state/watermark.json` (override
  `OPENWHISPR_STATE`). It's how `mark_processed` keeps ingestion idempotent; it is **not** covered
  by Cos's encrypted backup (which protects the board/guard/config/vault stores), and it's safely
  reconstructible — at worst the loop re-emits already-routed notes, which dedupe on the board.
- **Port `8002` must be free** (`lsof -nP -iTCP:8002 -sTCP:LISTEN`). It sits between the core
  bridges (`8001` board, `8003` calendar, `8004` guard, `8005` vault). A foreign process on it
  breaks §3 — pick another free port via `OPENWHISPR_BRIDGE_PORT` in `cos.env` and re-render.
- **launchd cannot expand `$VARS`.** As with every Cos plist, the **rendered** plist in
  `~/Library/LaunchAgents` carries **literal absolute paths** and a `PATH` that starts with
  `$BREW_PREFIX/bin` — launchd never inherits your login shell and can't see an nvm/asdf shim.
- **The node/simdjson + pm2 gotchas in mcp-bridge-setup apply here too** — same Node, same
  supergateway, same launchd supervisor. If the bridge dies with a `libsimdjson` dyld error after a
  `brew install`, `brew reinstall node`. Don't reintroduce pm2.
