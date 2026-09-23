#!/bin/sh
# Secret-sourcing wrapper for the vault MCP bridge (:8005) — ProgramArguments[0] in the plist,
# AHEAD of the full bridge argv rendered by scripts/gen-launchd.mjs from supergatewayArgv
# (mcp/service-manifest.mjs — the ONE owner of the security-critical recipe, loopback preload
# included).
#
# WHY a wrapper: the vault server is the ONLY bridge that makes outbound LLM calls (it embeds
# the Claude Agent SDK), so it needs an ANTHROPIC_API_KEY. launchd does NOT inherit your login
# shell environment and does NOT expand $VARS inside a plist, so the key would otherwise have
# to be baked literally into the installed plist. Instead this script sources the key from the
# gitignored config/secrets.env and execs the argv it was handed with the key in the
# environment. The secret lives in exactly one machine-local file — never in the installed
# plist, never committed. Rotate by editing config/secrets.env and kickstarting the agent
# (late-bound: sourced on EVERY start).
#
# If config/secrets.env is missing or has no key, the bridge still boots; the vault tools just
# return a clean "ANTHROPIC_API_KEY/auth" error per call (the server is fail-soft by design).
set -eu

# A plist installed BEFORE the argv moved into ProgramArguments invokes this with no args.
# `exec "$@"` with zero args would exit 0 silently and launchd would respawn it forever with
# an empty err.log — fail LOUDLY with the remedy instead (service-manifest.mjs's own rule:
# failing loudly, never silently guessing).
[ $# -gt 0 ] || { echo "vault launch.sh: no command given — stale plist; re-run: node scripts/gen-launchd.mjs --install vault" >&2; exit 64; }

# REPO = repo root (this script lives at mcp/vault-server/launch.sh → up two dirs).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Machine config — the wrapper itself needs nothing from it, but sourcing it preserves today's
# env surface for the exec'd child (load-config.sh guards every command and never sources
# secrets, so it is safe under `set -eu`).
if [ -f "$REPO/config/load-config.sh" ]; then
  . "$REPO/config/load-config.sh"
fi

# Machine-local secrets (ANTHROPIC_API_KEY; may also carry COS_VAULT_* overrides).
# `set -a` exports everything the file assigns so the SDK child process inherits it.
if [ -f "$REPO/config/secrets.env" ]; then
  set -a
  . "$REPO/config/secrets.env"
  set +a
fi

exec "$@"
