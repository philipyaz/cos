// scripts/gen-cowork-config.mjs — merge the manifest's bridges into Claude Cowork Desktop's
// claude_desktop_config.json as DIRECT stdio entries. Cowork rejects HTTP `url` entries (that's the
// .mcp.json / Claude Code path), so each bridge becomes { command, args, env } running the stdio
// server directly — NO supergateway, NO COS_MCP_IDLE_EXIT_MS (Cowork holds one long-lived child;
// idle-exit there surfaces as "server transport closed unexpectedly"). Secrets are INLINED into env
// (Cowork can't run the macOS secret-wrapper). Same manifest, so the entry set never drifts from the
// launchd/Windows supervisors.
//
//   node scripts/gen-cowork-config.mjs --print   # print the generated mcpServers block (no file touch)
//   node scripts/gen-cowork-config.mjs           # merge into $COWORK_CONFIG (backup-first to .bak)
//
// Merge is non-destructive: it refreshes only the cos bridge entries + leaves every other key
// (preferences, unrelated servers) intact, after writing a .bak. ⌘Q + reopen Cowork to pick it up.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getManifest, currentRole } from '../mcp/service-manifest.mjs'
import { loadConfig, REPO_ROOT } from '../config/load-config.mjs'
import {
  classifySecret,
  anthropicKeyShapeWarning,
  secretRefusalMessage,
} from '../config/secret-validation.mjs'

// Cowork's config is PER-MACHINE (unlike the committed .mcp.json), so it is scoped to
// this machine's device role: a spoke's Cowork gets only the board-facing wrappers
// (they point at the hub via ${BOARD_URL}); hub-only servers never appear at all.
const ROLE = currentRole()

function loadSecrets() {
  const env = {}
  const p = join(REPO_ROOT, 'config', 'secrets.env')
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return env
}

// Optional service-name args select WHICH cowork bridges to merge (a per-add-on skill names just its
// own); no names = ALL cowork bridges (a full resync). --print and --all are flags, not names.
const NAMES = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const FULL_SYNC = NAMES.length === 0

// Secrets that must NOT be snapshotted (placeholder or missing), collected while building so the
// write path can refuse ATOMICALLY — before the backup + write — rather than leaving a config that is
// right about everything except the one thing that makes the server work. Only ever populated for a
// server actually IN this run's set, so a named merge that excludes the secret-carrying server
// (`… board calendar`) can't trip on it, and neither can a spoke (vault is roles:["hub"], so it isn't
// in a spoke's manifest at all).
const refusals = []
const warnings = []

function buildEntries() {
  const secrets = loadSecrets()
  const out = {}
  for (const e of getManifest({ client: 'cowork', role: ROLE })) {
    if (!FULL_SYNC && !NAMES.includes(e.name)) continue
    const env = { ...e.env } // e.env has NO PATH / idle-exit (those are bridge/plist-only) — correct for Cowork
    for (const k of e.secrets || []) {
      const value = secrets[k]
      // Cowork gets a SNAPSHOT of this value, not a reference to secrets.env (it can't run the macOS
      // secret-wrapper). So a placeholder captured here is PERMANENT: the server 401s and never
      // recovers, even after the real key lands in secrets.env — which is exactly the bug this guard
      // exists to stop. Full write-up in config/secret-validation.mjs.
      const state = classifySecret(value)
      if (state !== 'present') {
        refusals.push(secretRefusalMessage(k, state, e.name))
        continue // never write a known-dead credential into the entry
      }
      if (k === 'ANTHROPIC_API_KEY') {
        // SOFT check only, never a hard gate: Anthropic's key format isn't a contract we control, so a
        // strict validator here would break setup the day it changes. This only nudges on an
        // obviously-truncated paste.
        const w = anthropicKeyShapeWarning(value)
        if (w) warnings.push(`${k} for '${e.name}' ${w}`)
      }
      env[k] = value
    }
    // The stdio command IS the direct command Cowork runs (node server.mjs / uv run … main.py).
    out[e.name] = { command: e.stdio[0], args: e.stdio.slice(1), env }
  }
  return out
}

