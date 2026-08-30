// scripts/pack-skills.mjs — package every operator skill in board/.claude/skills/ as a .zip that
// Claude Cowork can install directly (Cowork Settings → Capabilities → Skills → Upload skill), AND
// generate the automation catalog spliced into board/.claude/skills/README.md from
// board/.claude/skills/automation.json (the single source for each skill's automation class —
// scheduled / called / on-demand — and suggested cadence).
// Cowork installs a skill from an archive, not from a folder on disk, so the .zip IS the
// distribution format — and a stale .zip silently ships an old procedure. This script makes both
// the bundles AND the README catalog build ARTIFACTs of the source, with a CI sync-check, exactly
// like scripts/gen-mcp-json.mjs and scripts/gen-labels-doc.mjs.
//
//   node scripts/pack-skills.mjs            # (re)write board/.claude/skill-bundles/*.zip + the catalog
//   node scripts/pack-skills.mjs --check    # exit 1 if bundles OR the catalog are missing/stale (CI guard)
//   node scripts/pack-skills.mjs --list     # print the skills + the files each bundle carries
//
// The zips are DETERMINISTIC — entries sorted by path, a fixed 1980-01-01 DOS timestamp, fixed
// permissions, no extra fields, and entries STORED rather than deflated — so rebuilding an
// unchanged skill produces byte-identical output on any machine. That is what lets us commit them:
// the diff moves only when the skill actually changes, and `--check` can compare bytes instead of
// keeping a separate checksum manifest.
//
// WHY STORED, NOT DEFLATED: deflate output is NOT portable. Node bundles its own zlib and switched
// flavors mid-life (zlib-ng in the newer majors), so the same input compresses to different bytes
// on Node 22 vs Node 26 — which made every bundle read as "stale" in CI while being clean locally.
// Storing costs ~2x on disk for Markdown, and it is the better trade anyway: git zlib-compresses
// and deltas blobs itself, which works well on a stored (mostly plain-text) zip and barely at all
// on a deflated one, since already-compressed data is incompressible noise to the packfile.
//
// Layout inside each archive is `<skill-name>/SKILL.md` (+ any references/, scripts/, assets/):
// the skill FOLDER sits at the archive root, which is the shape Claude's skill uploader expects.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const SKILLS_DIR = join(REPO_ROOT, 'board', '.claude', 'skills')
const BUNDLES_DIR = join(REPO_ROOT, 'board', '.claude', 'skill-bundles')

// Junk that must never travel inside a bundle: OS metadata, editor scratch, and any nested
// build output. Matched against the basename of every file and directory walked.
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules', '__pycache__'])
const isIgnored = (name) => IGNORED.has(name) || name.startsWith('._') || name.endsWith('~')

/* ------------------------------------------------------------------ discovery */

