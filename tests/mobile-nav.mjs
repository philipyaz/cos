// tests/mobile-nav.mjs — every href in the shared nav model (board/lib/nav.ts) must be reachable
// from a below-`md` navigation surface, and the sidebar must scroll its own overflow. Cos had NO
// navigation on a phone at all — portrait: hidden; landscape: unscrollable, ~15 of 26 rows clipped
// — so every nutrition/body/fitness page was phone-unreachable (cos-ops#10). This gate makes that
// recur-proof: a nav entry that isn't wired into the shared model, or a below-md surface that stops
// referencing it, fails the build.
//
//   node tests/mobile-nav.mjs
//
// Read-only, no deps — tests/skill-reachability.mjs / tests/viewport-lint.mjs are the house shape
// for this kind of static, node-only invariant checker (read + path:line violations + exit code).

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const NAV_MODEL = join(REPO_ROOT, 'board', 'lib', 'nav.ts')
const SIDEBAR = join(REPO_ROOT, 'board', 'components', 'sidebar.tsx')
const MOBILE_NAV = join(REPO_ROOT, 'board', 'components', 'mobile-nav.tsx')
const LAYOUT = join(REPO_ROOT, 'board', 'app', 'layout.tsx')
const ADDONS_FILE = join(REPO_ROOT, 'board', 'lib', 'addons.ts')
const NAV_ICONS_FILE = join(REPO_ROOT, 'board', 'components', 'nav-icons.tsx')

const rel = (p) => relative(REPO_ROOT, p)
const violations = []

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Every `href: "..."` literal inside one `export const NAME = [ ... ];` array in `src`. */
function arrayHrefs(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start === -1) return null
  const end = src.indexOf('];', start)
  const slice = end === -1 ? src.slice(start) : src.slice(start, end)
  return [...slice.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1])
}

/** Every plain string literal inside one `export const NAME = [ ... ];` array in `src`. */
function stringArrayLiterals(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start === -1) return null
  const end = src.indexOf('];', start)
  const slice = end === -1 ? src.slice(start) : src.slice(start, end)
  return [...slice.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/** Every `IconXxx` identifier inside one `const NAME = { ... }` object literal in `src`. */
function objectIconKeys(src, name) {
  const start = src.indexOf(`const ${name} = {`)
  if (start === -1) return null
  const end = src.indexOf('}', start)
  const slice = end === -1 ? src.slice(start) : src.slice(start, end)
  return [...slice.matchAll(/\b(Icon\w+)\b/g)].map((m) => m[1])
}

const navSrc = readOrNull(NAV_MODEL)
const sidebarSrc = readOrNull(SIDEBAR)
const mobileNavSrc = readOrNull(MOBILE_NAV)
const layoutSrc = readOrNull(LAYOUT)

// --- 1. the shared nav model exists and carries at least the 11 core routes + /addons -----------
let dailyHrefs = []
let systemHrefs = []
let addonsHref = null
let modelHrefs = new Set()

if (navSrc === null) {
  violations.push(
    `${rel(NAV_MODEL)} — file does not exist (no shared nav model — zero nav hrefs are phone-reachable)`,
  )
} else {
  dailyHrefs = arrayHrefs(navSrc, 'DAILY_NAV') ?? []
  systemHrefs = arrayHrefs(navSrc, 'SYSTEM_NAV') ?? []
  const addonsMatch = navSrc.match(/ADDONS_HREF\s*=\s*"([^"]+)"/)
  addonsHref = addonsMatch ? addonsMatch[1] : null
  modelHrefs = new Set([...dailyHrefs, ...systemHrefs, ...(addonsHref ? [addonsHref] : [])])

  if (dailyHrefs.length === 0) violations.push(`${rel(NAV_MODEL)} — DAILY_NAV is missing or empty`)
  if (systemHrefs.length === 0) violations.push(`${rel(NAV_MODEL)} — SYSTEM_NAV is missing or empty`)
  if (!addonsHref) violations.push(`${rel(NAV_MODEL)} — no ADDONS_HREF literal found`)
  if (modelHrefs.size < 12) {
    violations.push(
      `${rel(NAV_MODEL)} — only ${modelHrefs.size} distinct href(s) found (expected at least 11 core routes + /addons)`,
    )
  }
}

