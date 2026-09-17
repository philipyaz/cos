// tests/skill-reachability.mjs — this file owns SIX reachability contracts, in both directions:
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
// SCAN 4 (upload -> receipt, cos-ops#74): a root setup-skill SECTION that instructs a Cowork
// bundle upload must, in that SAME section, instruct writing the per-machine upload receipt
// (scripts/mark-skill-uploaded.mjs) — the receipt is what makes upgrade-check's exact-drift branch
// (scripts/upgrade-check.mjs item 10) reachable; without it every upgrade falls back to a
// git-range guess. That is exactly how cos-ops#74 happened: the receipt shipped (cos#115) and the
// two paths that DO the uploading (cos-setup Step 5, setup-vault) never mentioned it, so it never
// existed on the only machine in the fleet. Scoped like SCAN 3 (per section, whole-string), but
// walks the ROOT .claude/skills/ tree, not board/.claude/skills/ — and that tree splits
// differently: sectionsOf()'s heading regex also matches line-start `#` shell comments inside
// fenced code blocks, which 13 of 16 root skills contain (zero board skills do), so a "section"
// here can be a fenced-comment-delimited slice rather than a markdown heading's. This is SCAN 2's
// family (a setup orchestrator must reference a named thing), not an ADR 0030 *-consumers gate:
// no board field or MCP tool is asserted, and cos-setup/setup-vault are root-tree, Claude
// Code-only setup skills that are never bundled (ADR 0015) — clause 1's "this file owns
// delegation-target existence" premise stopped being a single-subject truth the moment SCAN 3
// (itself a prose-pairing check) landed, one scan before this one.
//
// SCAN 5 (tracked-template doctrine, cos-ops#78): vault/example-vault/ is the repo's ONLY tracked
// copy of the second-brain-* skills and the CLAUDE.md that governs them — every live
// vault/<name>/ is produced from it once by setup-vault's `cp -R` (SKILL.md:62) and never synced
// back in either direction. The template's own banner used to instruct "Do not edit here", so the
// tracked copy sat frozen while the live copy accreted doctrine: 126 net lines of drift across 3 of
// its 4 files, silent for 40 days — one un-ported authoring event, not ongoing divergence (ADR 0013
// recorded this exact drift in its Consequences and named its own revisit trigger: "the
// pinned-phrase set outgrows a handful and needs a real structured check"). SCAN 5 is that check.
// It pins doctrine phrases in the TRACKED template only — deliberately never a live
// vault/<name>/ tree, which would stand permanently red over user data this repo cannot repair
// (the ADR 0014 discount-the-reds hazard) — so a whole-file `includes()` per pin is enough;
// sectionsOf()'s heading/fenced-comment splitter is deliberately unused, since nothing here needs
// pairing. It also asserts an RFC 2606 email allowlist (every email-shaped string under the
// template must end @example.com / @example.org) and a personal-path ban, because the ported
// doctrine is authored prose, not a mechanical copy, and a privacy scrub is exactly the kind of
// check a human read alone cannot be trusted to hold. This is NOT an ADR 0030 *-consumers gate: no
// board field or MCP tool is asserted, and the vault tree is never bundled (ADR 0015 is the
// decision that created step [2b], this scan's home). SCAN 5's sibling is gate `3c` in
// tests/run.sh (run.sh:742-800): `3c` pins three guardrail phrases into EVERY vault, over the
// sandbox copy, so it already covers second-brain-query live and template alike; SCAN 5 covers the
// other two skills plus CLAUDE.md, but only in the tracked template — the per-vault producer-phrase
// check and the tracked-template doctrine check are deliberately two different mechanisms with two
// different failure tokens, not one gate stretched thin. Cost, named rather than silently
// accumulated (plan #74's precedent): five heterogeneous contracts now share one [2b]
// `fail_reasons` token (the ADR 0020 trade-off), mitigated by the per-scan `contracts.push` prefix
// below. Bound: this pins a SNAPSHOT, so it catches regression of the ported doctrine, not
// recurrence of the founding incident — a future live-first authoring event that adds NEW doctrine
// stays invisible here until it, too, is ported by hand.
//
// SCAN 6 ($REPO_ROOT path existence, cos-ops#114): a root setup skill that names a path via
// $REPO_ROOT/ or ${REPO_ROOT}/ must point at something that still exists — tracked in the git
// index, or deliberately gitignored. That is exactly how cos-ops#114 happened:
// backup-recovery/SKILL.md's §6 step 3 rendered the backup LaunchAgent by sed-ing
// backup/deploy/com.chiefofstaff.backup.plist.template, a file deleted 2026-07-14 in 1d1f97e —
// the SAME commit that rewrote §1.4 in the same file to the generator and missed this call site.
// The step has no `set -e`, so following it truncates the installed plist to 0 bytes (the shell
// opens the `>` target before sed fails), `launchctl bootout` then unloads the running agent, and
// `bootstrap` is handed the empty file — the daily 03:30 backup silently disabled, surfacing only
// as an `agent-installed: warn` on /backups. 64 days undetected, because the failure is silent by
// construction (ADR 0015's Why, the decision that created [2b]) and CI never runs a runbook; SCAN
// 2 and SCAN 4 are this scan's earlier root-skill members of that same family.
//
// The $REPO_ROOT/ anchor is kept, not because it marks every executable reference (it doesn't),
// but because it marks the ones whose meaning is independent of the shell's working directory. A
// bare relative path (`node backup/restore.mjs`) depends on cwd, so scanning those would fail a
// correct tree whose block `cd`s first (ADR 0038). Measured 2026-09-17 at c0db969: 52 lines
// across 11 root skills (11 of them in backup-recovery itself) name a script by a bare
// repo-relative path after node/sh/bash — this scan deliberately reads NONE of them (matcher: any
// line containing node/sh/bash followed by a slash-containing relative path that is not itself
// $-anchored); re-measure this count at any future revisit, since the corpus moves.
//
// Resolution is against the git INDEX, not the disk, plus one `git check-ignore --no-index` spawn
// for whatever the index misses — so the hub (which carries untracked residue, e.g. a stray
// tests/lib/) and a fresh CI checkout give the same verdict (the ops#87 -> cos#155 precedent for
// [1]). Every unresolved token is queried BOTH bare and with a trailing slash appended: a
// directory-only gitignore pattern (`mcp/logs/`) matches a query only when git can confirm the
// path IS a directory, which it cannot for a path that does not currently exist on disk — caught
// live on this PR's own CI run, which failed on `mcp/logs` and `backup/logs` (bare) precisely
// because a fresh checkout has neither directory yet (both are gitignored-only, no tracked file
// inside either, so a first clone lacks them entirely) even though this hub's own long-lived copy
// resolved them fine. Asserting the slash ourselves makes resolution independent of whether some
// process happened to create the directory here before. Measured the same session: of 134
// $REPO_ROOT/ tokens checked, 106 resolve via the index and 28 via gitignore (14 unique ignored
// tokens — config/cos.env, mcp/logs/…, board/data/cases.json, …), all 14 matching the COMMITTED
// root .gitignore (this hub's core.excludesFile is unset; .git/info/exclude holds only
// .context/). State this as a BOUND, not an equivalence: check-ignore also consults those two
// machine-local files, so hub/CI agreement on THAT axis is measured, not structural — a token
// ignored only by a machine-local exclude would diverge hub-green/CI-red, never silently the
// other way. Never parse .gitignore in JS — execute git's own grammar instead (ADR 0040). When
// git cannot list the index (not a checkout), the scan says so and never claims the contract held
// (ADR 0036 obligation 3; ADR 0029 is the ADR that picks
// this branch over the host one). This is NOT an ADR 0030 *-consumers gate — it asserts path
// existence, not a board field or MCP tool — which is why [2b] governs, the same disambiguation
// SCAN 4 and SCAN 5 state for themselves.
//
// This file's own source carries $REPO_ROOT/ literals in comments and violation messages, but the
// corpus below is .claude/skills/*/SKILL.md by construction, so there is no exclusion list to go
// vacuous (unlike SCAN 1's NON_SKILL_TOKENS).
//
//   node tests/skill-reachability.mjs
//
// Scans the checked-in tree directly (board-lint.mjs is the precedent for a static invariant
// checker living in tests/; this is a fourth, disjoint gate: pack-skills --check owns bundle
// FRESHNESS + catalog SYNC, this file owns six narrower contracts instead — delegation
// reachability, registry reachability, fetch screening, upload receipting, (as of SCAN 5) the
// tracked vault template's doctrine + privacy, and (as of SCAN 6) setup-skill $REPO_ROOT/
// path-reference existence against the git index/ignore state — not the single EXISTENCE claim
// this sentence used to make). Still no npm deps and still writes nothing; SCAN 6 is the first to
// spawn git (`ls-files`, `check-ignore --no-index`), both read-only, to answer that last contract.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// Scoped deliberately to board/.claude/skills/ — the same `files` list SCAN 1 walks. This fetch
// detector does not walk the root `.claude/skills/` tree (SCAN 4 walks that tree for a different
// contract) or any `vault/*/.claude/skills/` tree; zero fetch-detector hits there today — widening
// THIS detector is a future decision, not an accident of the regex. SCAN 5 separately pins the
// TRACKED vault/example-vault/ template's doctrine; a live vault/<name>/ tree stays unscanned by
// every scan in this file (gate `3c` in tests/run.sh is its per-vault complement).
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

