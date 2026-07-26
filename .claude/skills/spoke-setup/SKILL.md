---
name: spoke-setup
description: Add this machine to an EXISTING Cos as a SPOKE — a stateless client of the hub. It flips COS_DEVICE_ROLE=spoke, points BOARD_URL at the hub's tailnet URL, and wires ONLY the board-facing MCP wrappers (board, calendar, and any enabled add-on wrappers) so Claude Code + Cowork on this machine drive the hub's board over Tailscale. A spoke runs NO local board, NO store, NO backups (the hub owns all of that); its local store guard refuses writes by construction. Use when adding a second (or third) device to a Cos setup, "join my other machine to Cos", "set up my laptop as a spoke", when someone hands you a cos-join:// string, or when a machine should read/write the hub's board without running its own. NOT for the first machine (that's a HUB — use cos-setup).
allowed-tools: Bash, Read
---

# Spoke setup — join this machine to an existing Cos hub

A **spoke** is a machine that uses an existing hub's board over the network instead of running its
own. Its board-facing MCP wrappers (`board`, `calendar`, enabled add-ons) point at the hub's
`BOARD_URL`; there is **no local board, no `cases.json`, no backups** here — the hub owns all state.
The store's role guard (`SpokeRoleError`) refuses any local write, so a spoke can never fork the
single source of truth.

> **This is NOT the first-machine path.** The first machine is a HUB — run `cos-setup`. Use this skill
> only to add a machine to a Cos that already exists.

## What you need first — the join string

On the **hub**, open the board's **Devices** panel → **Add a device**, or run
`node scripts/join-blob.mjs` on the hub. Either gives a `cos-join://v1?hub=…&schema=…` string. It
carries the hub's tailnet URL + its store schemaVersion (+ an optional backup-repo ref) — **addresses
and expectations, no secrets**, so it neither expires nor needs protecting.

Also required: **Tailscale installed + logged in on BOTH machines** (the hub and this spoke) on the
same tailnet, and the hub serving its board over the tailnet (`tailscale serve --bg 3000`, so the hub
answers at `https://<hub>.<tailnet>.ts.net`).

## Step 0 — Tailscale reachability + hub handshake (do this FIRST)

Confirm this machine can reach the hub over the tailnet before writing any config. Substitute the
`hub=` value from your join string:

```sh
HUB="https://<hub>.<tailnet>.ts.net"   # the join string's hub= value
curl -fsS --max-time 5 "$HUB/api/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("hub role:",j.role,"deviceId:",j.deviceId,"schema:",j.schemaVersion)})'
```

**CHECKPOINT** — the hub answers with `role: hub` and a schemaVersion. If curl can't reach it: check
`tailscale status` on both machines (same tailnet, both up) and that the hub ran `tailscale serve`.

**Cowork reach preflight (spawned-child networking):** Claude Cowork Desktop spawns its MCP wrappers
as child processes; confirm a child can reach the hub the way a wrapper will, BEFORE wiring Cowork.
On macOS:

```sh
/Applications/Claude.app/Contents/Helpers/disclaimer "$(command -v node)" \
  -e "fetch(process.env.HUB+'/api/healthz').then(r=>console.log('reach:',r.status)).catch(e=>console.log('BLOCKED:',e.cause?.code||e.message))" HUB="$HUB"
```

**CHECKPOINT** — prints `reach: 200`. If it prints `BLOCKED`, Cowork's sandbox is refusing the tailnet
host (rare — see the Gotchas); the browser + Claude Code paths still work, so continue but skip the
Cowork wiring step.

## Step 1 — write this machine's spoke config

`config/cos.env` is machine-local (never in the backup scope), so a spoke writes its OWN. Set the
role to `spoke` and `BOARD_URL` to the hub — the loader REFUSES `spoke` + a localhost `BOARD_URL`.

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"   # seeds defaults; safe pre-cos.env
# Append (or edit) the spoke keys in config/cos.env:
{
  echo 'COS_DEVICE_ROLE="spoke"'
  echo "BOARD_URL=\"$HUB\""                 # the hub's tailnet URL from the join string
  echo "COS_DEVICE_ID=\"$(node -e 'console.log("spoke-"+require("crypto").randomBytes(4).toString("hex"))')\""
} >> "$REPO_ROOT/config/cos.env"
# Re-source and verify the loader accepts the spoke config (it validates role + the spoke/localhost rule):
source "$REPO_ROOT/config/load-config.sh" && echo "role=$COS_DEVICE_ROLE BOARD_URL=$BOARD_URL"
```

**CHECKPOINT** — the loader prints `role=spoke` and a non-localhost `BOARD_URL` with no error. (An
error here means the role is misspelled or `BOARD_URL` is still localhost — fix `config/cos.env`.)

## Step 2 — install ONLY the board-facing wrapper bridges

The generators are role-scoped: on a spoke they install just the board-facing wrappers (their
`CRM_BASE_URL` resolves to the hub's `BOARD_URL`), never the hub-only services (vault, guard, the
sidecars, the board app, backup). Install the wrappers this spoke should have — always `board` +
`calendar`; add any add-on wrapper the hub has enabled (`nutrition`, `fitness`, `body`):

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-launchd.mjs" --install board calendar   # + nutrition/fitness/body if enabled on the hub
node "$REPO_ROOT/scripts/gen-mcp-json.mjs"                            # regenerate REPO/.mcp.json (committed; CI-checked — never hand-edit)
```

