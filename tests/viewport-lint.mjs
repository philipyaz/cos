// tests/viewport-lint.mjs — board/ chrome must size to the DYNAMIC viewport, not the static one.
// On iOS Safari, `100vh`/`h-screen`/`min-h-screen` resolve to the LARGE viewport (toolbars
// retracted) even while the toolbars are expanded, so a fixed-height shell or drawer leaves a
// 60-110px dead band the document can't scroll to reveal — exactly how cos-ops#9 happened: every
// drawer's Save button sat under the iOS toolbar, unreachable. `dvh` tracks the real visible
// height instead. This gate bans the static units everywhere except ONE declared pre-dvh fallback
// in globals.css (`board/app/globals.css`'s `.h-dvh-fallback`), and asserts that escape hatch can't
// be laundered: exactly one `viewport-lint-allow` marker, living in globals.css, paired with a real
// `100dvh` override.
//
//   node tests/viewport-lint.mjs
//
// Read-only, no deps — tests/skill-reachability.mjs is the house shape for this kind of static,
// node-only invariant checker (walk + IGNORED set + path:line violations + exit code).

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const SCAN_ROOTS = [join(REPO_ROOT, 'board', 'app'), join(REPO_ROOT, 'board', 'components')]
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])
const ALLOWLIST_MARKER = 'viewport-lint-allow'
const ALLOWLIST_HOME = 'board/app/globals.css'

// Junk that must never be scanned — mirrors tests/skill-reachability.mjs's walk.
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules', '__pycache__'])
const isIgnored = (name) => IGNORED.has(name) || name.startsWith('._') || name.endsWith('~')

/** Every .ts/.tsx/.css file, recursively, under the given root. */
function collectFiles(root) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (isIgnored(entry.name)) continue
      const abs = join(d, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) out.push(abs)
    }
  }
  walk(root)
  return out
}

// `h-screen` / `min-h-screen` as a whole Tailwind-class token: non-[\w-] (or string-edge)
// on both sides, so `sm:h-screen` is caught (":" bounds it) but a compound identifier that merely
// CONTAINS the substring glued by a hyphen (e.g. a differently-named fallback utility) is not
// mistaken for the utility class itself. `min-h-screen` is listed first so it wins over the
// shorter alternative when both could start at the same position.
const TOKEN_RE = /(?<![\w-])(min-h-screen|h-screen)(?![\w-])/g

const files = SCAN_ROOTS.flatMap(collectFiles).sort()
const violations = []
const allowlistMarkers = [] // { rel, lineNo }

for (const file of files) {
  const rel = relative(REPO_ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const lineNo = i + 1
    if (line.includes(ALLOWLIST_MARKER)) {
      allowlistMarkers.push({ rel, lineNo })
      return // the declared escape hatch — exempt from the token/100vh checks below
    }
    const tokenMatch = line.match(TOKEN_RE)
    if (tokenMatch) {
      violations.push(`${rel}:${lineNo} — ${tokenMatch[0]}`)
      return
    }
    if (line.includes('100vh')) {
      violations.push(`${rel}:${lineNo} — 100vh`)
    }
  })
}

// The escape hatch cannot be laundered: at most one marker, and only in the one file that pairs
// it with a real `100dvh` override. Zero markers (the pre-fallback tree) asserts nothing here —
// there is no escape hatch to validate yet.
if (allowlistMarkers.length > 0) {
  const [first, ...rest] = allowlistMarkers
  if (first.rel !== ALLOWLIST_HOME) {
    violations.push(`${first.rel}:${first.lineNo} — ${ALLOWLIST_MARKER} marker outside ${ALLOWLIST_HOME}`)
  }
  for (const extra of rest) {
    violations.push(`${extra.rel}:${extra.lineNo} — second ${ALLOWLIST_MARKER} marker (only one is permitted)`)
  }
  const globalsFile = files.find((f) => relative(REPO_ROOT, f) === ALLOWLIST_HOME)
  const globalsHas100dvh = globalsFile && readFileSync(globalsFile, 'utf8').includes('100dvh')
  if (!globalsHas100dvh) {
    violations.push(`${ALLOWLIST_HOME} — ${ALLOWLIST_MARKER} marker present but no 100dvh fallback found`)
  }
}

if (violations.length) {
  console.error('[viewport-lint] mobile-viewport violation(s):')
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    `[viewport-lint] ${violations.length} violation(s) across ${files.length} file(s) scanned. ` +
      'board/app + board/components chrome must size to the dynamic viewport (dvh) — see tests/viewport-lint.mjs.',
  )
  process.exit(1)
}

console.log(
  `[viewport-lint] ${files.length} file(s) scanned — no h-screen/min-h-screen/raw 100vh outside the declared dvh fallback.`,
)
process.exit(0)
