// tests/skill-frontmatter.mjs — the frontmatter `description` of every SKILL.md must satisfy the
// loader's contract, or the skill is REJECTED at install/load time with:
//
//   field 'description' in SKILL.md must be at most 1024 characters
//   SKILL.md description cannot contain XML tags
//
// Both are silent-until-install failures: nothing in the repo notices, `pack-skills --check` happily
// zips an unloadable skill, and you find out when Cowork refuses the upload. Hence a static gate.
//
//   node tests/skill-frontmatter.mjs
//
// Read-only, no deps — scans the checked-in tree directly, in the same spirit as board-lint.mjs and
// skill-reachability.mjs. This is a fifth, disjoint gate: pack-skills --check owns bundle FRESHNESS
// + catalog SYNC, skill-reachability owns delegation-target EXISTENCE, this owns frontmatter VALIDITY.
//
// It checks three things per skill:
//   1. `description` parses at all — a PLAIN (unquoted) scalar containing a colon-space is a nested
//      mapping to YAML, not prose, so a strict parser rejects the whole file. Use a folded `>` block.
//   2. length <= 1024 characters, measured on the FOLDED value (a `>` block joins its lines with a
//      space, so the count is not the raw span in the file).
//   3. no `<...>` span anywhere in it — placeholders like `<id>` or `vault/<name>` read as XML tags
//      to the loader. Write them as `[id]` / `vault/[name]`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const MAX_DESCRIPTION = 1024
const SPACE = String.fromCharCode(32)

// Every tree that holds skills. The two `.claude/skills/` roots are always present; the vault trees
// are per-instance — `vault/example-vault/` is committed (so CI scans it), a private `vault/<name>/`
// is gitignored (so only the machine that owns it scans its own). Both are worth checking wherever
// they exist: the vault skills load into the vault MCP's own headless session under the same rules.
function skillRoots() {
  const roots = [join(REPO_ROOT, '.claude', 'skills'), join(REPO_ROOT, 'board', '.claude', 'skills')]
  const vaultDir = join(REPO_ROOT, 'vault')
  if (existsSync(vaultDir)) {
    for (const entry of readdirSync(vaultDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(vaultDir, entry.name, '.claude', 'skills')
      if (existsSync(candidate)) roots.push(candidate)
    }
  }
  return roots.filter((r) => existsSync(r)).sort()
}

/** Every directory under a root that actually holds a SKILL.md (mirrors scripts/pack-skills.mjs). */
function discoverSkills(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return statSync(join(root, e.name, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
    .map((e) => join(root, e.name, 'SKILL.md'))
    .sort()
}

/**
 * Extract the frontmatter `description` WITHOUT a YAML dependency (the tests/ tree is zero-dep).
 * Deliberately narrower than YAML: it accepts the forms a SKILL.md may legitimately use and
 * reports anything else as an error rather than guessing.
 *
 * Returns { value } on success or { error } on a form the loader would choke on.
 */
function readDescription(src) {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!fm) return { error: 'no YAML frontmatter (a SKILL.md must open with a --- block)' }

  const lines = fm[1].split(/\r?\n/)
  const start = lines.findIndex((l) => /^description:/.test(l))
  if (start === -1) return { error: 'no `description:` key in the frontmatter' }

  const head = lines[start].slice('description:'.length).trim()
  // Continuation lines: everything indented under the key, up to the next top-level key.
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    body.push(lines[i].trim())
  }

  // Block scalar — `>` (folded) or `|` (literal), with optional chomp/indent indicators.
  const block = head.match(/^([>|])[+-]?\d*$/)
  if (block) {
    if (block[1] === '|') return { value: body.join('\n').trim() }
    // Fold: a line break becomes a single space; a BLANK line becomes a hard newline (YAML's rule,
    // and the reason the folded length is not the raw span in the file).
    let out = ''
    for (const part of body) {
      if (!part) out += '\n'
      else out += (!out || out.endsWith('\n') ? '' : SPACE) + part
    }
    return { value: out.trim() }
  }

  if (body.some((l) => l)) {
    // A multi-line PLAIN scalar. Legal YAML, but fragile and unused here — ask for a `>` block.
    return { error: 'multi-line plain scalar — use a folded `>` block scalar instead' }
  }

  if (/^'[\s\S]*'$/.test(head) || /^"[\s\S]*"$/.test(head)) return { value: head.slice(1, -1) }

  // A single-line PLAIN scalar. A colon-space inside one makes YAML read it as a nested mapping and
  // reject the file outright — exactly the shape that broke hub-handover.
  if (head.includes(`:${SPACE}`)) {
    return {
      error:
        'plain (unquoted) scalar containing a colon-space — YAML reads that as a nested mapping ' +
        'and rejects the file. Use a folded `>` block scalar.',
    }
  }
  return { value: head }
}

const violations = []
let checked = 0

for (const root of skillRoots()) {
  for (const file of discoverSkills(root)) {
    checked++
    const rel = relative(REPO_ROOT, file)
    const { value, error } = readDescription(readFileSync(file, 'utf8'))
    if (error) {
      violations.push(`${rel} — ${error}`)
      continue
    }
    if (!value) {
      violations.push(`${rel} — empty description`)
      continue
    }
    if (value.length > MAX_DESCRIPTION) {
      violations.push(
        `${rel} — description is ${value.length} chars, ${value.length - MAX_DESCRIPTION} over the ` +
          `${MAX_DESCRIPTION}-char limit`,
      )
    }
    const tags = [...value.matchAll(/<[^>]*>/g)].map((m) => m[0])
    if (tags.length) {
      violations.push(
        `${rel} — description contains XML-tag-shaped span(s) ${tags.join(', ')} — write ` +
          'placeholders as [name], not <name>',
      )
    }
  }
}

if (violations.length) {
  console.error('[skill-frontmatter] SKILL.md description violation(s):')
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    `[skill-frontmatter] ${violations.length} violation(s) across ${checked} skill(s). ` +
      'A skill that trips these is REJECTED at install/load time, not at pack time.',
  )
  process.exit(1)
}

console.log(`[skill-frontmatter] ${checked} skill(s) checked — every description loads clean.`)
process.exit(0)