// --- 2. the sidebar consumes the shared model and scrolls its own overflow ----------------------
if (sidebarSrc === null) {
  violations.push(`${rel(SIDEBAR)} — file does not exist`)
} else {
  if (!sidebarSrc.includes('@/lib/nav')) {
    violations.push(`${rel(SIDEBAR)} — does not import @/lib/nav (the shared nav model)`)
  }
  if (!sidebarSrc.includes('overflow-y-auto') || !sidebarSrc.includes('min-h-0')) {
    violations.push(`${rel(SIDEBAR)} — missing the scroll-container pair (overflow-y-auto + min-h-0)`)
  }
}

// --- 3. mobile-nav.tsx is the below-md surface and carries everything it must -------------------
if (mobileNavSrc === null) {
  violations.push(`${rel(MOBILE_NAV)} — file does not exist (no below-md navigation surface)`)
} else {
  const required = [
    ['@/lib/nav', 'does not import @/lib/nav (the shared nav model)'],
    ['md:hidden', 'not hidden at md+ (missing md:hidden)'],
    ['DAILY_NAV', 'does not reference DAILY_NAV'],
    ['SYSTEM_NAV', 'does not reference SYSTEM_NAV'],
    ['ADDONS_HREF', 'does not reference ADDONS_HREF'],
    ['data-command-palette', 'search is unreachable (no data-command-palette opener)'],
    ['pb-safe', 'does not clear the safe-area inset (missing pb-safe)'],
    ['navItems', 'does not render the dynamic add-on groups (missing navItems)'],
  ]
  for (const [token, reason] of required) {
    if (!mobileNavSrc.includes(token)) violations.push(`${rel(MOBILE_NAV)} — ${reason}`)
  }
}

// --- 4. reachability closure: every model href is rendered by the below-md surface ---------------
if (navSrc !== null && mobileNavSrc !== null) {
  const reachable = (href, arrayName) =>
    mobileNavSrc.includes(`"${href}"`) || (arrayName !== null && mobileNavSrc.includes(arrayName))

  for (const href of dailyHrefs) {
    if (!reachable(href, 'DAILY_NAV')) {
      violations.push(`${rel(NAV_MODEL)} — "${href}" (DAILY_NAV) is not rendered by ${rel(MOBILE_NAV)}`)
    }
  }
  for (const href of systemHrefs) {
    if (!reachable(href, 'SYSTEM_NAV')) {
      violations.push(`${rel(NAV_MODEL)} — "${href}" (SYSTEM_NAV) is not rendered by ${rel(MOBILE_NAV)}`)
    }
  }
  if (addonsHref && !reachable(addonsHref, 'ADDONS_HREF')) {
    violations.push(`${rel(NAV_MODEL)} — "${addonsHref}" (ADDONS_HREF) is not rendered by ${rel(MOBILE_NAV)}`)
  }
}

// --- 5. layout.tsx mounts MobileNav (not just imports it) -----------------------------------------
if (layoutSrc === null) {
  violations.push(`${rel(LAYOUT)} — file does not exist`)
} else if (!layoutSrc.includes('<MobileNav')) {
  violations.push(`${rel(LAYOUT)} — MobileNav is not mounted (no <MobileNav usage)`)
}

// --- 6. every fixed phone tab points at a route the model actually knows --------------------------
if (navSrc !== null) {
  const tabHrefs = stringArrayLiterals(navSrc, 'MOBILE_TAB_HREFS')
  if (tabHrefs === null) {
    violations.push(`${rel(NAV_MODEL)} — no MOBILE_TAB_HREFS array found`)
  } else if (tabHrefs.length === 0) {
    violations.push(`${rel(NAV_MODEL)} — MOBILE_TAB_HREFS is empty`)
  } else {
    for (const href of tabHrefs) {
      if (!modelHrefs.has(href)) {
        violations.push(`${rel(NAV_MODEL)} — MOBILE_TAB_HREFS references "${href}", which is not in the nav model`)
      }
    }
  }
}

