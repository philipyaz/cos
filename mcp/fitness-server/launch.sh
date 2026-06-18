#!/bin/sh
# Launch wrapper for the fitness MCP bridge (:8011), invoked by the launchd plist
# (com.chiefofstaff.mcp-fitness) instead of calling supergateway directly.
#
# WHY a wrapper: the fitness bridge carries ONE machine-local secret — FITNESS_PUSH_TOKEN, the
# shared secret it attaches as the `x-fitness-token` header so the board's token-gated write
# routes (POST /api/fitness/push, /api/fitness/coaching) accept its calls. launchd does NOT
# inherit your login shell environment and does NOT expand $VARS inside a plist, so the token
# would otherwise have to be baked literally into the installed plist. Instead, the plist runs
# THIS script, which loads the token from the gitignored config/secrets.env and execs
# supergateway with it in the environment. The token then lives in exactly one machine-local
# file — never in the installed plist, never in .mcp.json, never committed. (Same pattern as
# mcp/vault-server/launch.sh; see mcp/CLAUDE.md → secrets.) Rotate by editing config/secrets.env
# and kickstarting the agent.
#
# If config/secrets.env is missing or has no token, the bridge still boots; the fitness READ
# tools work, and the WRITE tools return a clean "FITNESS_PUSH_TOKEN is not configured" error
# per call (the server is fail-soft by design).
set -eu

# REPO = repo root (this script lives at mcp/fitness-server/launch.sh → up two dirs).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Machine config (single source of truth for the port + supergateway binary) so a
# FITNESS_BRIDGE_PORT override in config/cos.env reaches the actual listener — not just the
# manifest probe + .mcp.json. load-config.sh guards every command and never sources secrets,
# so it is safe under `set -eu`.
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi

# Load machine-local secrets (FITNESS_PUSH_TOKEN). `set -a` exports everything the file assigns
# so the server child process inherits it.
if [ -f "$REPO/config/secrets.env" ]; then
  set -a
  . "$REPO/config/secrets.env"
  set +a
fi

# Front the stdio server with supergateway as Streamable HTTP on the fitness bridge port (default
# 8011, overridable via FITNESS_BRIDGE_PORT in cos.env). CRM_BASE_URL comes from the plist's
# EnvironmentVariables; SUPERGATEWAY_BIN + FITNESS_BRIDGE_PORT come from load-config.sh above.
exec "${SUPERGATEWAY_BIN:-supergateway}" \
  --stdio "node $REPO/mcp/fitness-server/server.mjs" \
  --outputTransport streamableHttp \
  --port "${FITNESS_BRIDGE_PORT:-8011}" \
  --streamableHttpPath /mcp \
  --cors \
  --logLevel info