> Naming a hub-only service here (e.g. `vault`) is a LOUD error by design — a spoke does not run it.

**CHECKPOINT** — `lsof -nP -iTCP:$BOARD_BRIDGE_PORT -sTCP:LISTEN` shows the board bridge listening on
127.0.0.1, and `curl -s http://127.0.0.1:$BOARD_BRIDGE_PORT/mcp` answers (the bridge is up; it proxies
to the hub).

## Step 3 — wire Claude Cowork Desktop (skip if the Step-0 preflight was BLOCKED)

```sh
source "$(git rev-parse --show-toplevel)/config/load-config.sh"
node "$REPO_ROOT/scripts/gen-cowork-config.mjs" board calendar   # + the same add-on wrappers as Step 2
```

Then **⌘Q + reopen Cowork** so it re-reads the config. The wrappers' `CRM_BASE_URL` points at the hub.

**CHECKPOINT** — in Cowork, `get_device_status` (board MCP) returns the HUB's device id + `role: hub`
(you're driving the hub). If Cowork can't spawn the wrapper, the Step-0 preflight would have caught it.

## Step 4 — verify end-to-end

1. **Browser:** open `$BOARD_URL` — the hub's board loads over the tailnet, with a "Connected to
   <hub>" chip bottom-right (the spoke chip).
2. **Claude Code:** `mcp__board__get_device_status` returns the hub's identity; `mcp__board__get_tree`
   round-trips real cases.
3. **A write appears on the hub:** create a test case from this spoke (browser or MCP); it shows up on
   the hub's screen (SSE) — one board, two windows.
4. **The store guard holds:** `cd board && npm run dev` REFUSES on this spoke (predev spoke-abort), and
   a direct `npx next dev` write attempt would 503 (`spoke-role-refusal`) — a spoke never serves a
   local board.

## Manage

- **Which add-on wrappers a spoke wires** — only the board-facing ones the hub has ENABLED. `vault`,
  `guard`, `search`, `whatsapp`, `openwhispr` are hub-only (the spoke reaches their data through the
  hub's board where applicable). Add/remove a wrapper by re-running Steps 2–3 with its name.
- **Warm-standby tier (optional):** a spoke can keep a pulled clone of the backup repo + the shared
  recovery key so hub-failure recovery is "restore + flip role" in minutes. That's a separate opt-in
  (see the backup-recovery skill); this skill does NOT make the spoke a backup producer.
- **Promote this spoke to hub** (planned failover / handover): that's the `hub-handover` ceremony (a
  later skill), not spoke-setup — it involves restoring the store and flipping the role back to hub.

## Gotchas

- **A spoke has NO local board/store/backup.** `COS_DEVICE_ROLE=spoke` + `BOARD_URL=<hub>` is the whole
  contract; the store guard enforces read-only locally. Never run `cos-setup` Step 0 (the seed) on a
  spoke — that's the seed-over-live-data footgun, and there's nothing local to seed anyway.
- **Address the hub by its `ts.net` name, never a LAN IP.** A LAN/RFC1918 address can hit a silent
  macOS Local-Network-privacy block for Desktop-spawned children; the tailnet MagicDNS name (or a 100.x
  address over plain HTTP) is outside that gate.
- **`.mcp.json` is committed + CI-checked** — regenerate it with `gen-mcp-json.mjs`, never hand-edit.
  On a spoke it stays byte-identical to the hub's (the bridges are still localhost; only the wrappers'
  `CRM_BASE_URL` differs, which lives in the plist env, not `.mcp.json`). The hub-only entries it lists
  (vault/guard/whatsapp/openwhispr) simply show as unreachable on a spoke — cosmetic, documented.
- **Cowork spawned-child reach** is validated in Step 0; if it's blocked, the browser + Claude Code
  paths are fully functional — Cowork on a spoke is a convenience, and the daily routines run on the
  HUB's Cowork by design.