/** Every directory under skills/ that actually holds a SKILL.md (README.md et al. are not skills). */
function discoverSkills() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isIgnored(e.name))
    .filter((e) => {
      try {
        return statSync(join(SKILLS_DIR, e.name, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
    .map((e) => e.name)
    .sort()
}

/** Walk a skill folder → sorted list of { path (posix, relative to the skill dir), data }. */
function collectFiles(skillDir) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (isIgnored(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push({ path: relative(skillDir, abs).split(sep).join('/'), data: readFileSync(abs) })
    }
  }
  walk(skillDir)
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/* ------------------------------------------------------------------ zip writer */

// Table-driven CRC-32 (the checksum every zip entry header carries).
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// Fixed DOS timestamp: 1980-01-01 00:00:00, the earliest the format can express. A real mtime
// would make every rebuild a new blob, which defeats committing the bundles.
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000

/**
 * Build a ZIP archive from `entries` ({ path, data }), STORED (method 0 — see the header note on
 * why compression is off), in the given order. Deliberately minimal: no zip64, no data
 * descriptors, no extra fields — these bundles are a handful of small Markdown files, well inside
 * every 32-bit limit.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8')
    const crc = crc32(data)
    const method = 0 // stored — the only portable choice; see the header note
    const body = data

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(10, 4) // version needed (1.0 — stored)
    local.writeUInt16LE(0x0800, 6) // flags: bit 11 = UTF-8 filenames
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(0x030a, 4) // version made by: 3 = unix, 10 = zip 1.0
    central.writeUInt16LE(10, 6) // version needed (1.0 — stored)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attrs: regular file, 0644
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with central dir
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, centralBuf, end])
}

/* ------------------------------------------------------------------ build */

/** The bundle bytes for one skill — its folder, at the archive root. */
function buildBundle(skill) {
  const files = collectFiles(join(SKILLS_DIR, skill))
  if (!files.some((f) => f.path === 'SKILL.md')) {
    throw new Error(`skill "${skill}" has no SKILL.md at its root`)
  }
  return { files, zip: makeZip(files.map((f) => ({ path: `${skill}/${f.path}`, data: f.data }))) }
}

/* ------------------------------------------------------------------ automation catalog */

// board/.claude/skills/automation.json is the single source for each skill's automation class —
// see board/.claude/CLAUDE.md's "Authoring a skill" section. This script owns turning it into the
// generated catalog block spliced into README.md between a marker pair — the same "declarative
// source → generator → --check" discipline as scripts/gen-labels-doc.mjs, except only the block
// BETWEEN the markers is generated; the rest of README.md stays hand-prose.
const AUTOMATION_PATH = join(SKILLS_DIR, 'automation.json')
const README_PATH = join(SKILLS_DIR, 'README.md')
const CATALOG_BEGIN =
  '<!-- BEGIN GENERATED: automation-catalog — the classes/cadences live in automation.json; edit THAT and run node scripts/pack-skills.mjs. Hand-edits inside this block are overwritten. -->'
const CATALOG_END = '<!-- END GENERATED: automation-catalog -->'

const VALID_CLASSES = new Set(['scheduled', 'called', 'on-demand'])
const isBlank = (s) => typeof s !== 'string' || !s.trim()
const hasNewline = (s) => typeof s === 'string' && s.includes('\n')

/**
 * Parse + validate automation.json against the discovered skill set. Every discovered skill must
 * have exactly one entry, and every entry must name a discovered skill (the criterion-1 count
 * equality) — a skill without a declared class is a build failure in EVERY mode, not just --check.
 */
function loadAutomation(skills) {
  let raw
  try {
    raw = readFileSync(AUTOMATION_PATH, 'utf8')
  } catch {
    throw new Error(
      `[pack-skills] ${relative(REPO_ROOT, AUTOMATION_PATH)} is missing. Every skill under ` +
        'board/.claude/skills/ must declare an automation class — see board/.claude/CLAUDE.md.',
    )
  }
  let automation
  try {
    automation = JSON.parse(raw)
  } catch (e) {
    throw new Error(`[pack-skills] ${relative(REPO_ROOT, AUTOMATION_PATH)} is not valid JSON: ${e.message}`)
  }
  if (!automation || typeof automation !== 'object' || Array.isArray(automation)) {
    throw new Error(`[pack-skills] ${relative(REPO_ROOT, AUTOMATION_PATH)} must be a flat JSON object.`)
  }

  const skillSet = new Set(skills)
  const entryNames = Object.keys(automation)
  const unclassified = skills.filter((s) => !entryNames.includes(s))
  const orphans = entryNames.filter((n) => !skillSet.has(n))
  if (unclassified.length || orphans.length) {
    throw new Error(
      '[pack-skills] automation.json is out of sync with board/.claude/skills/.\n' +
        unclassified.map((s) => `  unclassified skill (no entry in automation.json): ${s}\n`).join('') +
        orphans.map((n) => `  orphan entry (no such skill directory):          ${n}\n`).join('') +
        'Every skill must declare exactly one automation class — see board/.claude/CLAUDE.md.',
    )
  }

  for (const [name, entry] of Object.entries(automation)) {
    const errs = []
    if (!VALID_CLASSES.has(entry?.class)) {
      errs.push(`class must be one of "scheduled" | "called" | "on-demand", got ${JSON.stringify(entry?.class)}`)
    }
    if (isBlank(entry?.summary)) errs.push('summary is required and must be a non-empty string')
    else if (hasNewline(entry.summary)) errs.push('summary must not contain a raw newline')

    const hasSchedules = Object.prototype.hasOwnProperty.call(entry ?? {}, 'schedules')
    const hasCalledBy = Object.prototype.hasOwnProperty.call(entry ?? {}, 'calledBy')

    if (entry?.class === 'scheduled') {
      if (hasCalledBy) errs.push('class "scheduled" must not carry "calledBy"')
      if (!Array.isArray(entry.schedules) || entry.schedules.length === 0) {
        errs.push('class "scheduled" requires a non-empty "schedules" array')
      } else {
        entry.schedules.forEach((s, i) => {
          if (isBlank(s?.trigger) || hasNewline(s.trigger)) errs.push(`schedules[${i}].trigger must be a non-empty single-line string`)
          if (isBlank(s?.cadence) || hasNewline(s.cadence)) errs.push(`schedules[${i}].cadence must be a non-empty single-line string`)
          if (s?.does !== undefined && (isBlank(s.does) || hasNewline(s.does))) {
            errs.push(`schedules[${i}].does, if present, must be a non-empty single-line string`)
          }
        })
      }
    } else if (entry?.class === 'called') {
      if (hasSchedules) errs.push('class "called" must not carry "schedules"')
      if (!Array.isArray(entry.calledBy) || entry.calledBy.length === 0) {
        errs.push('class "called" requires a non-empty "calledBy" array')
      } else {
        for (const caller of entry.calledBy) {
          if (typeof caller !== 'string' || !skillSet.has(caller)) {
            errs.push(`calledBy names "${caller}", which is not a discovered skill`)
          }
        }
      }
    } else if (entry?.class === 'on-demand') {
      if (hasSchedules) errs.push('class "on-demand" must not carry "schedules"')
      if (hasCalledBy) errs.push('class "on-demand" must not carry "calledBy"')
    }

    if (errs.length) {
      throw new Error(`[pack-skills] automation.json entry "${name}" is invalid:\n` + errs.map((e) => `  - ${e}\n`).join(''))
    }
  }

  return automation
}

const esc = (s) => String(s).replace(/\|/g, '\\|')
const skillLink = (name) => `**[\`/${name}\`](./${name}/SKILL.md)**`

/** Render the generated catalog block (three sections), in automation.json's own key order. */
function renderCatalog(automation) {
  const entries = Object.entries(automation)
  const scheduled = entries.filter(([, e]) => e.class === 'scheduled')
  const called = entries.filter(([, e]) => e.class === 'called')
  const onDemand = entries.filter(([, e]) => e.class === 'on-demand')

  let out = '## The skills worth scheduling\n\n'
  out +=
    'Paste the trigger into a new Cowork Scheduled Task at the suggested cadence — the cadence is a ' +
    "suggestion, yours to adjust in Cowork; the trigger is what makes the task run the skill's actual procedure.\n\n"
  out += '| Skill | What a scheduled run does | Trigger to paste | Suggested cadence |\n'
  out += '|---|---|---|---|\n'
  for (const [name, entry] of scheduled) {
    for (const s of entry.schedules) {
      out += `| ${skillLink(name)} | ${esc(s.does ?? entry.summary)} | \`${esc(s.trigger)}\` | ${esc(s.cadence)} |\n`
    }
  }

  out += '\n## Called skills — installed, invoked by other skills\n\n'
  out +=
    'Not every skill here is meant to be scheduled on its own — but install its bundle all the same: ' +
    'a delegation to a skill that is not installed is a **silent no-op**, not an error.\n\n'
  for (const [name, entry] of called) {
    const callers = entry.calledBy.map((c) => `\`/${c}\``).join(', ')
    out += `- ${skillLink(name)} — called by ${callers} — ${esc(entry.summary)}\n`
  }

  out += '\n## On demand only — deliberately not on a timer\n\n'
  out +=
    'These respond to a moment — a question asked, a circumstance changed, data handed over — so ' +
    'absence from the table above is a decision, not an omission:\n\n'
  for (const [name, entry] of onDemand) {
    out += `- ${skillLink(name)} — ${esc(entry.summary)}\n`
  }

  return out.trim()
}

/** Splice `block` between the automation-catalog marker pair in `readme` (errors if either marker is absent or duplicated). */
function spliceReadme(readme, block) {
  const beginCount = readme.split(CATALOG_BEGIN).length - 1
  const endCount = readme.split(CATALOG_END).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(
      `[pack-skills] ${relative(REPO_ROOT, README_PATH)} must contain the automation-catalog marker pair ` +
        `exactly once each (found ${beginCount} BEGIN, ${endCount} END).`,
    )
  }
  const beginIdx = readme.indexOf(CATALOG_BEGIN)
  const endIdx = readme.indexOf(CATALOG_END)
  if (endIdx < beginIdx) {
    throw new Error(`[pack-skills] ${relative(REPO_ROOT, README_PATH)} — the END marker appears before BEGIN.`)
  }
  const before = readme.slice(0, beginIdx + CATALOG_BEGIN.length)
  const after = readme.slice(endIdx)
  return `${before}\n\n${block}\n\n${after}`
}

const skills = discoverSkills()
if (skills.length === 0) {
  process.stderr.write(`[pack-skills] no skills found under ${relative(REPO_ROOT, SKILLS_DIR)}\n`)
  process.exit(1)
}

let automation
try {
  automation = loadAutomation(skills)
} catch (err) {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
}

const built = skills.map((skill) => ({ skill, ...buildBundle(skill) }))

if (process.argv.includes('--list')) {
  for (const { skill, files, zip } of built) {
    console.log(`${skill}  (${files.length} file${files.length === 1 ? '' : 's'}, ${zip.length} B)`)
    for (const f of files) console.log(`    ${skill}/${f.path}`)
  }
  process.exit(0)
}

const bundlePath = (skill) => join(BUNDLES_DIR, `${skill}.zip`)
const readIfPresent = (p) => {
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}

// Bundles that exist on disk but no longer correspond to a skill — a rename or a deletion left
// them behind, and an orphan .zip is exactly the stale procedure this script exists to prevent.
const expected = new Set(built.map(({ skill }) => `${skill}.zip`))
let present = []
try {
  present = readdirSync(BUNDLES_DIR).filter((n) => n.endsWith('.zip'))
} catch {
  /* first run — the directory is created below */
}
const orphans = present.filter((n) => !expected.has(n)).sort()

if (process.argv.includes('--check')) {
  const stale = built.filter(({ skill, zip }) => !zip.equals(readIfPresent(bundlePath(skill)) ?? Buffer.alloc(0)))

  let catalogStale = false
  let catalogError = null
  try {
    const readmeCurrent = readFileSync(README_PATH, 'utf8')
    catalogStale = readmeCurrent !== spliceReadme(readmeCurrent, renderCatalog(automation))
  } catch (err) {
    catalogError = err.message
  }

  if (stale.length || orphans.length || catalogStale || catalogError) {
    process.stderr.write(
      '[pack-skills] skill bundles / catalog are OUT OF SYNC with board/.claude/skills/.\n' +
        stale.map(({ skill }) => `  stale/missing: ${skill}.zip\n`).join('') +
        orphans.map((n) => `  orphaned:      ${n}\n`).join('') +
        (catalogError ? `  ${catalogError}\n` : catalogStale ? '  catalog stale — run node scripts/pack-skills.mjs and commit\n' : '') +
        'Run `node scripts/pack-skills.mjs` and commit the result.\n',
    )
    process.exit(1)
  }
  console.log(`[pack-skills] ${built.length} bundles + the skills catalog up to date.`)
  process.exit(0)
}

mkdirSync(BUNDLES_DIR, { recursive: true })
let written = 0
for (const { skill, zip } of built) {
  const target = bundlePath(skill)
  if (zip.equals(readIfPresent(target) ?? Buffer.alloc(0))) continue
  writeFileSync(target, zip)
  written++
  console.log(`  wrote  board/.claude/skill-bundles/${skill}.zip`)
}
for (const name of orphans) {
  rmSync(join(BUNDLES_DIR, name))
  console.log(`  removed board/.claude/skill-bundles/${name}  (no matching skill)`)
}

let readmeCurrent, readmeNext
try {
  readmeCurrent = readFileSync(README_PATH, 'utf8')
  readmeNext = spliceReadme(readmeCurrent, renderCatalog(automation))
} catch (err) {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
}
if (readmeNext !== readmeCurrent) {
  writeFileSync(README_PATH, readmeNext)
  console.log('  wrote  board/.claude/skills/README.md  (automation catalog)')
}

console.log(
  `[pack-skills] ${built.length} skills — ${written} bundle${written === 1 ? '' : 's'} written, ` +
    `${built.length - written} unchanged${orphans.length ? `, ${orphans.length} orphan removed` : ''}.`,
)
