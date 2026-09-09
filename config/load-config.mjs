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
// SCOPE: loadConfig() mirrors load-config.sh and does NOT read config/secrets.env — its returned
// env never carries a credential, so nothing that spreads it into a child spawn can broadcast the
// key. Secrets have their own EXPLICITLY-CALLED reader below (loadSecrets), consumed by the
// tooling that genuinely needs the values (the Cowork generator + drift checker, the Windows
// manager's per-spawn injection); on macOS the vault bridge's launch.sh sources the file itself —
// loadSecrets mirrors exactly that grammar, so the two languages can no longer disagree about
// what the file says.
//
// REQUIREMENT: `sh` must be on PATH. Always true on macOS; on Windows it means Git Bash (already a
// documented prerequisite). If `sh` is missing we fail LOUDLY — never silently fall back to a
// hardcoded port, which would reintroduce the very drift this file exists to kill.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let _cache = null

// Minimal spawn env for both config/secrets subshells below: PATH must survive so `sh`
// resolves on every platform (Windows = Git Bash, this module's own documented
// prerequisite); everything else is excluded so an ambient secret (e.g. a shell-exported
// ANTHROPIC_API_KEY) can never reach the child, let alone loadSecrets()'s result — this is
// spawn-env CONSTRUCTION, not filtering, and is what makes AC 3 true by construction.
const MINIMAL_SPAWN_ENV = { PATH: process.env.PATH || '' }
const SPAWN_OPTS = { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }

/** `KEY=value\n...` (an `env` dump) → a plain object. Shared by loadConfig() and loadSecrets()
 *  below so this repo has exactly one env-dump parser, not two. */
function parseEnvDump(out) {
  const env = {}
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
  }
  return env
}

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
    // `&&` (not `;`) so the loader's own hard-fails PROPAGATE — the new role validation + the
    // spoke+localhost BOARD_URL refusal `return 1`, which must reach Node, not be swallowed and turned
    // into a partial/misconfigured env. brew-prefix noise is filtered per-line below (we can't blanket
    // `2>/dev/null` without also hiding the loader's refusal message), and its stderr is captured so
    // the throw can quote the exact reason.
    out = execFileSync('sh', ['-c', `. "${REPO_ROOT}/config/load-config.sh" && env`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    // This is the intended LOUD failure (never a silent hardcoded-port fallback). The likely causes:
    // the loader REFUSED (invalid COS_DEVICE_ROLE, or spoke + a localhost BOARD_URL); config/
    // load-config.sh missing; a syntax error in a sourced config/cos.env; or `sh` not on PATH (on
    // Windows, install Git Bash). Surface the loader's own stderr so the real reason shows.
    const stderr = (e && e.stderr ? String(e.stderr).trim() : '').split('\n').filter(Boolean).join(' ');
    throw new Error(
      '[load-config] could not source config/load-config.sh — ' +
        (stderr || 'check that the file exists, that a sourced config/cos.env has no syntax error, and that `sh` is on PATH (Windows: install Git Bash).') +
        (e && e.message ? ` (${e.message.split('\n')[0]})` : ''),
    )
  }
  const env = parseEnvDump(out)
  // REPO_ROOT is the git-derived anchor; guarantee it is present + absolute for ${REPO_ROOT}
  // interpolation even in the unlikely case the subshell env dropped it.
  if (!env.REPO_ROOT) env.REPO_ROOT = REPO_ROOT
  _cache = env
  return env
}

// Baseline env dump — what `sh` itself defines with NO file sourced. Process-constant (the
// spawn env is pinned above), so computed once; the FILE is re-read on every call ON
// PURPOSE: cos-services' watch mode must see a rotated key when it respawns a service.
let _secretsBaseline = null

// Shell-owned bookkeeping names `env` always carries that are never a legitimate secret —
// deleted unconditionally rather than relying on the baseline diff to catch them, because
// `_` in particular is set to the LAST argument of the previous command and could in
// principle differ between the baseline and loaded spawns depending on the `sh` flavor
// (CI's is dash, this hub's is bash). Measured on this hub: the unfiltered baseline diff
// already returns exactly the file's own keys, so this is defensive for other `sh` flavors,
// not load-bearing here — don't treat a clean local result as license to drop it.
const SHELL_BOOKKEEPING_KEYS = new Set(['PWD', 'SHLVL', 'OLDPWD', '_'])

/**
 * Read config/secrets.env (or `file`) the SAME WAY the trusted path does —
 * mcp/vault-server/launch.sh's `set -a; . file; set +a` under `set -eu` — and return ONLY
 * the keys the file itself sets. Deleted copies: gen-cowork-config / check-cowork-secrets /
 * cos-services each carried a line-regex re-implementation that silently dropped `export`
 * and indented assignments the shell path accepts (ops#91).
 */
export function loadSecrets(file = resolve(REPO_ROOT, 'config', 'secrets.env')) {
  if (!existsSync(file)) return {} // mid-setup absence is a legitimate state, not an error

  if (!_secretsBaseline) {
    const baseOut = execFileSync('sh', ['-c', 'env'], { ...SPAWN_OPTS, env: MINIMAL_SPAWN_ENV })
    _secretsBaseline = parseEnvDump(baseOut)
  }

  let loadedOut
  try {
    // The file path is a POSITIONAL PARAM ($1), never string-interpolated into the command.
    // set -eu mirrors launch.sh exactly: a junk command line, an unset-$VAR expansion, or an
    // unclosed quote aborts here just like it aborts the vault bridge's own start.
    loadedOut = execFileSync('sh', ['-c', 'set -eu; set -a; . "$1"; set +a; env', 'sh', file], {
      ...SPAWN_OPTS,
      env: MINIMAL_SPAWN_ENV,
    })
  } catch (e) {
    const stderr = (e && e.stderr ? String(e.stderr).trim() : '').split('\n').filter(Boolean).join(' ')
    // The throw IS the diagnosis, not a pre-empted one: mcp/vault-server/launch.sh sources
    // this SAME file under set -eu on every bridge start, so a file that fails here will also
    // fail to start the vault bridge — fix the file, don't just retry the caller.
    throw new Error(
      `[load-config] could not source ${file} — ` +
        (stderr || 'sh refused it (an unset $VAR reference, an unclosed quote, or a stray command line).') +
        ' The vault bridge (mcp/vault-server/launch.sh) sources this exact file the same way on every start, so it will fail to start too — fix the file, this error IS the diagnosis.' +
        (e && e.message ? ` (${e.message.split('\n')[0]})` : ''),
    )
  }
  const loaded = parseEnvDump(loadedOut)

  const result = {}
  for (const [k, v] of Object.entries(loaded)) {
    if (SHELL_BOOKKEEPING_KEYS.has(k)) continue
    if (_secretsBaseline[k] === v) continue // unchanged vs baseline ⇒ ambient, not file-set
    result[k] = v.endsWith('\r') ? v.slice(0, -1) : v // a CRLF-edited file must not poison the value
  }
  return result
}
