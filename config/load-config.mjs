// config/load-config.mjs — the Node KEYSTONE that lets JavaScript read the SAME machine config the
// POSIX shell loader (config/load-config.sh) defines, WITHOUT re-implementing it.
//
// WHY this exists: load-config.sh is the single source of truth for ports / paths / binaries — it
// derives REPO_ROOT from git, seeds defaults, sources the gitignored config/cos.env so a machine
// override wins, then derives the *_URL / VAULT_DIR / BREW_PREFIX / SUPERGATEWAY_BIN / UV_BIN values
// and exports them. Node cannot `source` a shell script, so Node tools used to hardcode ports/paths
// — which is exactly how a separate Windows supervision layer drifts away from cos.env. Rather than
// re-parse cos.env in JS (a SECOND, divergent loader), this runs the shell loader ONCE in a subshell
// and captures its exported environment. One source of truth, consumed from two languages.
//
// SCOPE — mirrors load-config.sh: this does NOT load config/secrets.env. The ANTHROPIC_API_KEY is
// injected per-process by the secret-wrapper (macOS) / the Windows manager's loadSecrets(), never
// broadcast into every child.
//
// REQUIREMENT: `sh` must be on PATH. Always true on macOS; on Windows it means Git Bash (already a
// documented prerequisite). If `sh` is missing we fail LOUDLY — never silently fall back to a
// hardcoded port, which would reintroduce the very drift this file exists to kill.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let _cache = null

/**
 * Source config/load-config.sh in a subshell and return its exported environment as a plain object.
 * Memoized: the subshell runs at most once per process.
 * @returns {Record<string,string>} resolved env — BOARD_BRIDGE_PORT, VAULT_DIR, SUPERGATEWAY_BIN,
 *   UV_BIN, NODE_BIN, BOARD_URL, GUARD_SIDECAR_URL, WHATSAPP_MCP_DIR, COS_GUARD_MODEL, REPO_ROOT, …
 */
export function loadConfig() {
  if (_cache) return _cache
  let out
  try {
    // The loader only assigns + exports (no stdout), so `env` after it yields a clean KEY=VALUE dump.
    // `2>/dev/null` swallows benign noise (e.g. `brew --prefix` on a machine without Homebrew); the
    // loader seeds defaults for everything it touches, so suppressing stderr loses nothing we need.
    out = execFileSync('sh', ['-c', `. "${REPO_ROOT}/config/load-config.sh" 2>/dev/null; env`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (e) {
    // This is the intended LOUD failure (never a silent hardcoded-port fallback). The likely causes,
    // in order: config/load-config.sh missing; a syntax error in a sourced config/cos.env; or `sh`
    // not on PATH (on Windows, install Git Bash — a documented prerequisite).
    throw new Error(
      '[load-config] could not source config/load-config.sh. Check that the file exists, that a ' +
        'sourced config/cos.env has no syntax error, and that `sh` is on PATH (Windows: install Git ' +
        'Bash). Underlying error: ' + e.message,
    )
  }
  const env = {}
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
  }
  // REPO_ROOT is the git-derived anchor; guarantee it is present + absolute for ${REPO_ROOT}
  // interpolation even in the unlikely case the subshell env dropped it.
  if (!env.REPO_ROOT) env.REPO_ROOT = REPO_ROOT
  _cache = env
  return env
}