// --- 7. every add-on manifest icon key resolves in NAV_ICONS (no silent IconBolt fallback) ------
// A general invariant (ADR 0018), not a per-page one: any AddonManifest.icon or navItems[].icon
// key that isn't a key of NAV_ICONS silently renders navIcon()'s IconBolt fallback
// (nav-icons.tsx:59) instead of erroring — the add-on ships a wrong glyph with no signal. Filed
// HERE (not in a page-specific gate) because it protects every add-on's rows, not just one
// (cos-ops#38's 08-06 architect pass: "a per-page gate protects one row; the nav-invariant file
// protects every add-on's rows"). Source-level regex over board/lib/addons.ts as TEXT — the
// house idiom this file's own §§1-6 and skill-reachability.mjs's SCAN 2 both use.
let iconValues = []
const addonsSrc = readOrNull(ADDONS_FILE)
const navIconsSrc = readOrNull(NAV_ICONS_FILE)
if (addonsSrc === null) {
  violations.push(`${rel(ADDONS_FILE)} — file does not exist (no add-on manifests to check)`)
} else if (navIconsSrc === null) {
  violations.push(`${rel(NAV_ICONS_FILE)} — file does not exist (nothing to resolve add-on icon keys against)`)
} else {
  // Every `icon: "..."` value in addons.ts — the manifest-level icon AND every navItems[].icon.
  // Cross-checked against a raw occurrence count (excluding the interface's `icon: string`
  // declarations, which never carry a quoted value) so a value written as anything other than a
  // plain quoted string — a template literal, a shared const — can't silently shrink the checked
  // set (mirrors skill-reachability.mjs SCAN 2's setupSkillKeys guard).
  iconValues = [...addonsSrc.matchAll(/\bicon\s*:\s*"(\w+)"/g)].map((m) => m[1])
  const iconKeyCount = (addonsSrc.match(/\bicon\s*:(?!\s*string\b)/g) || []).length
  if (iconKeyCount !== iconValues.length) {
    violations.push(
      `${rel(ADDONS_FILE)} has ${iconKeyCount} icon key(s) but only ${iconValues.length} parsed as a plain ` +
        'quoted string — every icon value must be a literal "IconX" so this gate can see it.',
    )
  }
  if (iconValues.length === 0) {
    violations.push(`${rel(ADDONS_FILE)} — no icon: "..." values parsed — the regex or the registry moved`)
  } else {
    const navIconKeys = objectIconKeys(navIconsSrc, 'NAV_ICONS')
    if (navIconKeys === null || navIconKeys.length === 0) {
      violations.push(`${rel(NAV_ICONS_FILE)} — no NAV_ICONS object literal found (the regex or the file moved)`)
    } else {
      const navIconKeySet = new Set(navIconKeys)
      for (const key of new Set(iconValues)) {
        if (!navIconKeySet.has(key)) {
          violations.push(
            `${rel(ADDONS_FILE)} references icon "${key}", which is not a key of NAV_ICONS ` +
              `(${rel(NAV_ICONS_FILE)}) — navIcon() falls back to IconBolt silently for it`,
          )
        }
      }
    }
  }
}

if (violations.length) {
  console.error('[mobile-nav] violation(s):')
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    `[mobile-nav] ${violations.length} violation(s). Every href in the shared nav model ` +
      '(board/lib/nav.ts) must be reachable from a below-md navigation surface — see tests/mobile-nav.mjs.',
  )
  process.exit(1)
}

console.log(
  `[mobile-nav] ${modelHrefs.size} nav href(s) checked — all reachable below md; sidebar scrolls its overflow; ` +
    `${new Set(iconValues).size} add-on icon key(s) resolve in NAV_ICONS.`,
)
process.exit(0)
