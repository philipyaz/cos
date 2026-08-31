// tests/skill-reachability.mjs — this file owns THREE reachability contracts, in both directions:
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
// SCAN 3 (fetch -> screen, cos-ops#26): a skill SECTION that instructs an external web fetch must
// also contain the literal `classify_text` — the untrusted-content contract stated once in
// board/.claude/CLAUDE.md ("Screens untrusted content"). That is exactly how cos-ops#26 happened:
// `classify_text` shipped as the guard's generic lane and sat at zero callers while ops#24's
// research step shipped a web-search fallback with no screening step at all. Matching runs over
// each file's WHOLE content string, not per line, so a phrase wrapped across a line break (these
// bodies wrap at ~72 columns) still matches — ADR 0014 names this exact near-miss. The pairing is
// checked per SECTION, not per file: a whole-file check would go permanently green the moment ANY
// section anywhere mentions `classify_text`, which is the exact insufficiency
// tests/triage-decisions-consumers.mjs:20-23 documents for its own sibling gates.
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
// for a tests/ static gate (tests/board-lint.mjs reads its inputs the same way).
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
// Every `setupSkill:` key in the registry must have parsed as a plain quoted kebab string — a
// template literal, a shared const, or an odd name would otherwise silently shrink the checked
// set (a per-entry false negative the >= 1 guard below cannot see).
const setupSkillKeys = (addonsSrc.match(/\bsetupSkill\s*:(?!\s*string\b)/g) || []).length // registry entries only, not the interface's `setupSkill: string`
if (setupSkillKeys !== setupSkills.size) {
  violations.push(
    `board/lib/addons.ts has ${setupSkillKeys} setupSkill key(s) but only ${setupSkills.size} parsed as a ` +
      'plain quoted kebab-case string — every setupSkill value must be written as "name-mcp-setup" so this ' +
      'gate can see it.',
  )
}

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
    // The slash-invocation form only: `/name` not preceded by a path/word character, so a bare
    // file-path mention (`.claude/skills/name/SKILL.md`) does not count as reachability.
    if (!new RegExp('(?<![\\w./-])/' + name + '(?![\\w-])').test(cosSetupSrc)) {
      violations.push(
        `\`/${name}\` is declared as an add-on's setupSkill in board/lib/addons.ts but ` +
          '.claude/skills/cos-setup/SKILL.md never references it — sequence it as a step (or ' +
          `declare it out of scope with a reason), naming it as \`/${name}\`.`,
      )
    }
  }
}

const scan2Count = violations.length - scan1Count

// SCAN 3 (fetch -> screen, cos-ops#26): a skill section that instructs an external web fetch
// (WebSearch/WebFetch, or prose naming a web/internet search) must also reference the guard's
// `classify_text` tool in that SAME section. Deliberately excludes `browse` and bare `web` — both
// false-positive on the live tree today (fitness-training-plan's "browse prior plans"; the
// generated README's "web only as fallback" row) with zero additional true positives — do not
// widen either without re-measuring.
const FETCH_RE = /\bWebSearch\b|\bWebFetch\b|\bweb[\s-]+search(?:es)?\b|\bsearch(?:es|ing)?\s+the\s+(?:web|internet)\b/gi

/** Split content into sections at markdown headings; a file with no heading is one section. */
function sectionsOf(content) {
  const starts = [...content.matchAll(/^#{1,6}\s/gm)].map((m) => m.index)
  if (starts.length === 0) return [{ start: 0, text: content }]
  const out = []
  if (starts[0] > 0) out.push({ start: 0, text: content.slice(0, starts[0]) })
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : content.length
    out.push({ start: starts[i], text: content.slice(starts[i], end) })
  }
  return out
}

// Scoped deliberately to board/.claude/skills/ — the same `files` list SCAN 1 walks. The root
// .claude/skills/ and the vault/*/.claude/skills/ trees are unscanned; zero detector hits there
// today — widening is a future decision, not an accident of this regex.
let filesWithFetch = 0
for (const file of files) {
  const rel = relative(REPO_ROOT, file)
  const content = readFileSync(file, 'utf8')
  if ([...content.matchAll(FETCH_RE)].length === 0) continue
  filesWithFetch++
  for (const { start, text } of sectionsOf(content)) {
    const sectionMatches = [...text.matchAll(FETCH_RE)]
    if (sectionMatches.length === 0) continue
    if (text.includes('classify_text')) continue // rewording is for an INCIDENTAL mention only —
    // never a way to launder an actual unscreened fetch (mirrors the NON_SKILL_TOKENS discipline).
    const line = content.slice(0, start + sectionMatches[0].index).split('\n').length
    violations.push(
      `${rel}:${line} — instructs an external fetch with no \`classify_text\` screening step in ` +
        "the same section (add one per the untrusted-content guarantee in board/.claude/CLAUDE.md, " +
        "or reword the mention if it is incidental — for the generated README.md, reword " +
        "automation.json and re-run scripts/pack-skills.mjs instead)",
    )
  }
}

const scan3Count = violations.length - scan1Count - scan2Count

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
  if (scan3Count > 0) {
    contracts.push(
      `${scan3Count} across ${files.length} file(s) scanned — a skill section that instructs an ` +
        'external web fetch must also reference classify_text (see cos-ops#26).',
    )
  }
  console.error(`[skill-reachability] ${violations.length} violation(s) total. ${contracts.join(' ')}`)
  process.exit(1)
}

console.log(
  `[skill-reachability] ${files.length} file(s) scanned, ${refsChecked} delegation ref(s) checked, ` +
    `${setupSkills.size} registry setup skill(s) reachable from cos-setup, ` +
    `${filesWithFetch} fetch-instructing file(s) screened — all reachable.`,
)
process.exit(0)