// SCAN 4 (upload -> receipt, cos-ops#74): a root setup-skill SECTION that instructs a Cowork
// bundle upload must, in that SAME section, instruct writing the per-machine upload receipt
// (scripts/mark-skill-uploaded.mjs) — the receipt is what makes upgrade-check's exact-drift branch
// (scripts/upgrade-check.mjs item 10) reachable; without it every upgrade falls back to the
// git-range guess. That is exactly how cos-ops#74 happened: the receipt shipped (cos#115) and the
// two paths that DO the uploading (cos-setup Step 5, setup-vault) never mentioned it, so it never
// existed on the only machine in the fleet. Section-scoped and whole-string-matched like SCAN 3.
// This is SCAN 2's family — a setup orchestrator must reference a named step — NOT an ADR 0030
// *-consumers gate: no board field or MCP tool is asserted, and these are root-tree Claude
// Code-only setup skills that are never bundled (ADR 0015), so ADR 0030 clause 1 does not govern
// the home. NOTE the tree difference: sectionsOf() splits on every line-start `#{1,6} ` including
// shell comments inside fenced code blocks, and 13 of 16 root skills carry such lines (zero board
// skills do) — so a "section" here can be a fenced-comment-delimited slice, not a markdown
// heading's. Every miss direction is loud for the two floored files below; keep added receipt
// lines free of line-start `#` comments so they stay in the upload's slice.
const RECEIPT_TOKEN = 'mark-skill-uploaded' // a script identifier: matched case-sensitively, exact
const RECEIPT_FLOOR_SKILLS = ['cos-setup', 'setup-vault'] // cos-ops#74's two upload paths: each MUST stay visible to the detector
let uploadSectionsChecked = 0
const uploadSectionsBySkill = new Map()
const rootSkillDocs = [] // SCAN 6 reuses this walk — every root skill's { rel, content }, no second readdir
for (const entry of readdirSync(ROOT_SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || isIgnored(entry.name)) continue
  const abs = join(ROOT_SKILLS_DIR, entry.name, 'SKILL.md')
  let content
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    continue // a directory without SKILL.md is not a skill
  }
  const rel = relative(REPO_ROOT, abs)
  rootSkillDocs.push({ rel, content })
  let detected = 0
  for (const { start, text } of sectionsOf(content)) {
    // Conjunctive detector: an upload verb AND the bundle directory's literal path token in one
    // section. Measured 2026-09-05 over all 16 root skills: exactly 3 detecting sections, one
    // each in cos-setup (Step 5), setup-vault (the :113-166 slice holding the upload paragraphs)
    // and cos-upgrade (whose Step 5 residue bullet already pairs the token) — zero elsewhere.
    const uploadMatches = [...text.matchAll(/upload/gi)]
    if (uploadMatches.length === 0 || !text.includes('skill-bundles')) continue
    detected++
    uploadSectionsChecked++
    if (!text.includes(RECEIPT_TOKEN)) {
      const line = content.slice(0, start + uploadMatches[0].index).split('\n').length
      violations.push(
        `${rel}:${line} — this section instructs a Cowork bundle upload but never writes the ` +
          'per-machine upload receipt: add `node scripts/mark-skill-uploaded.mjs …` right after ' +
          'the upload (cos-ops#74; scripts/upgrade-check.mjs item 10 reads it). If the upload ' +
          'mention here became incidental, reword it — never a place to launder an actual ' +
          'unreceipted upload path.',
      )
    }
  }
  uploadSectionsBySkill.set(entry.name, detected)
}
for (const name of RECEIPT_FLOOR_SKILLS) {
  if (!(uploadSectionsBySkill.get(name) > 0)) {
    violations.push(
      `.claude/skills/${name}/SKILL.md — SCAN 4 found no section matching its upload detector ` +
        '(/upload/i plus the literal "skill-bundles"): the upload procedure moved or was ' +
        'reworded, so this scan can no longer see a path cos-ops#74 receipted — re-anchor the ' +
        'detector or RECEIPT_FLOOR_SKILLS deliberately.',
    )
  }
}
const scan4Count = violations.length - scan1Count - scan2Count - scan3Count

