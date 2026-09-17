---
name: debug-cowork-mcp-issues
description: Diagnose and fix a Cos MCP server that is failing in Claude Cowork Desktop (or in Claude Code) — "board not responding", a server missing from the tool list, a tool call erroring, vault 401, openwhispr can't open its DB, whatsapp dead, or a server that dies after a while. Walks the escalation ladder (relaunch → read Cowork's per-server logs → reproduce the spawn outside Cowork → apply the known fix → regenerate config) and knows the two distinct wiring paths (Cowork = direct stdio from claude_desktop_config.json; Claude Code = launchd supergateway bridges). Use when Cowork or Code "can't see" board/calendar/guard/vault/nutrition/fitness/body/openwhispr/whatsapp, when an MCP tool call fails or times out, when a server shows as failed/disconnected, after editing claude_desktop_config.json or .mcp.json, or whenever an MCP server is misbehaving and you need to find the real cause.
allowed-tools: Bash, Read
---

# Debug a Cos MCP server in Cowork (and Claude Code)

The #1 source of confusion is mixing up **two independent layers**. Establish which one the user is
hitting **before** doing anything — the diagnosis and the fix differ.

| Layer | How the server runs | Config | Reads config… |
|---|---|---|---|
| **Claude Cowork Desktop** | Cowork spawns each server **directly** as a stdio `command` | `~/Library/Application Support/Claude/claude_desktop_config.json` | **only at launch** (⌘Q to reload) |
| **Claude Code** | a launchd **`supergateway` bridge** per server | `$REPO_ROOT/.mcp.json` | per session (launchd supervises the bridge) |

The board **app** ($BOARD_URL) is a third, independent thing — it works with no bridges at all. Don't
chase an MCP bug that's really "the board app isn't answering at $BOARD_URL" (see step 4).

Every shell block below starts with the loader so nothing is hardcoded:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
```

The full reference for this runbook is
[docs/reference/troubleshooting.md](../../../docs/reference/troubleshooting.md).

---

## Step 0 — Scope it

Ask / confirm: **which client** (Cowork or Claude Code), **which server** (any name
`node "$REPO_ROOT/mcp/service-manifest.mjs"` prints — the core four plus this machine's installed
add-ons), and **what the user sees** (missing from tools, "not responding", a tool call erroring, a
specific error string). Then take the matching path below.

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
NAME=board    # any server name from `node "$REPO_ROOT/mcp/service-manifest.mjs"`
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
| tool **calls** fail on the board-proxying servers (any whose descriptor env sets `CRM_BASE_URL` — board, calendar, and the add-on wrappers), while `tools/list` is fine | the board app isn't answering at **$BOARD_URL** | `curl -fsS --max-time 5 "$BOARD_URL/api/healthz"`; then branch on `COS_DEVICE_ROLE`: **spoke** → the hub (or the tailnet) is down — never start a local board (the spoke guards refuse one anyway); **hub** with the `boardapp` LaunchAgent installed → `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-boardapp` and read `mcp/logs/boardapp.err.log` (a `next dev` on the port keeps the production board down — `boardapp-run.mjs` refuses a busy port); **hub** without it → `cd board && npm run dev` and confirm the startup banner bound `$BOARD_PORT`, not a bumped port |
| `vault` → `http=401 / Invalid API key` **in Cowork while Claude Code works** | Cowork holds an **early-bound COPY** of the key in `claude_desktop_config.json` (`vault.env.ANTHROPIC_API_KEY`); Claude Code late-binds it from `config/secrets.env` on every bridge start. The copy rots two ways: a **placeholder** snapshotted before the real key was filled in, or **rotation drift** (you edited `secrets.env` + kickstarted, which fixes only Code). Neither ever self-heals | `node scripts/check-cowork-secrets.mjs` names which one it is; fix per Step 5, ⌘Q |
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

Never hand-edit the entry — regenerate it from the service descriptor. The generator is a
backup-first, **named** merge: it rewrites exactly the entries you name, preserves every other
server + `preferences`, and validates any secret before inlining it
(`config/secret-validation.mjs` refuses a placeholder atomically — so a `vault` repair validates
the key instead of freezing a bad copy in).

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-cowork-config.mjs" board   # name the server you're fixing; add --print first to inspect
```

Then **⌘Q** Cowork. For a wholesale rebuild, re-run the setup skills (`/mcp-bridge-setup` for
the core four; each add-on's own setup skill) — the generator's bare no-name form writes every
entry this role is *eligible* for, installed or not (it would re-add an add-on you removed), so
don't reach for it mid-repair.

## Claude Code (bridge) path

If the trouble is in **Claude Code**, target the launchd bridges instead:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
launchctl list | grep chiefofstaff          # each: a PID + last exit 0 = healthy
# One line per bridge THIS machine's role runs — the set comes from the manifest, never a hand-kept list:
PROBE_LIST=$(node "$REPO_ROOT/mcp/service-manifest.mjs" --probe-list)
[ -n "$PROBE_LIST" ] || echo "COULD NOT READ THE MANIFEST — the bridge set is UNCHECKED, not clear (node + mcp/service-manifest.mjs; see its error above)"
echo "$PROBE_LIST" | while IFS=$'\t' read -r name port kind probe gate roles autostart label; do
  [ "$kind" = bridge ] || continue
  case ",$roles," in *",${COS_DEVICE_ROLE:-hub},"*) ;; *) continue ;; esac
  if [ ! -f "$LAUNCH_AGENTS_DIR/$label.plist" ]; then
    if [ "$gate" = core ]; then echo "$name (:$port) — NOT INSTALLED (no $label.plist — run cos-setup)"
    else echo "$name (:$port) — NOT INSTALLED (no $label.plist — an add-on this machine hasn't set up)"; fi
    continue
  fi
  got=$(curl -s -X POST "http://127.0.0.1:$port/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
    | grep -o '"name":"[a-z0-9_-]*"' | head -1)
  echo "$name (:$port) -> ${got:-NO ANSWER — kickstart it and read mcp/logs/$name.err.log}"
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
its tools appear after the ⌘Q relaunch. For a bridge, re-run the bridge check above and confirm the
pass condition: every installed bridge for this machine's role answers with its own
`serverInfo.name`; a `NOT INSTALLED` line for an add-on this machine never set up is not a failure.
