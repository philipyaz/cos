// scripts/pack-skills.mjs — package every operator skill in board/.claude/skills/ as a .zip that
// Claude Cowork can install directly (Cowork Settings → Capabilities → Skills → Upload skill).
// Cowork installs a skill from an archive, not from a folder on disk, so the .zip IS the
// distribution format — and a stale .zip silently ships an old procedure. This script makes the
// bundles a build ARTIFACT of the source skill folders, with a CI sync-check, exactly like
// scripts/gen-mcp-json.mjs and scripts/gen-labels-doc.mjs.
//
//   node scripts/pack-skills.mjs            # (re)write board/.claude/skill-bundles/*.zip
//   node scripts/pack-skills.mjs --check    # exit 1 if any bundle is missing/stale (CI guard)
//   node scripts/pack-skills.mjs --list     # print the skills + the files each bundle carries
//
// The zips are DETERMINISTIC — entries sorted by path, a fixed 1980-01-01 DOS timestamp, fixed
// permissions, no extra fields — so rebuilding an unchanged skill produces byte-identical output.
// That is what lets us commit them: the diff moves only when the skill actually changes, and
// `--check` can compare bytes instead of keeping a separate checksum manifest.
//
// Layout inside each archive is `<skill-name>/SKILL.md` (+ any references/, scripts/, assets/):
// the skill FOLDER sits at the archive root, which is the shape Claude's skill uploader expects.

import { deflateRawSync } from 'node:zlib'
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
 * Build a ZIP archive from `entries` ({ path, data }), deflate-compressed, in the given order.
 * Deliberately minimal: no zip64, no data descriptors, no extra fields — these bundles are a
 * handful of small Markdown files, well inside every 32-bit limit.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8')
    const crc = crc32(data)
    // Store rather than deflate when compression doesn't pay (tiny or incompressible files),
    // so a bundle is never larger than its contents.
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const method = stored ? 0 : 8
    const body = stored ? data : deflated

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed (2.0 — deflate)
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
    central.writeUInt16LE(0x0314, 4) // version made by: 3 = unix, 20 = zip 2.0
    central.writeUInt16LE(20, 6)
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

const skills = discoverSkills()
if (skills.length === 0) {
  process.stderr.write(`[pack-skills] no skills found under ${relative(REPO_ROOT, SKILLS_DIR)}\n`)
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
  if (stale.length || orphans.length) {
    process.stderr.write(
      '[pack-skills] skill bundles are OUT OF SYNC with board/.claude/skills/.\n' +
        stale.map(({ skill }) => `  stale/missing: ${skill}.zip\n`).join('') +
        orphans.map((n) => `  orphaned:      ${n}\n`).join('') +
        'Run `node scripts/pack-skills.mjs` and commit the result.\n',
    )
    process.exit(1)
  }
  console.log(`[pack-skills] ${built.length} bundles up to date.`)
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
console.log(
  `[pack-skills] ${built.length} skills — ${written} bundle${written === 1 ? '' : 's'} written, ` +
    `${built.length - written} unchanged${orphans.length ? `, ${orphans.length} orphan removed` : ''}.`,
)
