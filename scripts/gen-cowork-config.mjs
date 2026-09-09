// scripts/gen-cowork-config.mjs — merge the manifest's bridges into Claude Cowork Desktop's
// claude_desktop_config.json as DIRECT stdio entries. Cowork rejects HTTP `url` entries (that's the
// .mcp.json / Claude Code path), so each bridge becomes { command, args, env } running the stdio
// server directly — NO supergateway, NO COS_MCP_IDLE_EXIT_MS (Cowork holds one long-lived child;
// idle-exit there surfaces as "server transport closed unexpectedly"). Secrets are INLINED into env
// (Cowork can't run the macOS secret-wrapper). Same manifest, so the entry set never drifts from the
// launchd/Windows supervisors. The pure decisions — which entries to build, how to redact them for
// --print, and how to merge them into an existing config — live in scripts/cowork-entries.mjs, kept
// free of machine-config imports so they're testable with in-memory fixtures (ADR 0029); this file
// keeps argv parsing, config/secrets.env + config/cos.env loading, the backup, and the write.
//
//   node scripts/gen-cowork-config.mjs --print   # print the generated mcpServers block (no file touch)
//   node scripts/gen-cowork-config.mjs           # merge into $COWORK_CONFIG (backup-first to .bak)
//
// Merge is non-destructive: it refreshes only the cos bridge entries + leaves every other key
// (preferences, unrelated servers) intact, after writing a .bak. ⌘Q + reopen Cowork to pick it up.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getManifest, currentRole } from '../mcp/service-manifest.mjs'
import { loadConfig, loadSecrets, REPO_ROOT } from '../config/load-config.mjs'
import { buildEntries, redactEntries, mergeServers } from './cowork-entries.mjs'

// Cowork's config is PER-MACHINE (unlike the committed .mcp.json), so it is scoped to
// this machine's device role: a spoke's Cowork gets only the board-facing wrappers
// (they point at the hub via ${BOARD_URL}); hub-only servers never appear at all.
const ROLE = currentRole()

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
const manifestEntries = getManifest({ client: 'cowork', role: ROLE }).filter((e) => FULL_SYNC || NAMES.includes(e.name))
const { entries, refusals, warnings } = buildEntries(manifestEntries, loadSecrets())

for (const w of warnings) process.stderr.write(`[gen-cowork-config] WARNING: ${w}\n`)

if (process.argv.includes('--print')) {
  const redacted = redactEntries(entries, manifestEntries)
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
  // We track the set we last full-synced in a sidecar file (a current getManifest() can't tell us
  // what we used to manage — a deleted descriptor simply isn't in it).
  const trackFile = join(REPO_ROOT, 'mcp', 'logs', '.cowork-managed.json')
  let prior = []
  if (FULL_SYNC) {
    try {
      prior = JSON.parse(readFileSync(trackFile, 'utf8'))
    } catch {
      /* first run */
    }
  }
  current.mcpServers = mergeServers(current.mcpServers || {}, entries, { prior, fullSync: FULL_SYNC })
  writeFileSync(target, JSON.stringify(current, null, 2) + '\n')
  if (FULL_SYNC) writeFileSync(trackFile, JSON.stringify(Object.keys(entries), null, 2) + '\n')
  process.stdout.write(`[gen-cowork-config] merged ${Object.keys(entries).length} bridges into ${target} (backup at .bak). ⌘Q + reopen Cowork.\n`)
}