// SCAN 5 (tracked-template doctrine, cos-ops#78): vault/example-vault/ is the repo's only tracked
// copy of the second-brain-* skills and the CLAUDE.md that governs them (see the file header for
// why this scan exists and why it is scoped to the TRACKED template, never a live vault/<name>/).
const TEMPLATE_VAULT = join(REPO_ROOT, 'vault', 'example-vault')

/** Every regular file, recursively — unlike collectMarkdownFiles, not `.md`-only (the privacy scan
 * below must also see aliases.md, index.md, log.md, not just skills and CLAUDE.md). */
function collectAllFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (isIgnored(entry.name)) continue
      const abs = join(d, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  walk(dir)
  return out.sort()
}

// Doctrine pins — every span below is single-line in the ported text, byte-exact from the live
// wording (em-dashes are U+2014; the lint apostrophe is the straight ASCII '), and contains no
// `*`/backtick/`**` inside the span itself. A missing FILE is its own violation, never a silent
// skip (mirrors RECEIPT_FLOOR_SKILLS's floor discipline above).
const DOCTRINE_PINS = {
  'CLAUDE.md': [
    'source of record',
    'selective, not exhaustive',
    'Critical intake — information vs. bloat',
    'ceiling that flags an unusually rich source, never a target to hit',
    'Reinforce before you spawn',
  ],
  '.claude/skills/second-brain-ingest/SKILL.md': [
    'Triage — information vs. bloat',
    'relational facts are never NOTHING',
    'handed to ingest always counts as at least ONE LINE',
    'Reinforce before you spawn',
  ],
  '.claude/skills/second-brain-lint/SKILL.md': [
    'Auto-fix policy — repair the safe, propose the rest',
    "flag it, don't guess",
    'Bloat & fragmentation',
  ],
}

