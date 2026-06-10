---
name: debug-cowork-mcp-issues
description: Diagnose and fix a Cos MCP server that is failing in Claude Cowork Desktop (or in Claude Code) — "board not responding", a server missing from the tool list, a tool call erroring, vault 401, openwhispr can't open its DB, whatsapp dead, or a server that dies after a while. Walks the escalation ladder (relaunch → read Cowork's per-server logs → reproduce the spawn outside Cowork → apply the known fix → regenerate config) and knows the two distinct wiring paths (Cowork = direct stdio from claude_desktop_config.json; Claude Code = launchd supergateway bridges on :8001–:8006). Use when Cowork or Code "can't see" board/calendar/guard/vault/openwhispr/whatsapp, when an MCP tool call fails or times out, when a server shows as failed/disconnected, after editing claude_desktop_config.json or .mcp.json, or whenever an MCP server is misbehaving and you need to find the real cause.
allowed-tools: Bash, Read
---

# Debug a Cos MCP server in Cowork (and Claude Code)

The #1 source of confusion is mixing up **two independent layers**. Establish which one the user is
hitting **before** doing anything — the diagnosis and the fix differ.

| Layer | How the server runs | Config | Reads config… |
|---|---|---|---|
| **Claude Cowork Desktop** | Cowork spawns each server **directly** as a stdio `command` | `~/Library/Application Support/Claude/claude_desktop_config.json` | **only at launch** (⌘Q to reload) |
| **Claude Code** | a launchd **`supergateway` bridge** per server (:8001–:8006) | `$REPO_ROOT/.mcp.json` | per session (launchd supervises the bridge) |

The board **app** (:3000) is a third, independent thing — it works with no bridges at all. Don't
chase an MCP bug that's really "the board app isn't running on :3000" (see step 4).

Every shell block below starts with the loader so nothing is hardcoded:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

The full reference for this runbook is
[docs/reference/troubleshooting.md](../../../docs/reference/troubleshooting.md).

---

## Step 0 — Scope it

Ask / confirm: **which client** (Cowork or Claude Code), **which server** (board / calendar / guard /
vault / openwhispr / whatsapp), and **what the user sees** (missing from tools, "not responding", a
tool call erroring, a specific error string). Then take the matching path below.

## Step 1 — (Cowork) Relaunch first

Cowork reads `claude_desktop_config.json` **only at launch** and does **not** respawn a server that
exited. After any config change, or any "it died" symptom, the first move is: **fully quit Cowork
(⌘Q — not just close the window) and reopen it.** This alone resolves the majority of cases. Tell
the user to do it and re-check before going deeper.

Confirm the server is even registered + the config is valid JSON (redact secrets):
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$NODE_BIN" -e '
  const c = require(process.env.COWORK_CONFIG);
  const s = c.mcpServers || {};
  for (const [k, v] of Object.entries(s)) {
    const env = Object.fromEntries(Object.entries(v.env||{}).map(([ek,ev]) =>
      [ek, ek.includes("KEY") ? (ev?ev.slice(0,8)+"…":"EMPTY") : ev]));
    console.log(k, "->", v.command, JSON.stringify(v.args), JSON.stringify(env));
  }'
