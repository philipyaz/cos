#!/bin/sh
# mcp/ensure-bridges.sh — the "make sure the MCP bridges + sidecars are up right now" nudge, called
# from board/package.json predev/prestart (via mcp/ensure-bridges.mjs) so the bridges are guaranteed
# up whenever the app comes up. One-way on purpose: it NEVER stops anything — Claude Cowork Desktop
# needs the bridges even when the dev app is down.
#
# SINGLE SOURCE OF TRUTH: the service list + ports come from `node mcp/service-manifest.mjs
# --probe-list` (the descriptors + config/load-config.sh), NOT a hardcoded list here. Add a service by
# dropping a descriptor; this script picks it up with no edit. (See mcp/CLAUDE.md.)
#
# PLATFORMS (gated on `uname`, NOT on a missing launchctl — Linux/CI have no launchctl either):
#   - macOS   : launchd owns lifecycle (RunAtLoad + KeepAlive); this bootstraps + kickstarts each
#               installed LaunchAgent, then probes.
#   - Windows : delegates to mcp/cos-services.mjs (the Node process manager; no launchd).
#   - other   : probe-only (no supervisor) — best-effort.
#
# SECURITY POSTURE (unchanged): the search sidecar is a pure accelerator — a cold/missing one only
# WARNs (board /api/search degrades to a keyword scan). The guard sidecar's WARN here is only about
# boot timing: the guard MCP FAILS CLOSED if the sidecar is down (scan_email/classify_text return an
# explicit UNTRUSTED verdict — they never pretend content is clean). So both probe leniently.
#
# Always exits 0 (best-effort): a bridge hiccup must never block the app from starting.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)

# Machine config (REPO_ROOT, ports, NODE_BIN, LAUNCH_AGENTS_DIR, WHATSAPP_*). The loader seeds
# defaults, so the vars below are always set after sourcing.
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi
NODE="${NODE_BIN:-node}"
LA="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

# The canonical service list — tab-separated columns from the manifest:
#   "<name>	<port|->	<kind>	<probe>	<gate>	<roles>	<autostart 1|0>	<label>"
PROBE_LIST=$("$NODE" "$REPO/mcp/service-manifest.mjs" --probe-list 2>/dev/null)
if [ -z "$PROBE_LIST" ]; then
  echo "[mcp] could not read the service manifest (node + mcp/service-manifest.mjs). Skipping bridge nudge."
  exit 0
fi

# --- probe helpers (used by every platform branch) -------------------------------------------------
# httpListen: a listening bridge answers (even an HTTP error) on /mcp; connection-refused = down.
probe_listen() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/mcp"
  fi
}
probe_healthz() { curl -s --max-time 2 "http://127.0.0.1:$1/healthz" 2>/dev/null | grep -q '"ok":true'; }

# Does this service run under THIS machine's device role? roles is the comma-joined column from the
# probe-list; COS_DEVICE_ROLE comes from the loader (default hub). A role-mismatched service is
# SILENTLY out of scope — on a spoke, hub-only services (even core ones) are simply not this
# machine's concern, not a WARN.
role_matches() {
  case ",$1," in *",${COS_DEVICE_ROLE:-hub},"*) return 0 ;; *) return 1 ;; esac
}