let doctrinePinsHeld = 0
for (const [rel, pins] of Object.entries(DOCTRINE_PINS)) {
  const abs = join(TEMPLATE_VAULT, rel)
  let content
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    violations.push(
      `vault/example-vault/${rel} does not exist — SCAN 5 cannot check its doctrine pins (cos-ops#78)`,
    )
    continue
  }
  for (const pin of pins) {
    if (content.includes(pin)) {
      doctrinePinsHeld++
    } else {
      violations.push(
        `vault/example-vault/${rel} — missing doctrine pin: "${pin}" (the tracked template must ` +
          'carry the ported doctrine verbatim; see cos-ops#78)',
      )
    }
  }
}

// Banner inversion, both directions (CLAUDE.md only): the old "Do not edit here" instruction must
// be GONE, not merely joined by the new banner — a doctrine pin alone can't catch a half-inverted
// banner that kept both sentences.
{
  const rel = 'CLAUDE.md'
  try {
    const content = readFileSync(join(TEMPLATE_VAULT, rel), 'utf8')
    if (content.includes('Do not edit here')) {
      violations.push(
        `vault/example-vault/${rel} — still instructs "Do not edit here"; the banner must be ` +
          'inverted so the template is the source of record (cos-ops#78)',
      )
    }
  } catch {
    // already reported as a missing-file violation above
  }
}