```
If a server is **absent** from `mcpServers`, or its `command`/`args` point at a stale/missing path
(e.g. an old checkout), that's the bug — fix the entry (Step 5) and ⌘Q.

## Step 2 — (Cowork) Read the real error in Cowork's own logs

Cowork writes a per-server log. This is where the actual cause lives — read it instead of guessing:
```sh
NAME=board    # board | calendar | guard | vault | openwhispr | whatsapp
tail -n 80 "$HOME/Library/Logs/Claude/mcp-server-$NAME.log"   # per-server stderr + the spawn line
tail -n 80 "$HOME/Library/Logs/Claude/mcp.log"                # all servers: init / teardown / disconnect
```
Tells: `Server transport closed unexpectedly … process exiting early` → the child **self-exited**
(see the idle note in Step 4); `ERR_MODULE_NOT_FOUND` / `Cannot find package` → the server's deps
aren't installed; an auth/`401` line → a key problem; `command not found` / a bad path → a stale
config entry.

## Step 3 — (Cowork) Reproduce the spawn OUTSIDE Cowork

The definitive isolation test: spawn the server **exactly the way Cowork does** (its `command`,
`args`, and `env` from `claude_desktop_config.json`) and run an MCP handshake. If it works here, the
fault is Cowork-side (stale in-memory config → ⌘Q). If it fails here, it's the server / env / deps.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
NAME=board   # the server to test
"$NODE_BIN" - "$NAME" <<'NODE'
const { spawn } = require("node:child_process");
const name = process.argv[2];
const cfg = require(process.env.COWORK_CONFIG).mcpServers[name];
if (!cfg) { console.error("no such server in Cowork config:", name); process.exit(1); }
const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe","pipe","pipe"] });
let out = "", err = "";
child.stdout.on("data", d => out += d);
child.stderr.on("data", d => err += d);
child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"debug",version:"1"}}})+"\n");
child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})+"\n");
setTimeout(() => {
  const ok = /"serverInfo"/.test(out);
  console.log(ok ? "SPAWN OK — initialize answered:" : "SPAWN FAILED — no initialize response.");
  const m = out.match(/"serverInfo":\{[^}]*"name":"([^"]+)"/); if (m) console.log("  serverInfo.name =", m[1]);
  const tools = (out.match(/"inputSchema"/g)||[]).length; // one per tool — unlike "name", doesn't match serverInfo
  if (tools) console.log("  tools advertised:", tools);
  if (!ok && err) console.log("  stderr:\n" + err.split("\n").slice(-12).join("\n"));
  child.kill();
  process.exit(0);
}, 4000);
NODE
```
`serverInfo.name` matching the server + a non-zero tool count = the server itself is fine → the
problem was Cowork running stale state → **⌘Q**.

## Step 4 — Apply the known fix

