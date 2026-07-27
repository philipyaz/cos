// tests/skill-reachability.mjs — a skill may only delegate to a slash-skill that exists in ITS OWN
// runtime (board/.claude/CLAUDE.md: "a skill may only compose tools that already exist"). Every
// board skill runs in Cowork, which installs skills only from board/.claude/skill-bundles/*.zip —
// so a delegation to a skill with no bundle there is a silent no-op at runtime, not a load-time
// error. That is exactly how cos-ops#1 happened: two capture sweeps delegated vault ingest to
// `/second-brain-ingest`, a skill that lives only in the vault's own headless session, and the
// vault went unfed for 41 days with no error anywhere.
//
//   node tests/skill-reachability.mjs
//
// Read-only, no deps — scans the checked-in tree directly (board-lint.mjs is the precedent for a
// static invariant checker living in tests/; this is a fourth, disjoint gate: pack-skills --check
// owns bundle FRESHNESS, this owns delegation-target EXISTENCE).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const SKILLS_DIR = join(REPO_ROOT, 'board', '.claude', 'skills')
const BUNDLES_DIR = join(REPO_ROOT, 'board', '.claude', 'skill-bundles')

// Junk that must never be scanned — mirrors scripts/pack-skills.mjs's walk.
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules', '__pycache__'])
const isIgnored = (name) => IGNORED.has(name) || name.startsWith('._') || name.endsWith('~')

// Candidates that trip the regex below but are NOT a missing-bundle defect. Two legitimate reasons
// a name would ever belong here: (a) a future BOARD ROUTE that happens to be hyphenated and
// backticked (every route mentioned today — `/security`, `/fitness`, `/body` — is a single word,
// so none qualify yet); (b) a deliberate reference to a Claude Code-ONLY setup skill that will
// never have a Cowork bundle (root `.claude/skills/` isn't packed by scripts/pack-skills.mjs) — e.g.
// `/fitness-mcp-setup`, named in `fitness-coach/SKILL.md` today in **bold**, not backticks, so it
// doesn't trip the gate, but would if it were ever backticked. Keep this empty until one of those
// is real: it is a documented escape hatch, not a place to launder an actual missing bundle.
const NON_SKILL_TOKENS = new Set([])

/** Every *.md file, recursively, under board/.claude/skills/ (README.md and references/ included). */
function collectMarkdownFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (isIgnored(entry.name)) continue
      const abs = join(d, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs)
    }
  }
  walk(dir)
  return out.sort()
}

const bundleExists = (name) => {
  try {
    return statSync(join(BUNDLES_DIR, `${name}.zip`)).isFile()
  } catch {
    return false
  }
}

// A backtick code-span whose ENTIRE content is a single-segment kebab token with >= 1 hyphen.
// Anchored on the backticks (not just the token) so a multi-token span like
// `` `<BOARD_URL>/my-issues` `` or `` `Run /mail-to-board` `` can't match (the character right
// after the opening backtick must be the `/`, and the token must run straight into the closing
// backtick) — and an API path like `` `/api/nutrition/log` `` can't either, since the mandatory
// hyphen group never matches before the next `/`. Verified exact on the current tree (see PR body).
const CANDIDATE_RE = /`(\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g

const files = collectMarkdownFiles(SKILLS_DIR)
let refsChecked = 0
const violations = []

for (const file of files) {
  const rel = relative(REPO_ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const match of line.matchAll(CANDIDATE_RE)) {
      const name = match[1].slice(1) // drop the leading "/"
      refsChecked++
      if (NON_SKILL_TOKENS.has(name)) continue
      if (!bundleExists(name)) {
        violations.push(`${rel}:${i + 1} — \`/${name}\` has no bundle (${name}.zip)`)
      }
    }
  })
}

if (violations.length) {
  console.error('[skill-reachability] delegation target(s) with no Cowork bundle:')
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    `[skill-reachability] ${violations.length} violation(s) across ${files.length} file(s) scanned. ` +
      'A skill may only delegate to a slash-skill that exists in its own runtime — see board/.claude/CLAUDE.md.',
  )
  process.exit(1)
}

console.log(
  `[skill-reachability] ${files.length} file(s) scanned, ${refsChecked} delegation ref(s) checked — all reachable.`,
)
process.exit(0)
