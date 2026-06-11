#!/bin/sh
# Ensure the MCP HTTP bridges (board :8001, openwhispr :8002, calendar :8003,
# guard :8004, vault :8005, whatsapp :8006) + the uv sidecars (search :8008, guardsvc :8009) +
# the WhatsApp Go bridge sidecar (:8010) are loaded + running.
#
# Called from board/package.json `dev`/`start` so that whenever the app comes up,
# the bridges are guaranteed up too. One-way on purpose: this NEVER stops them —
# Claude Cowork Desktop needs the bridges even when the dev app is down, and
# openwhispr doesn't depend on the app at all. launchd still owns their lifecycle
# (boot + crash-restart); this is just a "make sure they're up right now" nudge.
#
# The search sidecar (search/sidecar.py, uv-run on :8008) is a pure ranking
# ACCELERATOR over the same cases.json — never a hard dependency. So it gets the
# same nudge, but its probe is lenient: a missing/cold sidecar only WARNs (the
# board's POST /api/search degrades to a keyword scan), it must never block.
#
# The guard sidecar (guard/sidecar.py, uv-run on :8009) is the prompt-injection
# classifier behind the guard MCP (:8004). It probes lenient like search (a uv
# sidecar listens before its classifier is warm, and the first launch may
# provision a venv), BUT note the SECURITY posture is the OPPOSITE of search:
# the guard MCP FAILS CLOSED — if the sidecar is down, scan_email/classify_text
# return an explicit UNTRUSTED verdict, they do NOT pretend content is clean.
# This script's WARN here is only about boot timing; the safety is in the MCP.
#
# Always exits 0 (best-effort): a bridge hiccup must not block the app from starting.
set -u
U=$(id -u)
LA="$HOME/Library/LaunchAgents"
REPO=$(cd "$(dirname "$0")/.." && pwd)

# Source the machine config (REPO_ROOT + the exported *_BRIDGE_PORT / *_SIDECAR_PORT
# vars) so a port override in config/cos.env propagates to the probes below. Guarded
# with [ -f ] so this still works if the loader is absent; the loader itself seeds the
# standard-port defaults, so $name_PORT is always set after sourcing.
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi
# Honor a LAUNCH_AGENTS_DIR override from the loader (config/cos.env) over the default above,
# so the short-circuit glob and the bootstrap loop both target the configured location.
LA="${LAUNCH_AGENTS_DIR:-$LA}"

# Fresh-clone short-circuit: with NO bridges installed yet (e.g. a clone that hasn't run
# cos-setup), bootstrapping all nine services just prints a wall of "WARN ... DOWN" lines.
# The board UI works fine without any bridge (they're for the MCP clients), so say so once
# and exit 0 — `npm run dev` then starts Next cleanly with no scary output.
if ! ls "$LA"/com.chiefofstaff.mcp-*.plist >/dev/null 2>&1; then
  echo "[mcp] bridges not set up yet — run cos-setup to wire them. The board UI works without them."
  exit 0
fi

# The bridges + sidecars to ensure, as "<name> <port>" pairs built from the config vars
# (falling back to the standard literal if a var is somehow unset). The name is BOTH the
# launchd label suffix (com.chiefofstaff.mcp-<name>) and the probe label below; search +
# guardsvc are the uv sidecars (lenient /healthz probe), the rest are HTTP bridges.
SERVICES="
board ${BOARD_BRIDGE_PORT:-8001}
openwhispr ${OPENWHISPR_BRIDGE_PORT:-8002}
calendar ${CALENDAR_BRIDGE_PORT:-8003}
guard ${GUARD_BRIDGE_PORT:-8004}
vault ${VAULT_BRIDGE_PORT:-8005}
whatsapp ${WHATSAPP_MCP_BRIDGE_PORT:-8006}
search ${SEARCH_SIDECAR_PORT:-8008}
guardsvc ${GUARD_SIDECAR_PORT:-8009}
whatsappbridge ${WHATSAPP_GO_PORT:-8010}
"