| Symptom (from logs / repro) | Cause | Fix |
|---|---|---|
| "not responding" after a while; log says *process exiting early* | A server self-exited on idle (the idle-exit is now **off by default** for direct stdio clients — a stale build can still show it) | ⌘Q + relaunch so Cowork respawns the current code |
| `board`/`calendar` tool **calls** fail, but `tools/list` is fine | the board app isn't on **:3000** | `cd board && npm run dev`; confirm it bound **:3000** (its startup banner shows the actual port if it bumped) — `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` |
| `vault` → `http=401 / Invalid API key` | **In Cowork the key lives in `claude_desktop_config.json`** (the `vault` entry's `env.ANTHROPIC_API_KEY`) — NOT `config/secrets.env` (that's only the Claude Code bridge, via `launch.sh`) | fix the key in the JSON (Step 5), ⌘Q |
| `guard` → **every** message comes back `UNAVAILABLE … FAIL CLOSED … UNTRUSTED` | the guard **sidecar (:8009) is down/cold**; the guard MCP fails closed (4 s timeout → untrusted). **guardsvc is launchd-owned — Cowork does NOT start it** | `curl -s "$GUARD_SIDECAR_URL/healthz"`; if down/cold: `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-guardsvc`, wait for it to warm, retry |
| `openwhispr` → `unable to open database file (14)` | WAL DB lost its `-shm` after a clean OpenWhispr shutdown. **Current code self-heals** (retries read-only via an `immutable=1` URI) | if you still see it → **stale build** (⌘Q to pick up current code) or `OPENWHISPR_DB` is the wrong path (verify it). Last resort: open the OpenWhispr app once |
| a server **missing** from the tool list | absent / wrong-path entry in the config | add or correct the entry (Step 5), ⌘Q |
| `ERR_MODULE_NOT_FOUND` in the repro/log | the server's deps aren't installed | core servers: `(cd "$REPO_ROOT/mcp/$NAME-server" && npm i)`. **whatsapp is an external checkout:** `(cd "$WHATSAPP_MCP_DIR/whatsapp-mcp-server" && "$UV_BIN" sync)`. Then ⌘Q |
| `whatsapp` tools dead | the Go whatsmeow bridge (`:8010`) is down **or the session expired** — the daemon can be up with a dead session (see Step 4½) | `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-whatsappbridge`; if the log lacks `Connected to WhatsApp`, **re-pair the QR** (a restart won't fix an expired session — `/whatsapp-mcp-setup`) |

## Step 4½ — WhatsApp: "daemon up" ≠ "WhatsApp connected"

WhatsApp is the one server where a healthy launchd job does **not** mean it works — health is **two
facts with different owners**: the **Go bridge process** (`:8010`, `com.chiefofstaff.mcp-whatsappbridge`)
is owned by **launchd** (KeepAlive → restarts on crash), but the **WhatsApp session/pairing** is owned
by **whatsmeow + your phone's Linked Devices** and is **not** auto-recovered. So check both — the port
listens AND the session is live:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
lsof -nP -iTCP:"$WHATSAPP_GO_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "bridge process up"
grep -q "Connected to WhatsApp" "$REPO_ROOT/mcp/logs/whatsappbridge.out.log" && echo "session live"
```
Process up but session NOT live → the pairing died → **re-pair the QR** (`kickstart` won't fix it).
The Python MCP reads `messages.db` directly, so read-only triage still works while the Go bridge is
down — only sends + the initial pairing need it.

## Step 5 — Repair the Cowork config (when an entry is wrong)

Edit the entry from **resolved config**, never hand-type machine paths or secrets — a backup-first
node merge that preserves the other servers + `preferences` (mirrors the setup skills). Example
re-deriving `board`; adapt the `server` object per the server you're fixing. **For the `vault`
entry, re-run `/mcp-bridge-setup` instead of this snippet** — it sources `config/secrets.env` and
validates the key, whereas `load-config.sh` deliberately does NOT load secrets, so a hand-adapt here
would write `ANTHROPIC_API_KEY: undefined` and break vault.
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
"$NODE_BIN" - <<'NODE'
const fs = require("node:fs"), E = process.env;
const p = E.COWORK_CONFIG, cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,"utf8")) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.board = { command: E.NODE_BIN, args: [`${E.REPO_ROOT}/mcp/board-server/server.mjs`], env: { CRM_BASE_URL: E.BOARD_URL } };
if (fs.existsSync(p)) fs.copyFileSync(p, fs.existsSync(p + ".bak") ? `${p}.bak.${Date.now()}` : p + ".bak"); // don't clobber an earlier backup
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log("rewrote board; servers:", Object.keys(cfg.mcpServers).join(", "));
NODE
```
For a wholesale rebuild of all entries, re-run **`/mcp-bridge-setup`** (core four) or the add-on
skill (`/openwhispr-mcp-setup`, `/whatsapp-mcp-setup`). Then **⌘Q** Cowork.

## Claude Code (bridge) path

If the trouble is in **Claude Code**, target the launchd bridges instead:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
launchctl list | grep chiefofstaff          # each: a PID + last exit 0 = healthy
# core four below; the optional add-ons openwhispr (:8002) and whatsapp (:8006) are bridges too —
# add "$OPENWHISPR_BRIDGE_PORT" / "$WHATSAPP_MCP_BRIDGE_PORT" to check them the same way.
for p in "$BOARD_BRIDGE_PORT" "$CALENDAR_BRIDGE_PORT" "$GUARD_BRIDGE_PORT" "$VAULT_BRIDGE_PORT"; do
  curl -s -X POST "http://127.0.0.1:$p/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"[a-z]*"' | head -1
done
tail -n 80 "$REPO_ROOT/mcp/logs/<name>.err.log"            # bridge stderr
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-<name>   # restart one bridge
```
A bridge that won't stay up after `kickstart`, dying with a `libsimdjson` dyld error, is the
node-relink gotcha → `brew reinstall node` (see `/mcp-bridge-setup` → *Gotchas*). The guard/search
sidecars (`:8009`/`:8008`) warm asynchronously — probe `"$GUARD_SIDECAR_URL/healthz"` /
`"$SEARCH_SIDECAR_URL/healthz"`, not a bare port check.

## Verify the fix

Re-run Step 3's repro (must print `SPAWN OK`), and for Cowork have the user confirm the server +
its tools appear after the ⌘Q relaunch. For a bridge, re-run the initialize loop above and confirm
the right `serverInfo.name`.
