#!/bin/sh
# Launch wrapper for the vault jobs-RUNNER sidecar (com.chiefofstaff.vaultjobs), invoked by the
# launchd plist instead of calling node directly.
#
# WHY a wrapper (same reason as mcp/vault-server/launch.sh): the runner executes DETACHED ingest jobs
# via the embedded Claude Agent SDK, so it needs an ANTHROPIC_API_KEY. launchd does not inherit your
# login shell environment and does not expand $VARS in a plist, so the key would otherwise be baked
# literally into the installed plist. Instead the plist runs THIS script, which sources the gitignored
# config/secrets.env and execs the runner with the key in its environment. The secret lives in exactly
# one machine-local file — never in the installed plist, never committed.
#
# If config/secrets.env is missing or has no key, the runner still boots; ingest jobs just land as
# `failed` with an auth error per job (fail-soft, same as the bridge). COS_VAULT_DIR + PATH come from
# the plist's EnvironmentVariables.
set -eu

# REPO = repo root (this script lives at mcp/vault-server/jobs-runner-launch.sh → up two dirs).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -f "$REPO/config/secrets.env" ]; then
  set -a
  . "$REPO/config/secrets.env"
  set +a
fi

exec node "$REPO/mcp/vault-server/jobs-runner.mjs"