echo "$SERVICES" | while read -r name port; do
  [ -n "$name" ] || continue
  label="com.chiefofstaff.mcp-$name"
  # bootstrap = load if not already loaded (no-op + harmless error if loaded)
  launchctl bootstrap gui/"$U" "$LA/$label.plist" 2>/dev/null
  # kickstart = start it now if KeepAlive hasn't already
  launchctl kickstart "gui/$U/$label" 2>/dev/null
done

sleep 1
echo "$SERVICES" | while read -r name port; do
  [ -n "$name" ] || continue
  # Optional add-ons: if not installed on this machine (no plist), skip the probe silently —
  # don't WARN about a server the user never set up. (Core servers still warn if absent.)
  case "$name" in
    openwhispr|whatsapp|whatsappbridge)
      [ -f "$LA/com.chiefofstaff.mcp-$name.plist" ] || continue ;;
  esac
  if [ "$name" = search ] || [ "$name" = guardsvc ]; then
    # uv sidecars (search :8008, guardsvc :8009). Slow cold start: the first launch
    # provisions a uv venv (and search downloads a ~30MB model), so a bare
    # port-listen check would false-positive before the engine is warm. Probe
    # /healthz (greens only once the classifier/embedder is loaded) and stay
    # lenient. For search, keyword search covers the gap. For guardsvc, the guard
    # MCP fails CLOSED if the sidecar is down (untrusted-by-default), so a cold
    # sidecar is safe — it's a WARN here, never a block. The default model is the
    # gated Llama-Prompt-Guard-2-86M, prefetchable per the guard-setup skill; once
    # prefetched, auto mode loads the real model (else it uses the heuristic fallback).
    # Probe the sidecar's configured base URL (from the loader; a cos.env override of
    # the port/URL propagates here too); fall back to the loopback literal if unset.
    if [ "$name" = guardsvc ]; then
      base="${GUARD_SIDECAR_URL:-http://127.0.0.1:$port}"
    else
      base="${SEARCH_SIDECAR_URL:-http://127.0.0.1:$port}"
    fi
    if curl -s --max-time 2 "$base/healthz" | grep -q '"ok":true' 2>/dev/null; then
      echo "[mcp] $name up on :$port"
    elif [ "$name" = guardsvc ]; then
      echo "[mcp] WARN: guardsvc starting on :$port (first launch provisions a venv; once the gated Llama-Prompt-Guard-2 model is prefetched per the guard-setup skill, auto mode loads the real model — until then it falls back to the heuristic classifier) — guard MCP fails CLOSED meanwhile (see $REPO/mcp/logs/guardsvc.err.log)"
    else
      echo "[mcp] WARN: search starting on :$port (first launch provisions a venv + ~30MB model, ~30s) — keyword search works meanwhile (see $REPO/mcp/logs/search.err.log)"
    fi
  elif [ "$name" = whatsappbridge ]; then
    # The Go whatsmeow bridge: a LISTENING PORT does NOT mean WhatsApp is connected — the
    # daemon (launchd-supervised) can be up while the session is dead/expired. Probe
    # /api/health, which reports the LIVE client.IsConnected() (authed with the bridge token
    # from store/.bridge-token), so the warning reflects the actual WhatsApp connection.
    tok="$WHATSAPP_MCP_DIR/whatsapp-bridge/store/.bridge-token"
    base="${WHATSAPP_GO_URL:-http://127.0.0.1:$port}"
    if [ -f "$tok" ] && curl -s --max-time 2 -H "Authorization: Bearer $(cat "$tok")" "$base/api/health" 2>/dev/null | grep -q '"connected":true'; then
      echo "[mcp] whatsappbridge up on :$port (WhatsApp session connected)"
    elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[mcp] WARN: whatsappbridge on :$port but WhatsApp is NOT connected — cold start, or the linked device/session expired; re-pair via /whatsapp-mcp-setup if it persists (see $REPO/mcp/logs/whatsappbridge.out.log)"
    else
      echo "[mcp] WARN: whatsappbridge DOWN on :$port — see $REPO/mcp/logs/whatsappbridge.err.log"
    fi
  elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[mcp] $name bridge up on :$port"
  else
    echo "[mcp] WARN: $name bridge DOWN on :$port — see $REPO/mcp/logs/$name.err.log"
  fi
done
exit 0
