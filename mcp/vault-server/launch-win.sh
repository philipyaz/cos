#!/bin/sh
# Launch wrapper for the vault MCP bridge (:8005) — Windows version.
# Same as launch.sh but uses Windows-compatible paths.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Load secrets (ANTHROPIC_API_KEY)
if [ -f "$REPO/config/secrets.env" ]; then
  set -a
  . "$REPO/config/secrets.env"
  set +a
fi

# Front the stdio server with supergateway as Streamable HTTP on :8005
exec supergateway \
  --stdio "node $REPO/mcp/vault-server/server.mjs" \
  --outputTransport streamableHttp \
  --port 8005 \
  --streamableHttpPath /mcp \
  --cors \
  --logLevel info