// allowed-tools exact line (lint only) — a full-line match, not a substring, so a partial widening
// (e.g. adding only `Write`) can't pass.
{
  const rel = '.claude/skills/second-brain-lint/SKILL.md'
  try {
    const content = readFileSync(join(TEMPLATE_VAULT, rel), 'utf8')
    if (!/^allowed-tools: Read Glob Grep Edit Write$/m.test(content)) {
      violations.push(
        `vault/example-vault/${rel} — front matter must read exactly ` +
          '"allowed-tools: Read Glob Grep Edit Write" (cos-ops#78)',
      )
    }
  } catch {
    // already reported as a missing-file violation above
  }
}

// Email allowlist (RFC 2606) + personal-path ban, over EVERY regular file under the template —
// correction 1 from cos-ops#78's review: an allowlist, not a denylist, so it does not depend on
// anyone enumerating personal referents correctly.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PERSONAL_PATH_RE = /\/Users\/|\/home\/|~\//g
const templateFiles = collectAllFiles(TEMPLATE_VAULT)
const templateMdFiles = templateFiles.filter((f) => f.endsWith('.md'))
let emailsChecked = 0
for (const file of templateFiles) {
  const rel = relative(REPO_ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const match of line.matchAll(EMAIL_RE)) {
      emailsChecked++
      const email = match[0]
      if (!(email.endsWith('@example.com') || email.endsWith('@example.org'))) {
        violations.push(
          `${rel}:${i + 1} — email-shaped string "${email}" is not @example.com / @example.org ` +
            '(RFC 2606 reserved-for-documentation; cos-ops#78)',
        )
      }
    }
    for (const match of line.matchAll(PERSONAL_PATH_RE)) {
      violations.push(
        `${rel}:${i + 1} — personal-path token "${match[0]}" under the tracked template (cos-ops#78)`,
      )
    }
  })
}

// Floors (the vacuous-pass discipline, mirroring RECEIPT_FLOOR_SKILLS): either one breaking means
// the walk or a detector lost its input, not that the template is clean — say so, don't pass quietly.
if (templateMdFiles.length < 9) {
  violations.push(
    `vault/example-vault/ — only ${templateMdFiles.length} markdown file(s) found; SCAN 5's walk ` +
      'may have lost its input — re-anchor deliberately (cos-ops#78)',
  )
}
if (emailsChecked < 1) {
  violations.push(
    'vault/example-vault/ — zero email-shaped strings found tree-wide; the allowlist detector may ' +
      'have lost its input — re-anchor deliberately (cos-ops#78)',
  )
}