const entries = buildEntries()

for (const w of warnings) process.stderr.write(`[gen-cowork-config] WARNING: ${w}\n`)

if (process.argv.includes('--print')) {
  // Redact secret VALUES in the printed preview so a console/log never shows the key.
  const redacted = JSON.parse(JSON.stringify(entries))
  for (const e of getManifest({ client: 'cowork', role: ROLE })) {
    if (!redacted[e.name]) continue
    for (const k of e.secrets || []) if (redacted[e.name].env[k]) redacted[e.name].env[k] = '«from config/secrets.env»'
  }
  // --print touches no file, so a bad secret is a WARNING here rather than a refusal — you can still
  // inspect the shape of what WOULD be written. The write path below is where it's fatal.
  for (const r of refusals) process.stderr.write(`[gen-cowork-config] WOULD REFUSE TO WRITE: ${r}\n`)
  process.stdout.write(JSON.stringify({ mcpServers: redacted }, null, 2) + '\n')
} else {
  // Refuse BEFORE the backup + write so the run is atomic: a placeholder secret leaves the existing
  // config completely untouched.
  if (refusals.length) {
    for (const r of refusals) process.stderr.write(`[gen-cowork-config] REFUSING TO WRITE: ${r}\n`)
    process.stderr.write('[gen-cowork-config] aborted — no changes made.\n')
    process.exit(1)
  }
  const cfg = loadConfig()
  const target = cfg.COWORK_CONFIG
  if (!target) {
    process.stderr.write('[gen-cowork-config] COWORK_CONFIG is unset in config/load-config.sh\n')
    process.exit(1)
  }
  // Refuse to write into a directory that doesn't exist: that almost always means COWORK_CONFIG points
  // at the wrong place (Cowork installed elsewhere, or not installed) — better a clear error than
  // silently creating an orphan config Cowork will never read. The cos-setup step detects + records
  // this path; if it's wrong, fix COWORK_CONFIG in config/cos.env to the real claude_desktop_config.json.
  const dir = dirname(target)
  if (!existsSync(dir)) {
    process.stderr.write(
      `[gen-cowork-config] Cowork config dir not found: ${dir}\n` +
        `  COWORK_CONFIG points there but it doesn't exist. Is Claude Cowork Desktop installed?\n` +
        `  Set COWORK_CONFIG in config/cos.env to the real claude_desktop_config.json path and retry.\n`,
    )
    process.exit(1)
  }
  let current = {}
  if (existsSync(target)) {
    copyFileSync(target, target + '.bak') // backup-first
    try {
      current = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      process.stderr.write(`[gen-cowork-config] ${target} is not valid JSON; aborting (backup at .bak)\n`)
      process.exit(1)
    }
  }
  // In FULL-SYNC mode (no names) prune cos-owned entries the manifest no longer defines (descriptor
  // deleted, or an add-on's clients no longer lists cowork) so the Cowork config can't drift stale —
  // WITHOUT touching a third-party server the user added by hand. We track the set we last full-synced
  // in a sidecar file (a current getManifest() can't tell us what we used to manage — a deleted
  // descriptor simply isn't in it). A NAMED merge is additive and never prunes.
  const trackFile = join(REPO_ROOT, 'mcp', 'logs', '.cowork-managed.json')
  const fresh = new Set(Object.keys(entries))
  const servers = { ...(current.mcpServers || {}) }
  if (FULL_SYNC) {
    let prior = []
    try {
      prior = JSON.parse(readFileSync(trackFile, 'utf8'))
    } catch {
      /* first run */
    }
    for (const name of prior) if (!fresh.has(name)) delete servers[name]
  }
  current.mcpServers = { ...servers, ...entries }
  writeFileSync(target, JSON.stringify(current, null, 2) + '\n')
  if (FULL_SYNC) writeFileSync(trackFile, JSON.stringify([...fresh], null, 2) + '\n')
  process.stdout.write(`[gen-cowork-config] merged ${Object.keys(entries).length} bridges into ${target} (backup at .bak). ⌘Q + reopen Cowork.\n`)
}