# Run the right check for one service line + emit a status/WARN. The 6th arg `label` is the launchd
# label from the manifest (it can be overridden per-descriptor — e.g. backup keeps its historical
# com.chiefofstaff.backup). The 7th `installed` is 1 when the caller already confirmed the service is
# set up on this machine (the Darwin branch filters out opted-out add-ons by plist BEFORE calling, so
# an installed-but-DOWN add-on must still WARN — losing that WARN was a diagnostic regression vs the
# old script). We WARN on down when installed OR core; an opted-out optional service (installed=0,
# gate!=core) stays quiet so we don't nag.
probe_one() {
  name=$1 port=$2 kind=$3 probe=$4 gate=$5 label=$6 installed=${7:-0}
  warn=0
  { [ "$installed" = 1 ] || [ "$gate" = core ]; } && warn=1
  case "$probe" in
    httpListen)
      if probe_listen "$port"; then echo "[mcp] $name up on :$port"
      elif [ "$warn" = 1 ]; then echo "[mcp] WARN: $name DOWN on :$port — see mcp/logs/$name.err.log"; fi ;;
    healthz)
      # Sidecars are core → always probed; a cold uv venv listens before the engine is warm, so this
      # is lenient (WARN, never block).
      if probe_healthz "$port"; then echo "[mcp] $name up on :$port"
      elif [ "$name" = guardsvc ]; then echo "[mcp] WARN: guardsvc starting on :$port (first launch provisions a venv; until the gated model is prefetched it uses the heuristic fallback) — guard MCP fails CLOSED meanwhile (see mcp/logs/guardsvc.err.log)"
      else echo "[mcp] WARN: $name starting on :$port (first launch provisions a venv + ~30MB model, ~30s; keyword search works meanwhile — see mcp/logs/$name.err.log)"; fi ;;
    bearerHealth)
      tok="${WHATSAPP_MCP_DIR:-}/whatsapp-bridge/store/.bridge-token"
      base="${WHATSAPP_GO_URL:-http://127.0.0.1:$port}"
      if [ -f "$tok" ] && curl -s --max-time 2 -H "Authorization: Bearer $(cat "$tok")" "$base/api/health" 2>/dev/null | grep -q '"connected":true'; then
        echo "[mcp] $name up on :$port (WhatsApp session connected)"
      elif probe_listen "$port"; then echo "[mcp] WARN: $name on :$port but WhatsApp NOT connected — cold start or session expired; re-pair via /whatsapp-mcp-setup (see mcp/logs/$name.out.log)"
      elif [ "$warn" = 1 ]; then echo "[mcp] WARN: $name DOWN on :$port — see mcp/logs/$name.err.log"; fi ;;
    process)
      if launchctl list 2>/dev/null | grep -q "$label"; then echo "[mcp] $name runner up (no port)"
      elif [ "$warn" = 1 ]; then echo "[mcp] WARN: $name runner not loaded (see mcp/logs/$name.err.log)"; fi ;;
    scheduled)
      # A scheduled job (e.g. the 03:30 backup) is healthy when LOADED — it is not
      # supposed to be running between fires, so a process/port probe would lie.
      if launchctl list 2>/dev/null | grep -q "$label"; then echo "[mcp] $name scheduled job loaded"
      elif [ "$warn" = 1 ]; then echo "[mcp] WARN: $name scheduled job not loaded — see the backup-recovery skill"; fi ;;
  esac
}

OS=$(uname -s 2>/dev/null || echo unknown)
case "$OS" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    # --- Windows: the Node process manager supervises everything (no launchd). NOTE: the normal
    # predev path reaches Windows via mcp/ensure-bridges.mjs (which calls cos-services directly); this
    # branch only fires if someone runs `sh ensure-bridges.sh` by hand under Git Bash. ---
    "$NODE" "$REPO/mcp/cos-services.mjs" start
    exit 0
    ;;
  Darwin)
    # --- macOS: launchd. Fresh-clone short-circuit — no installed agents yet → say so once + exit.
    # Match ANY chiefostaff agent (label overrides mean not every one is mcp-*, e.g. the backup job). ---
    if ! ls "$LA"/com.chiefofstaff.*.plist >/dev/null 2>&1; then
      echo "[mcp] bridges not set up yet — run cos-setup to wire them. The board UI works without them."
      exit 0
    fi
    U=$(id -u)
    # bootstrap + kickstart every INSTALLED agent (a missing optional plist is skipped silently;
    # a role-mismatched service is out of scope for this machine entirely). A scheduled job is
    # bootstrapped but NEVER kickstarted — that would fire it now instead of at its hour. An
    # autostart=0 service (the boardapp — the production board itself) is NOT touched by this
    # predev/prestart nudge: a dev board is about to bind the port; launching the production board
    # here would collide with it.
    echo "$PROBE_LIST" | while IFS='	' read -r name port kind probe gate roles autostart label; do
      [ -n "$name" ] || continue
      role_matches "$roles" || continue
      [ "$autostart" = 1 ] || continue
      if [ ! -f "$LA/$label.plist" ]; then
        [ "$gate" = core ] && echo "[mcp] WARN: $name not installed ($label.plist missing) — run cos-setup"
        continue
      fi
      launchctl bootstrap gui/"$U" "$LA/$label.plist" 2>/dev/null
      [ "$probe" = scheduled ] || launchctl kickstart "gui/$U/$label" 2>/dev/null
    done
    sleep 1
    echo "$PROBE_LIST" | while IFS='	' read -r name port kind probe gate roles autostart label; do
      [ -n "$name" ] || continue
      role_matches "$roles" || continue
      [ "$autostart" = 1 ] || continue
      [ -f "$LA/$label.plist" ] || continue
      probe_one "$name" "$port" "$kind" "$probe" "$gate" "$label" 1   # installed=1: plist present, so WARN if down
    done
    exit 0
    ;;
  *)
    # --- other (Linux/CI): no bundled supervisor — just probe what happens to be up. ---
    echo "[mcp] no bundled supervisor for $OS — probing only (start services yourself)."
    echo "$PROBE_LIST" | while IFS='	' read -r name port kind probe gate roles autostart label; do
      [ -n "$name" ] || continue
      role_matches "$roles" || continue
      [ "$autostart" = 1 ] || continue
      probe_one "$name" "$port" "$kind" "$probe" "$gate" "$label"
    done
    exit 0
    ;;
esac
