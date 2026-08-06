// tests/skill-reachability.mjs — this file owns TWO reachability contracts, in both directions:
//
// SCAN 1 (delegation -> target): a skill may only delegate to a slash-skill that exists in ITS
// OWN runtime (board/.claude/CLAUDE.md: "a skill may only compose tools that already exist").
// Every board skill runs in Cowork, which installs skills only from
// board/.claude/skill-bundles/*.zip — so a delegation to a skill with no bundle there is a silent
// no-op at runtime, not a load-time error. That is exactly how cos-ops#1 happened: two capture
// sweeps delegated vault ingest to `/second-brain-ingest`, a skill that lives only in the vault's
// own headless session, and the vault went unfed for 41 days with no error anywhere.
//
// SCAN 2 (registry -> reference, cos-ops#35): an add-on's registry-declared setup skill
// (board/lib/addons.ts's mcp.setupSkill) must be reachable from the first-run orchestrator
// (.claude/skills/cos-setup/SKILL.md) — either sequenced as a step, or explicitly declared out of
// scope with a reason. That is exactly how cos-ops#35 happened: `fitness-mcp-setup` and
// `body-mcp-setup` were both declared in the registry and both silently absent from cos-setup,
// and `setupSkill` had zero code consumers to notice the drift.
//
//   node tests/skill-reachability.mjs
//
// Read-only, no deps — scans the checked-in tree directly (board-lint.mjs is the precedent for a
// static invariant checker living in tests/; this is a fourth, disjoint gate: pack-skills --check
// owns bundle FRESHNESS + catalog SYNC, this owns delegation-target EXISTENCE in both directions).

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

const scan1Count = violations.length

// SCAN 2 (registry -> reference, cos-ops#35): every add-on's registry-declared setupSkill must be
// reachable from cos-setup — either sequenced as a step, or explicitly declared out of scope with
// a reason. Source-level regex over board/lib/addons.ts as TEXT, not an import — the house idiom
// for a tests/ static gate (tests/shopping-list-consumers.mjs parses the same file the same way).
const ADDONS_FILE = join(REPO_ROOT, 'board', 'lib', 'addons.ts')
const ROOT_SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills')
const COS_SETUP_FILE = join(ROOT_SKILLS_DIR, 'cos-setup', 'SKILL.md')

const rootSkillExists = (name) => {
  try {
    return statSync(join(ROOT_SKILLS_DIR, name, 'SKILL.md')).isFile()
  } catch {
    return false
  }
}

const addonsSrc = readFileSync(ADDONS_FILE, 'utf8')
const setupSkills = new Set(
  [...addonsSrc.matchAll(/setupSkill:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]),
)

if (setupSkills.size === 0) {
  // The parse itself broke (regex or registry moved) — deliberately >= 1, not an exact count, so
  // a fourth add-on landing never has to bump a frozen expectation here.
  violations.push(
    'no mcp.setupSkill entries parsed from board/lib/addons.ts — the regex or the registry moved; ' +
      'this scan can no longer see its input.',
  )
} else {
  const cosSetupSrc = readFileSync(COS_SETUP_FILE, 'utf8')
  for (const name of setupSkills) {
    if (!rootSkillExists(name)) {
      violations.push(
        `board/lib/addons.ts declares setupSkill "${name}" but .claude/skills/${name}/SKILL.md ` +
          "does not exist — a typo'd or renamed setupSkill value.",
      )
    }
    if (!new RegExp('/' + name + '(?![\\w-])').test(cosSetupSrc)) {
      violations.push(
        `\`/${name}\` is declared as an add-on's setupSkill in board/lib/addons.ts but ` +
          '.claude/skills/cos-setup/SKILL.md never references it — sequence it as a step (or ' +
          `declare it out of scope with a reason), naming it as \`/${name}\`.`,
      )
    }
  }
}

const scan2Count = violations.length - scan1Count

if (violations.length) {
  console.error('[skill-reachability] reachability violation(s):')
  for (const v of violations) console.error(`  ${v}`)
  const contracts = []
  if (scan1Count > 0) {
    contracts.push(
      `${scan1Count} across ${files.length} file(s) scanned — a skill may only delegate to a ` +
        'slash-skill that exists in its own runtime (see board/.claude/CLAUDE.md).',
    )
  }
  if (scan2Count > 0) {
    contracts.push(
      `${scan2Count} across ${setupSkills.size} registry setup skill(s) checked — an add-on's ` +
        'setupSkill in board/lib/addons.ts must be reachable from cos-setup (see cos-ops#35).',
    )
  }
  console.error(`[skill-reachability] ${violations.length} violation(s) total. ${contracts.join(' ')}`)
  process.exit(1)
}

console.log(
  `[skill-reachability] ${files.length} file(s) scanned, ${refsChecked} delegation ref(s) checked, ` +
    `${setupSkills.size} registry setup skill(s) reachable from cos-setup — all reachable.`,
)
process.exit(0)
