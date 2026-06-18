#!/bin/sh
# Launch wrapper for the vault MCP bridge (:8005), invoked by the launchd plist
# (com.chiefofstaff.mcp-vault) instead of calling supergateway directly.
#
# WHY a wrapper: the vault server is the ONLY bridge that makes outbound LLM calls (it embeds
# the Claude Agent SDK), so it needs an ANTHROPIC_API_KEY. launchd does NOT inherit your login
# shell environment and does NOT expand $VARS inside a plist, so the key would otherwise have
# to be baked literally into the installed plist. Instead, the plist runs THIS script, which
# loads the key from the gitignored config/secrets.env and execs supergateway with it in the
# environment. The secret then lives in exactly one machine-local file — never in the installed
# plist, never committed. Rotate by editing config/secrets.env and kickstarting the agent.
#
# If config/secrets.env is missing or has no key, the bridge still boots; the vault tools just
# return a clean "ANTHROPIC_API_KEY/auth" error per call (the server is fail-soft by design).
set -eu

# REPO = repo root (this script lives at mcp/vault-server/launch.sh → up two dirs).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Machine config (single source of truth for the port + supergateway binary) so a VAULT_BRIDGE_PORT
# override in config/cos.env reaches the actual listener — not just the manifest probe + .mcp.json.
# load-config.sh guards every command and never sources secrets, so it is safe under `set -eu`.
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi

# Load machine-local secrets (ANTHROPIC_API_KEY; may also carry COS_VAULT_* overrides).
# `set -a` exports everything the file assigns so the SDK child process inherits it.
if [ -f "$REPO/config/secrets.env" ]; then
  set -a
  . "$REPO/config/secrets.env"
  set +a
fi

# Front the stdio server with supergateway as Streamable HTTP on the vault bridge port (default
# 8005, overridable via VAULT_BRIDGE_PORT in cos.env). COS_VAULT_DIR + PATH come from the plist's
# EnvironmentVariables; SUPERGATEWAY_BIN + VAULT_BRIDGE_PORT come from load-config.sh above.
exec "${SUPERGATEWAY_BIN:-supergateway}" \
  --stdio "node $REPO/mcp/vault-server/server.mjs" \
  --outputTransport streamableHttp \
  --port "${VAULT_BRIDGE_PORT:-8005}" \
  --streamableHttpPath /mcp \
  --cors \
  --logLevel info