const scan5Count = violations.length - scan1Count - scan2Count - scan3Count - scan4Count

// SCAN 6 ($REPO_ROOT path existence, cos-ops#114): see the file header for the founding incident
// and the anchor rationale. Walks rootSkillDocs (SCAN 4's own readdir, no second walk).
const REPO_ROOT_NEEDLES = ['$REPO_ROOT/', '${REPO_ROOT}/']

/** Every $REPO_ROOT/ or ${REPO_ROOT}/ token on a line, as the maximal run of [A-Za-z0-9._/-]
 * after the needle, trailing sentence punctuation stripped. Skipped (a placeholder continuation,
 * never a violation) when the run is empty or the next character is $, <, { or *. */
function repoRootTokensOn(line) {
  const out = []
  for (const needle of REPO_ROOT_NEEDLES) {
    let from = 0
    let idx
    while ((idx = line.indexOf(needle, from)) !== -1) {
      const rest = line.slice(idx + needle.length)
      from = idx + needle.length
      const run = (rest.match(/^[A-Za-z0-9._/-]*/) || [''])[0]
      const nextChar = rest[run.length]
      if (run === '' || nextChar === '$' || nextChar === '<' || nextChar === '{' || nextChar === '*') {
        continue
      }
      out.push(run.replace(/[/.,]+$/, ''))
    }
  }
  return out
}

const repoRootOccurrences = [] // { rel, line, tok }, one entry per occurrence (a token named twice counts twice, like SCAN 1)
for (const { rel, content } of rootSkillDocs) {
  content.split('\n').forEach((line, i) => {
    for (const tok of repoRootTokensOn(line)) {
      repoRootOccurrences.push({ rel, line: i + 1, tok })
    }
  })
}

let scan6Ran = true
let repoRootRefsChecked = 0

// Two git spawns total, both read-only: `ls-files -z` for the index, then ONE `check-ignore`
// call (skipped entirely when nothing is left unresolved) for the rest. Never parse .gitignore in
// JS — execute git's own grammar instead (ADR 0040).
const lsFiles = spawnSync('git', ['ls-files', '-z'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const indexEntries = lsFiles.status === 0 ? lsFiles.stdout.split('\0').filter(Boolean) : []
const indexSet = new Set(indexEntries)

// Identity guard: if the index git found doesn't even contain this file, it isn't this repo's
// index (a degit'd/foreign ancestor) — treat exactly like any other did-not-run cause.
if (lsFiles.status !== 0 || !indexSet.has('tests/skill-reachability.mjs')) {
  scan6Ran = false
} else {
  // Resolved = an exact index hit, or some index entry starts with "tok/" (a tracked DIRECTORY,
  // e.g. `backup`, resolves this way).
  const resolvedByIndex = (tok) => indexSet.has(tok) || indexEntries.some((e) => e.startsWith(tok + '/'))
  const unresolved = repoRootOccurrences.filter((o) => !resolvedByIndex(o.tok))
  const uniqueUnresolvedToks = [...new Set(unresolved.map((o) => o.tok))]

  let ignoredSet = new Set()
  let checkIgnoreOk = true
  if (uniqueUnresolvedToks.length > 0) {
    // Query both the bare token and a trailing-slash-asserted form: a directory-only gitignore
    // pattern (e.g. `mcp/logs/`) matches a query only when git can confirm the path IS a
    // directory, which it cannot for a bare path that does not currently exist on disk — a
    // fresh checkout with no mcp/logs/ or backup/logs/ yet (neither dir holds a tracked file,
    // so a first clone lacks them entirely). Asserting the slash ourselves makes resolution
    // independent of whether some process has happened to create the directory here before.
    const queries = uniqueUnresolvedToks.flatMap((tok) => [tok, `${tok}/`])
    const checkIgnore = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: queries.join('\n'),
      maxBuffer: 16 * 1024 * 1024,
    })
    // Exit 0 ("some paths ignored") and 1 ("none ignored") are both valid outcomes; only >= 2 or a
    // spawn error means git couldn't answer.
    if (checkIgnore.status === 0 || checkIgnore.status === 1) {
      ignoredSet = new Set(checkIgnore.stdout.split('\n').filter(Boolean))
    } else {
      checkIgnoreOk = false
    }
  }
  const isGitignored = (tok) => ignoredSet.has(tok) || ignoredSet.has(`${tok}/`)

  if (!checkIgnoreOk) {
    scan6Ran = false
  } else {
    repoRootRefsChecked = repoRootOccurrences.length
    for (const o of repoRootOccurrences) {
      if (!resolvedByIndex(o.tok) && !isGitignored(o.tok)) {
        violations.push(
          `${o.rel}:${o.line} — \`$REPO_ROOT/${o.tok}\` names a path that is neither tracked nor ` +
            'gitignored — the file moved or was deleted after this instruction was written (cos-ops#114)',
        )
      }
    }
    // Floor (the SCAN 5 vacuous-pass discipline): only meaningful once the scan actually ran —
    // a git failure above already reports itself via the did-not-run branch below.
    if (repoRootOccurrences.length === 0) {
      violations.push(
        'SCAN 6 found zero $REPO_ROOT/ tokens across all root setup skills — the detector may ' +
          'have lost its input; re-anchor deliberately (cos-ops#114)',
      )
    }
  }
}

