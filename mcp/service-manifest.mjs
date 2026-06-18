// mcp/service-manifest.mjs — the ONE place that knows the full set of MCP services and how to launch
// them, on EVERY platform. It is the hub of the cross-platform supervision layer: every supervisor,
// probe, and client config is a thin CONSUMER of getManifest() (or the `--json` / `--probe-list` CLI),
// so a service is defined exactly once instead of being re-encoded per OS.
//
// HOW IT WORKS
//   1. It discovers co-located, declarative descriptors named `<name>.service.json` (one per service,
//      next to that service's code — mirroring the existing "each server owns its deploy/ template").
//   2. It loads the resolved machine config from config/load-config.sh (via config/load-config.mjs),
//      the single source of truth for ports/paths/binaries.
//   3. It interpolates the descriptors' ${VAR} references and resolves each portVar to a number,
//      FAILING LOUDLY on an unknown variable or a stale schemaVersion — never silently guessing.
//   4. It derives the launchd label and log paths, and returns fully-resolved entries.
//
// A descriptor carries only NAMES and references (portVar, ${VAR}, secrets[]), NEVER literal ports,
// absolute paths, usernames, or toolchain locations — those all come from the loader. That is what
// makes a cos.env override propagate to every OS and makes it impossible to commit a personal path.
//
// CONSUMERS
//   - mcp/cos-services.mjs (Windows process manager)  →  `node service-manifest.mjs --json`
//   - mcp/ensure-bridges.sh (both branches' probes)   →  `node service-manifest.mjs --probe-list`
//   - scripts/gen-launchd.mjs (macOS LaunchAgents)    →  import { getManifest }
//   - scripts/gen-mcp-json.mjs (.mcp.json, Claude Code) → import { getManifest }
//   - scripts/gen-cowork-config.mjs (Cowork stdio)    →  import { getManifest }

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, REPO_ROOT } from '../config/load-config.mjs'

export const SCHEMA_VERSION = 1

// supergateway's --stdio takes ONE shell-command string that it re-parses with shell-word splitting.
// Join the stdio argv into that string, quoting any token containing whitespace so a path like
// "C:/My Tools/node.exe" survives the re-split intact. Shared by gen-launchd.mjs + cos-services.mjs so
// both render the bridge command identically. (Use forward-slash paths on Windows — the repo convention.)
export function stdioToArg(stdio) {
  return stdio.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ')
}

// Where descriptors live: any `<name>.service.json` directly under an mcp/* subdir, plus the two
// Python sidecars that live outside mcp/ (guard/ and search/). Kept as an explicit, bounded scan
// (no glob dependency) so discovery is predictable and order-stable (sorted).
function discoverDescriptorFiles() {
  const files = []
  const mcpDir = join(REPO_ROOT, 'mcp')
  for (const ent of readdirSync(mcpDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const dir = join(mcpDir, ent.name)
    for (const f of readdirSync(dir)) if (f.endsWith('.service.json')) files.push(join(dir, f))
  }
  for (const extra of ['guard', 'search']) {
    const dir = join(REPO_ROOT, extra)
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) if (f.endsWith('.service.json')) files.push(join(dir, f))
    }
  }
  return files.sort()
}

// Replace every ${VAR} in `value` with env[VAR]. Throws (naming the descriptor + the missing var) on
// any unresolved reference — a missing var means the loader/cos.env is out of sync with a descriptor,
// which must be a loud failure, never a silent empty string baked into a plist or spawn.
function interpolate(value, env, where) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') {
      throw new Error(
        `[service-manifest] ${where}: unresolved \${${name}} — add it to config/load-config.sh ` +
          `(and config/cos.env.example) so it resolves on every machine.`,
      )
    }
    return env[name]
  })
}

// Deep-interpolate strings inside arrays / plain objects (used for stdio[], exec[], env{}).
function interpolateDeep(node, env, where) {
  if (typeof node === 'string') return interpolate(node, env, where)
  if (Array.isArray(node)) return node.map((n) => interpolateDeep(n, env, where))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = interpolateDeep(v, env, where)
    return out
  }
  return node
}

