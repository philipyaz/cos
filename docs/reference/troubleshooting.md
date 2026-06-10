# Troubleshooting — running the app & fixing MCP / Cowork

Most "it's broken" moments come from confusing **two independent layers**. Keep them separate and
the fix is usually obvious.

| Layer | What it is | Lifecycle |
|---|---|---|
| **The board app** | The Next.js web UI **and** HTTP API on **:3000** (`board/`). Reads `board/data/cases.json` directly. | You run it with `npm run dev`. |
| **The MCP servers** | board / calendar / guard / vault (+ optional openwhispr, whatsapp) exposed to agents. | **Two consumers, wired differently** — see below. |

The MCP servers are consumed two ways, and they fail and recover **differently**:

- **Claude Cowork Desktop** spawns each server **directly** as a stdio `command` from
  `~/Library/Application Support/Claude/claude_desktop_config.json`. That file is read **only at
  launch**.
- **Claude Code** talks to the **launchd `supergateway` bridges** (`:8001`–`:8006`) declared in
  [`.mcp.json`](https://github.com/philipyaz/cos/blob/main/.mcp.json). launchd supervises them
  (boot + crash-restart).

The board UI itself needs **neither** — it works standalone.

## After `cd board && npm install && npm run dev`

| Thing | What to know |
|---|---|
| **The app is self-sufficient** | The UI + API on :3000 reads `cases.json` directly and works with **zero** bridges, sidecars, or Cowork running. A wall of `[mcp] WARN … DOWN` does **not** mean the app is broken. |
| **Keep :3000 free / keep dev running** | The **board** and **calendar** MCP tools proxy to `CRM_BASE_URL=http://localhost:3000`. If :3000 is taken, Next bumps to the **next free port** (often :3001, shown in its startup banner) — the servers still *list* tools, but every board/calendar tool **call** hits :3000 (nothing there) and fails. Check the banner; free :3000 and keep `npm run dev` up while you want those tools. (guard / vault / openwhispr / whatsapp don't depend on :3000.) |
| **`ensure-bridges.sh` is best-effort** | `dev` runs [`sh ../mcp/ensure-bridges.sh; next dev`](https://github.com/philipyaz/cos/blob/main/board/package.json) — it nudges the launchd bridges/sidecars up, prints status, and **always exits 0** so it can never block the app. On a machine that hasn't run `cos-setup` it prints one friendly line and moves on. Optional add-ons you haven't installed are skipped silently (no false WARNs), and for WhatsApp it reports the **live session** state (via the Go bridge's `/api/health`, i.e. `client.IsConnected()`), not just whether `:8010` is listening — so you'll see `whatsappbridge up … (WhatsApp session connected)` or a clear `NOT connected — re-pair` warning. |
| **`npm install` ≠ MCP deps** | It installs the **board app's** deps only. Each MCP server has its own `node_modules` (installed by `cos-setup` / the bridge setup). A fresh clone that only runs `npm install` here gets a working UI, but the bridges need the full setup. |
| **Bridges are launchd-owned, independent of dev** | They keep running when the dev app is down, and restarting `npm run dev` does **not** restart them (one-way coupling — Cowork needs them even when the app is closed). Restart one with `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-<name>`. |
| **Still pending after first setup** | Guard is **off** until enabled in `/security` (see [Guard](../security/guard.md)); **backup** must be set up separately; Obsidian deep-links are disabled until the vault is *Opened as a vault*. |

## When a Cowork MCP server misbehaves

Work the ladder in order — the first step resolves the majority of cases.

1. **⌘Q and relaunch Cowork.** It reads `claude_desktop_config.json` **only at launch** and does
   **not** auto-respawn a server that exited. This is the fix after any config change, and after a
   server died for any reason.

2. **Read the real error in Cowork's own logs:**
   ```sh
   tail -n 60 ~/Library/Logs/Claude/mcp-server-<name>.log    # per-server stderr + the spawn line
   tail -n 60 ~/Library/Logs/Claude/mcp.log                  # all servers: init / teardown / disconnect
   ```
   These name the actual cause (a bad path, an early exit, an auth error) instead of guessing.

3. **Reproduce the spawn outside Cowork.** Take the exact `command` / `args` / `env` for that
   server from `claude_desktop_config.json` and run it yourself, then send an MCP `initialize` +
   `tools/list`. If it works standalone, the problem is Cowork-side (stale config → relaunch); if
   it fails standalone, it's the server / env. The
   [debug-cowork-mcp-issues](https://github.com/philipyaz/cos/blob/main/.claude/skills/debug-cowork-mcp-issues/SKILL.md)
   skill automates this whole ladder.

### Known failure modes → fix

| Symptom | Cause | Fix |
|---|---|---|
| A server "not responding" after a while | A server self-exited on idle (an old defect — the idle-exit is now **off by default** for direct stdio clients) | ⌘Q + relaunch to pick up the current code |
| board / calendar tool calls error (but `tools/list` is fine) | The dev app isn't on :3000 | start `npm run dev`; make sure it's on **:3000**, not :3001 |
| vault → `http=401 / Invalid API key` | A bad/expired key. **Cowork uses the key embedded in `claude_desktop_config.json`** — not `config/secrets.env` (that's only the Claude Code bridge, loaded by `launch.sh`) | fix the key in the JSON, then ⌘Q |
| guard → **every** message comes back `UNAVAILABLE … FAIL CLOSED … UNTRUSTED` | the guard **sidecar (:8009) is down or still cold**; the guard MCP **fails closed** (4 s timeout → untrusted, never a silent "clean") | `curl -s "$GUARD_SIDECAR_URL/healthz"`; if down/cold: `launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-guardsvc`, wait for it to warm, retry. **guardsvc is launchd-owned — Cowork does NOT start it.** |
| openwhispr → `unable to open database file (14)` | WAL DB lost its `-shm` after a clean OpenWhispr shutdown. **Current code self-heals** (retries read-only via an `immutable=1` URI) | If you still see it you're on a **stale build** (⌘Q to pick up current code) or `OPENWHISPR_DB` points at the wrong file — verify the path. Last resort: open the OpenWhispr app once to recreate `-shm`. |
| A server missing entirely from Cowork's tools | wrong / stale absolute path in its config entry (e.g. an old checkout path) | correct the entry, then ⌘Q |
| whatsapp tools dead | the Go bridge (`:8010`) is down **or the linked device / session expired** (the daemon can be up with a dead session — see the two-part health note below) | restart `com.chiefofstaff.mcp-whatsappbridge`; if the log doesn't show `Connected to WhatsApp`, re-pair the QR (see the whatsapp setup skill) |

4. **Last resort:** re-run the relevant setup skill (the core bridge setup, or an add-on's skill)
   to regenerate the config from current paths, then ⌘Q.

### WhatsApp: "daemon up" ≠ "WhatsApp connected"

WhatsApp is the one server where a healthy launchd job does **not** mean it works — its health is
**two facts with different owners**:

- **The Go whatsmeow bridge *process*** (`:8010`, `com.chiefofstaff.mcp-whatsappbridge`) is owned by
  **launchd** (`RunAtLoad` + `KeepAlive` → restarts it on crash / at login).
- **The WhatsApp *session/connection*** is owned by **whatsmeow + your phone's Linked Devices** — and
  it is **not** auto-recovered. If the phone drops the linked device or WhatsApp expires the session,
  the daemon stays up (launchd green) while the connection is dead.

So a healthy WhatsApp is a two-part check — the port listens **and** the session is live:
```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
lsof -nP -iTCP:"$WHATSAPP_GO_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "bridge process up"
grep -q "Connected to WhatsApp" "$REPO_ROOT/mcp/logs/whatsappbridge.out.log" && echo "session live"
```
Process up but session **not** live → the daemon is fine but the pairing died → **re-pair the QR**
(a `kickstart` won't fix it). Note the Python MCP reads `messages.db` directly, so read-only triage
still works while the Go bridge is down — only **sends** and the initial **pairing** need it. The
WhatsApp `store/` is an **external** checkout and is **not** covered by Cos's encrypted backup.

## The Claude Code (bridge) path

If the trouble is in **Claude Code** rather than Cowork, the equivalent checks target the launchd
bridges:

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
launchctl list | grep chiefofstaff          # each bridge: a PID present + last exit 0 = healthy
# an MCP initialize handshake on a bridge port (board shown; others: 8003/8004/8005/8002/8006):
curl -s -X POST "http://127.0.0.1:$BOARD_BRIDGE_PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
tail -n 60 "$REPO_ROOT/mcp/logs/<name>.err.log"   # bridge stderr
launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-<name>   # restart one bridge
```

A bridge that won't stay up after `kickstart` is usually the
[node/simdjson dyld](https://github.com/philipyaz/cos/blob/main/.claude/skills/mcp-bridge-setup/SKILL.md)
gotcha (`brew reinstall node`) — see the bridge setup skill's *Gotchas*.

## Quick reference

| Port | Process | Depends on |
|---|---|---|
| 3000 | board app (Next.js) | — |
| 8001 / 8003 | board / calendar bridge | the app on :3000 (`CRM_BASE_URL`) |
| 8004 | guard bridge | guard sidecar :8009 |
| 8005 | vault bridge | `ANTHROPIC_API_KEY` + the vault dir |
| 8002 / 8006 | openwhispr / whatsapp bridge (optional) | their stores / the Go bridge :8010 |
| 8008 / 8009 | search / guard sidecars | best-effort (search) / fail-closed (guard) |

- **Cowork config:** `~/Library/Application Support/Claude/claude_desktop_config.json` (read at launch).
- **Cowork logs:** `~/Library/Logs/Claude/mcp-server-<name>.log` and `mcp.log`.
- **Bridge logs:** `mcp/logs/<name>.{out,err}.log`.
- **launchd labels:** `com.chiefofstaff.mcp-<name>`.

Related: [Guard](../security/guard.md) · [Search](search.md) · the bridge / supergateway
architecture in [Spec](../architecture/spec.md).
