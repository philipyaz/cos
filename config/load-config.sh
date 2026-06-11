#!/bin/sh
# config/load-config.sh — single source of machine config for Cos SKILLS + SETUP.
#
# Usage — the FIRST line of a skill's first shell block:
#     source "$(git rev-parse --show-toplevel)/config/load-config.sh"
# or, when the shell is already at the repo root:
#     . config/load-config.sh
#
# What it does
#   1. Resolves REPO_ROOT from git — the portable anchor. You can't read a file *inside* the
#      repo to discover where the repo is, so REPO_ROOT is NEVER stored in cos.env; it is always
#      derived here. Skills run inside the checkout (Claude Code / Cowork cwd), so git works.
#      A dirname walk-up fallback covers being sourced by relative path outside git.
#   2. Seeds safe DEFAULTS for every key (brew prefix, $HOME paths, the standard ports) so a
#      skill is fully functional even BEFORE cos-setup has written config/cos.env.
#   3. Sources config/cos.env (if present) so the real machine values override the defaults.
#   4. Computes DERIVED values (VAULT_DIR, BOARD_URL, the bridge/sidecar URLs) AFTER the
#      override, so a port changed in cos.env propagates everywhere.
#   5. Exports everything so child processes (curl / node / perl) inherit it.
#
# SCOPE: SKILLS + SETUP only.
#   - It does NOT source config/secrets.env. The Anthropic key stays in the vault bridge's
#     launch wrapper (mcp/vault-server/launch.sh) — the one process that needs it. Sourcing it
#     into every skill shell would broadcast the secret to every child process a skill spawns.
#   - It is NOT wired into any launchd plist — launchd does not inherit a shell env; the bridges
#     get their paths from their own plists. This file is for the runbooks, not the daemons.

# --- 1. REPO_ROOT: git first (the anchor), then this file's own location (non-git fallback) ----
if _git_root="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$_git_root" ]; then
  REPO_ROOT="$_git_root"
else
  # Reached when sourced by relative path outside a git checkout. ${BASH_SOURCE} resolves under
  # bash/zsh; under pure sh this falls back to $0 (best-effort — git is the real contract).
  _self="${BASH_SOURCE:-$0}"
  REPO_ROOT="$(cd "$(dirname "$_self")/.." 2>/dev/null && pwd)"
fi

# --- 2. Defaults — only fill if unset. The := RHS is space-safe (unlike a sourced file line) ---
: "${BREW_PREFIX:=$(brew --prefix 2>/dev/null || echo /opt/homebrew)}"
: "${NODE_BIN:=$BREW_PREFIX/bin/node}"
: "${UV_BIN:=$BREW_PREFIX/bin/uv}"
: "${SUPERGATEWAY_BIN:=$BREW_PREFIX/bin/supergateway}"
: "${LAUNCH_AGENTS_DIR:=$HOME/Library/LaunchAgents}"
: "${COWORK_CONFIG:=$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
: "${OPENWHISPR_DB:=$HOME/Library/Application Support/open-whispr/transcriptions.db}"
: "${OPENWHISPR_AUDIO_DIR:=$HOME/Library/Application Support/open-whispr/audio}"
: "${BACKUP_REPO:=$HOME/.cos-backups}"
: "${BOARD_PORT:=3000}"
: "${BOARD_BRIDGE_PORT:=8001}"
: "${OPENWHISPR_BRIDGE_PORT:=8002}"
: "${CALENDAR_BRIDGE_PORT:=8003}"
: "${GUARD_BRIDGE_PORT:=8004}"
: "${VAULT_BRIDGE_PORT:=8005}"
: "${SEARCH_SIDECAR_PORT:=8008}"
: "${GUARD_SIDECAR_PORT:=8009}"
# WhatsApp MCP add-on (external repo verygoodplugins/whatsapp-mcp; see whatsapp-mcp-setup).
# WHATSAPP_GO_PORT is the Go whatsmeow bridge sidecar (whatsmeow's default 8080 is usually
# taken, so cos pins 8010); WHATSAPP_MCP_BRIDGE_PORT is the supergateway bridge for Claude Code.
: "${WHATSAPP_MCP_DIR:=$HOME/Code/whatsapp-mcp}"
: "${WHATSAPP_MCP_BRIDGE_PORT:=8006}"
: "${WHATSAPP_GO_PORT:=8010}"

# --- 3. Override defaults with the real machine config (once cos-setup has written it) ---------
if [ -f "$REPO_ROOT/config/cos.env" ]; then
  set -a
  . "$REPO_ROOT/config/cos.env"
  set +a
fi

# --- 4. Derived values — computed AFTER cos.env so a port/name override propagates -------------
# A blank VAULT_NAME (e.g. before setup-vault fills it) is treated as unset → the template vault.
[ -n "${VAULT_NAME:-}" ] || VAULT_NAME=example-vault
: "${VAULT_DIR:=$REPO_ROOT/vault/$VAULT_NAME}"
: "${BOARD_URL:=http://localhost:$BOARD_PORT}"
: "${BOARD_BRIDGE_URL:=http://localhost:$BOARD_BRIDGE_PORT}"
: "${OPENWHISPR_BRIDGE_URL:=http://localhost:$OPENWHISPR_BRIDGE_PORT}"
: "${CALENDAR_BRIDGE_URL:=http://localhost:$CALENDAR_BRIDGE_PORT}"
: "${GUARD_BRIDGE_URL:=http://localhost:$GUARD_BRIDGE_PORT}"
: "${VAULT_BRIDGE_URL:=http://localhost:$VAULT_BRIDGE_PORT}"
: "${SEARCH_SIDECAR_URL:=http://127.0.0.1:$SEARCH_SIDECAR_PORT}"
: "${GUARD_SIDECAR_URL:=http://127.0.0.1:$GUARD_SIDECAR_PORT}"
: "${WHATSAPP_MCP_BRIDGE_URL:=http://localhost:$WHATSAPP_MCP_BRIDGE_PORT}"
: "${WHATSAPP_GO_URL:=http://localhost:$WHATSAPP_GO_PORT}"

# --- 5. Export for child processes ------------------------------------------------------------
export REPO_ROOT BREW_PREFIX NODE_BIN UV_BIN SUPERGATEWAY_BIN LAUNCH_AGENTS_DIR COWORK_CONFIG
export OPENWHISPR_DB OPENWHISPR_AUDIO_DIR BACKUP_REPO
export VAULT_NAME VAULT_DIR
export BOARD_PORT BOARD_URL
export BOARD_BRIDGE_PORT OPENWHISPR_BRIDGE_PORT CALENDAR_BRIDGE_PORT GUARD_BRIDGE_PORT VAULT_BRIDGE_PORT
export BOARD_BRIDGE_URL OPENWHISPR_BRIDGE_URL CALENDAR_BRIDGE_URL GUARD_BRIDGE_URL VAULT_BRIDGE_URL
export SEARCH_SIDECAR_PORT GUARD_SIDECAR_PORT SEARCH_SIDECAR_URL GUARD_SIDECAR_URL
export WHATSAPP_MCP_DIR WHATSAPP_MCP_BRIDGE_PORT WHATSAPP_GO_PORT WHATSAPP_MCP_BRIDGE_URL WHATSAPP_GO_URL