function resolveEntry(raw, file, env) {
  const where = raw && raw.name ? `${raw.name} (${file})` : file
  if (!raw || typeof raw !== 'object') throw new Error(`[service-manifest] ${file}: not an object`)
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `[service-manifest] ${where}: schemaVersion ${raw.schemaVersion} != ${SCHEMA_VERSION} — ` +
        `the descriptor format changed; update the descriptor (see mcp/CLAUDE.md).`,
    )
  }
  for (const req of ['name', 'kind', 'runtime']) {
    if (!raw[req]) throw new Error(`[service-manifest] ${where}: missing required field "${req}"`)
  }
  if (!['bridge', 'sidecar', 'runner'].includes(raw.kind)) {
    throw new Error(`[service-manifest] ${where}: kind must be bridge|sidecar|runner`)
  }
  if (!['bridge', 'uvicorn', 'exec'].includes(raw.runtime)) {
    throw new Error(`[service-manifest] ${where}: runtime must be bridge|uvicorn|exec`)
  }

  const name = raw.name
  const port = raw.portVar ? Number(interpolate(`\${${raw.portVar}}`, env, where)) : null
  if (raw.portVar && !Number.isInteger(port)) {
    throw new Error(`[service-manifest] ${where}: portVar ${raw.portVar} did not resolve to a number`)
  }

  const entry = {
    name,
    kind: raw.kind, // bridge | sidecar | runner
    runtime: raw.runtime, // bridge (supergateway-wrapped) | uvicorn (uv/venv) | exec (raw)
    core: raw.core === true,
    addon: raw.addon || null, // board add-on id, if this is an add-on service
    optional: raw.optional === true, // conditionally installed (e.g. vaultjobs) but not a board add-on
    portVar: raw.portVar || null,
    port,
    cwd: interpolate(raw.cwd || '${REPO_ROOT}', env, where),
    env: interpolateDeep(raw.env || {}, env, where),
    secrets: raw.secrets || [], // env keys (e.g. ANTHROPIC_API_KEY) sourced from config/secrets.env
    // macOS secret-sourcing wrapper: launchd can't expand $VARS or read secrets.env, so a secret
    // service's plist runs this wrapper (it sources config/secrets.env then execs the real command).
    // The Windows manager ignores it — it injects secrets into the spawn env instead. Optional;
    // present only on secret services until the wrapper is generated from the descriptor (follow-up).
    secretWrapper: raw.secretWrapper ? interpolate(raw.secretWrapper, env, where) : null,
    idleExit: raw.idleExit === true, // add COS_MCP_IDLE_EXIT_MS on the BRIDGE spawn (never on Cowork)
    clients: raw.clients || [], // which MCP clients get an entry: claude-code | cowork
    probe: raw.probe || { type: port ? 'httpListen' : 'process' },
    descriptorFile: file,
    // Derived, platform-agnostic identity used by launchd + the Windows manager + the logs.
    label: `com.chiefofstaff.mcp-${name}`,
    logOut: join(REPO_ROOT, 'mcp', 'logs', `${name}.out.log`),
    logErr: join(REPO_ROOT, 'mcp', 'logs', `${name}.err.log`),
  }

  // inMcpJson / Cowork eligibility: only bridges that list 'claude-code' / 'cowork' as clients.
  // Sidecars + runners are HTTP/background services — never exposed to an MCP client. An explicit
  // inMcpJson:false in a descriptor is belt-and-suspenders and always wins.
  entry.inMcpJson = raw.inMcpJson === false ? false : entry.kind === 'bridge' && entry.clients.includes('claude-code')
  entry.inCowork = entry.kind === 'bridge' && entry.clients.includes('cowork')

  // runtime-specific, resolved launch shape
  if (raw.runtime === 'bridge') {
    if (!Array.isArray(raw.stdio)) throw new Error(`[service-manifest] ${where}: bridge needs stdio[]`)
    entry.stdio = interpolateDeep(raw.stdio, env, where) // the command supergateway wraps over stdio
  } else if (raw.runtime === 'uvicorn') {
    if (!raw.dir) throw new Error(`[service-manifest] ${where}: uvicorn runtime needs dir`)
    entry.dir = interpolate(raw.dir, env, where)
    entry.app = raw.app || 'sidecar:app'
    entry.host = raw.host || '127.0.0.1'
    entry.uvExtras = raw.uvExtras || [] // macOS `uv run --extra <x>`; a venv-provisioning concern
  } else if (raw.runtime === 'exec') {
    if (!Array.isArray(raw.exec)) throw new Error(`[service-manifest] ${where}: exec runtime needs exec[]`)
    entry.exec = interpolateDeep(raw.exec, env, where)
  }

  return entry
}

let _manifestCache = null

/**
 * Load + resolve every descriptor against config/load-config.sh.
 * @param {object} [opts]
 * @param {'claude-code'|'cowork'} [opts.client] only services exposed to this client (a bridge)
 * @param {'bridge'|'sidecar'|'runner'} [opts.kind] only this kind
 * @returns {Array} fully-resolved, ${VAR}-free entries
 */
export function getManifest(opts = {}) {
  if (!_manifestCache) {
    const env = loadConfig()
    const entries = discoverDescriptorFiles().map((f) => resolveEntry(JSON.parse(readFileSync(f, 'utf8')), f, env))
    const seen = new Set()
    for (const e of entries) {
      if (seen.has(e.name)) throw new Error(`[service-manifest] duplicate service name "${e.name}"`)
      seen.add(e.name)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    _manifestCache = entries
  }
  let out = _manifestCache
  if (opts.client) out = out.filter((e) => e.clients.includes(opts.client) && e.kind === 'bridge')
  if (opts.kind) out = out.filter((e) => e.kind === opts.kind)
  return out
}

// ── CLI: shell/CJS consumers that can't `import` ESM read these ──────────────────────────────────
// `--json`        full resolved manifest (the Windows manager parses this)
// `--probe-list`  one tab-separated line per service: name<TAB>port<TAB>kind<TAB>probe<TAB>gate
//                 (ensure-bridges.sh reads this; gate = core|optional, port = number or "-")
// (no arg)        a human-readable table
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2]
  const m = getManifest()
  if (mode === '--json') {
    process.stdout.write(JSON.stringify(m, null, 2) + '\n')
  } else if (mode === '--probe-list') {
    for (const e of m) {
      const gate = e.core ? 'core' : 'optional' // addon + optional both skip silently when absent
      process.stdout.write([e.name, e.port ?? '-', e.kind, e.probe.type, gate].join('\t') + '\n')
    }
  } else {
    process.stdout.write(`Cos service manifest — ${m.length} services\n`)
    for (const e of m) {
      const gate = e.core ? 'core' : e.addon ? `addon:${e.addon}` : 'optional'
      process.stdout.write(
        `  ${e.name.padEnd(16)} ${String(e.port ?? '-').padEnd(6)} ${e.kind.padEnd(8)} ${e.runtime.padEnd(8)} ${gate}\n`,
      )
    }
  }
}
