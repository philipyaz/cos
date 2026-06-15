#!/bin/sh
# Windows version of ensure-bridges.sh — uses pm2 instead of launchd.
# Called from board dev/start to guarantee bridges are up.
# Always exits 0 (best-effort).
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)

# Source the config loader
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi

# Check if pm2 ecosystem is running
if ! pm2 list 2>/dev/null | grep -q "mcp-board"; then
  echo "[mcp] Starting pm2 ecosystem..."
  pm2 start "$REPO/ecosystem.config.cjs" 2>/dev/null || {
    echo "[mcp] WARN: pm2 start failed — run 'pm2 start ecosystem.config.cjs' from repo root"
    exit 0
  }
  sleep 2
fi

# Probe each bridge
SERVICES="
board ${BOARD_BRIDGE_PORT:-8001}
calendar ${CALENDAR_BRIDGE_PORT:-8003}
guard ${GUARD_BRIDGE_PORT:-8004}
vault ${VAULT_BRIDGE_PORT:-8005}
nutrition ${NUTRITION_BRIDGE_PORT:-8007}
"

echo "$SERVICES" | while read -r name port; do
  [ -n "$name" ] || continue
  if curl -s --max-time 2 "http://127.0.0.1:$port/mcp" >/dev/null 2>&1; then
    echo "[mcp] $name bridge up on :$port"
  else
    echo "[mcp] WARN: $name bridge DOWN on :$port — check pm2 logs mcp-$name"
  fi
done

# Probe sidecars
for sidecar in "guardsvc ${GUARD_SIDECAR_PORT:-8009}" "search ${SEARCH_SIDECAR_PORT:-8008}"; do
  name=$(echo "$sidecar" | cut -d' ' -f1)
  port=$(echo "$sidecar" | cut -d' ' -f2)
  if curl -s --max-time 2 "http://127.0.0.1:$port/healthz" | grep -q '"ok":true' 2>/dev/null; then
    echo "[mcp] $name up on :$port"
  else
    echo "[mcp] WARN: $name starting on :$port (first run provisions venv)"
  fi
done

exit 0
