// scripts/check-cowork-secrets.mjs — is Cowork's SNAPSHOT of each secret still correct?
//
// THE PROBLEM THIS EXISTS FOR
// ───────────────────────────
// The two MCP client paths bind secrets at different times, and only one of them self-heals:
//
//   Claude Code : mcp/vault-server/launch.sh sources config/secrets.env on EVERY start.
//                 LATE-BOUND — always current.
//   Cowork      : scripts/gen-cowork-config.mjs INLINES the value into
//                 claude_desktop_config.json (Cowork cannot run the macOS secret-wrapper).
//                 EARLY-BOUND — a point-in-time COPY that nothing ever refreshes.
//
// So Cowork's copy silently rots in two distinct ways, both of which present as
// `401 Invalid API key` in Cowork while Claude Code keeps working perfectly:
//
//   1. PLACEHOLDER CAPTURE — the generator ran between `cp secrets.env.example secrets.env`
//      and filling the key in, freezing "sk-ant-xxxx…" in. Filling secrets.env afterwards
//      fixes Claude Code and does nothing for Cowork.
//   2. ROTATION DRIFT — you rotated the key in secrets.env and ran the documented
//      `launchctl kickstart …`. That reloads the Claude Code bridge; Cowork keeps serving
//      the OLD key until someone re-runs the generator.
//
// gen-cowork-config.mjs now REFUSES to create case 1. This checker detects BOTH, including
// a config written before that guard existed.
//
// SECRET HYGIENE: never prints secret material. Comparison and reporting go through
// truncated SHA-256 fingerprints, so the output is safe to paste into an issue.
//
//   node scripts/check-cowork-secrets.mjs          # report; exit 1 if anything is wrong
//   node scripts/check-cowork-secrets.mjs --quiet  # only output on a problem (for hooks)
//
// Exit 0 = in sync (or Cowork not installed — nothing to check). Exit 1 = drift found.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getManifest, currentRole } from '../mcp/service-manifest.mjs'
import { loadConfig, REPO_ROOT } from '../config/load-config.mjs'
import { classifySecret } from '../config/secret-validation.mjs'

const QUIET = process.argv.includes('--quiet')
const ROLE = currentRole()

/** Truncated fingerprint — enough to prove equality, useless as a credential. */
function fingerprint(value) {
  if (typeof value !== 'string' || !value.trim()) return 'absent'
  const sha = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `len=${value.length} sha=${sha}`
}

/** Parse the KEY=value shell file the same way gen-cowork-config.mjs does. */
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

const cfg = loadConfig()
const target = cfg.COWORK_CONFIG
const out = []
const problems = []

if (!target || !existsSync(target)) {
  // Cowork isn't installed (or COWORK_CONFIG is unset) — there is no snapshot to be stale.
  // Not a failure: this machine may be Claude-Code-only.
  if (!QUIET) process.stdout.write('[check-cowork-secrets] SKIP: no Cowork config at ' + (target || '<COWORK_CONFIG unset>') + '\n')
  process.exit(0)
}

let cowork = {}
try {
  cowork = JSON.parse(readFileSync(target, 'utf8'))
} catch {
  process.stderr.write(`[check-cowork-secrets] ${target} is not valid JSON — cannot check.\n`)
  process.exit(1)
}

const secrets = loadSecrets()
const servers = cowork.mcpServers || {}

for (const e of getManifest({ client: 'cowork', role: ROLE })) {
  for (const k of e.secrets || []) {
    const truth = secrets[k] // what secrets.env says NOW (what Claude Code uses)
    const snapshot = (servers[e.name]?.env || {})[k] // what Cowork will actually send

    if (!servers[e.name]) {
      // The server isn't registered with Cowork at all — a different (documented) failure
      // mode, and not this checker's job to fix. Report it, don't fail on it.
      out.push(`  ${e.name}/${k}: server not registered in Cowork config (run gen-cowork-config.mjs)`)
      continue
    }

    const truthState = classifySecret(truth)
    const snapState = classifySecret(snapshot)

    if (snapState === 'placeholder') {
      problems.push(
        `${e.name}/${k}: Cowork holds the TEMPLATE value — '${e.name}' will fail with 401.\n` +
          `    This is a snapshot captured before the real key was set; it will NEVER self-heal.\n` +
          `    Fix: ensure config/secrets.env has the real key, then: node scripts/gen-cowork-config.mjs ${e.name}`,
      )
      continue
    }
    if (snapState === 'absent') {
      problems.push(
        `${e.name}/${k}: missing from Cowork's env — '${e.name}' cannot authenticate.\n` +
          `    Fix: node scripts/gen-cowork-config.mjs ${e.name}`,
      )
      continue
    }
    if (truthState !== 'present') {
      // Cowork has a real-looking value but secrets.env doesn't. Usually means secrets.env was
      // emptied/reset after the snapshot was taken; Claude Code is the broken one here.
      problems.push(
        `${e.name}/${k}: Cowork has a value but config/secrets.env does not (${truthState}).\n` +
          `    Claude Code's bridge reads secrets.env at start, so IT is the broken path.\n` +
          `    Fix: restore the real key in config/secrets.env.`,
      )
      continue
    }
    if (truth !== snapshot) {
      problems.push(
        `${e.name}/${k}: STALE — Cowork's snapshot differs from config/secrets.env (rotation drift).\n` +
          `    secrets.env (Claude Code uses): ${fingerprint(truth)}\n` +
          `    Cowork snapshot              : ${fingerprint(snapshot)}\n` +
          `    Fix: node scripts/gen-cowork-config.mjs ${e.name}   (then ⌘Q + reopen Cowork)`,
      )
      continue
    }
    out.push(`  ${e.name}/${k}: in sync (${fingerprint(truth)})`)
  }
}

if (problems.length) {
  process.stderr.write('[check-cowork-secrets] DRIFT DETECTED\n')
  for (const p of problems) process.stderr.write(`  ✗ ${p}\n`)
  process.stderr.write('\n  Cowork reads this file only at LAUNCH — after fixing, fully quit (⌘Q) and reopen it.\n')
  process.exit(1)
}

if (!QUIET) {
  process.stdout.write('[check-cowork-secrets] all Cowork secret snapshots match config/secrets.env\n')
  for (const line of out) process.stdout.write(line + '\n')
}