// Did-not-run (ADR 0036 obligation 3 + ADR 0029's subject branch): one distinct note, zero
// violations, and the process still exits 0 when SCANs 1-5 are green — printed here so it
// surfaces in BOTH the pass and fail paths, never folded into the violations report below.
if (!scan6Ran) {
  console.error(
    '[skill-reachability] note: SCAN 6 did not run — git cannot resolve the $REPO_ROOT path ' +
      'index/ignore state here; $REPO_ROOT path token(s) UNCHECKED.',
  )
}

const scan6Count =
  violations.length - scan1Count - scan2Count - scan3Count - scan4Count - scan5Count

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
  if (scan4Count > 0) {
    contracts.push(
      `${scan4Count} across ${uploadSectionsBySkill.size} root setup skill(s) scanned — a section ` +
        'that instructs a Cowork bundle upload must also write the machine\'s upload receipt ' +
        '(see cos-ops#74).',
    )
  }
  if (scan5Count > 0) {
    contracts.push(
      `${scan5Count} across the vault/example-vault template — the tracked template is the source ` +
        'of record for vault doctrine and the second-brain-* skills; pins + RFC 2606 email ' +
        'allowlist + personal-path ban (see cos-ops#78).',
    )
  }
  if (scan6Count > 0) {
    contracts.push(
      `${scan6Count} across ${rootSkillDocs.length} root setup skill(s) — every $REPO_ROOT/<path> ` +
        'token must resolve to a tracked or gitignored path (see cos-ops#114).',
    )
  }
  console.error(`[skill-reachability] ${violations.length} violation(s) total. ${contracts.join(' ')}`)
  process.exit(1)
}

console.log(
  `[skill-reachability] ${files.length} file(s) scanned, ${refsChecked} delegation ref(s) checked, ` +
    `${setupSkills.size} registry setup skill(s) reachable from cos-setup, ` +
    `${filesWithFetch} fetch-instructing file(s) screened, ` +
    `${uploadSectionsChecked} upload section(s) receipted, ` +
    `${templateMdFiles.length} template file(s) privacy-clean, ${doctrinePinsHeld} doctrine ` +
    `pin(s) held, ${scan6Ran ? `${repoRootRefsChecked} $REPO_ROOT path token(s) resolved` : '$REPO_ROOT path tokens UNCHECKED (no git index)'} ` +
    '— all reachable.',
)
process.exit(0)
