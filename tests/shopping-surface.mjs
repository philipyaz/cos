#!/usr/bin/env node
// tests/shopping-surface.mjs — the ADR 0014 gate for the shopping-list BOARD SURFACE
// (cos-ops#38, the UI half of cos-ops#37's state): /nutrition/shopping must be reachable from
// the ONE shared nav model (no second list to edit), grouped in the fixed aisle order with
// uncategorized last, wired to all three statuses (tick-to-bought / restore-to-needed /
// dismiss) with an always-visible quick-add and no drawer import, and SSR-seeded on the SAME
// default candidates window the /candidates route itself defaults to (a page/route drift here
// reads as "the suggestions changed a moment after the page loaded" and is invisible in either
// diff alone).
//
//   node tests/shopping-surface.mjs
//
// Read-only, no deps, REPO_ROOT from config/load-config.mjs — tests/mobile-nav.mjs is the house
// shape for this kind of static, node-only invariant checker (read + path:line violations + exit
// code). Demonstrated RED before the page/component/nav row existed (ADR 0014); rides the [2f]
// step id in tests/run.sh as the fifth rider (ADR 0022).

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../config/load-config.mjs'

const ADDONS_FILE = join(REPO_ROOT, 'board', 'lib', 'addons.ts')
const NAV_FILE = join(REPO_ROOT, 'board', 'lib', 'nav.ts')
const PAGE_FILE = join(REPO_ROOT, 'board', 'app', 'nutrition', 'shopping', 'page.tsx')
const CANDIDATES_ROUTE_FILE = join(
  REPO_ROOT, 'board', 'app', 'api', 'nutrition', 'shopping', 'candidates', 'route.ts',
)
const VIEW_FILE = join(REPO_ROOT, 'board', 'components', 'nutrition', 'shopping-view.tsx')
const CLIENT_FILE = join(REPO_ROOT, 'board', 'lib', 'nutrition-client.ts')

const rel = (p) => relative(REPO_ROOT, p)
const violations = []

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Every plain string literal inside one `export const NAME = [ ... ];` array in `src`. */
function stringArrayLiterals(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start === -1) return null
  const end = src.indexOf('];', start)
  const slice = end === -1 ? src.slice(start) : src.slice(start, end)
  return [...slice.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

// --- 1. board/lib/addons.ts — NUTRITION_ADDON.navItems carries the shopping row ------------------
const addonsSrc = readOrNull(ADDONS_FILE)
if (addonsSrc === null) {
  violations.push(`${rel(ADDONS_FILE)} — file does not exist`)
} else {
  const addonMatch = addonsSrc.match(/const NUTRITION_ADDON: AddonManifest = \{[\s\S]*?\n\};/)
  if (!addonMatch) {
    violations.push(`${rel(ADDONS_FILE)} — could not find 'const NUTRITION_ADDON: AddonManifest = { … };'`)
  } else {
    const navItemsMatch = addonMatch[0].match(/navItems:\s*\[([\s\S]*?)\],\n/)
    const navItemsSlice = navItemsMatch ? navItemsMatch[1] : ''
    if (!/href:\s*"\/nutrition\/shopping"/.test(navItemsSlice)) {
      violations.push(
        `${rel(ADDONS_FILE)} — NUTRITION_ADDON.navItems does not contain href: "/nutrition/shopping" ` +
          '(no second list to edit — the nav row is manifest data, not a hardcoded sidebar/mobile-nav edit)',
      )
    }
  }
}

// --- 2. board/lib/nav.ts — MOBILE_TAB_HREFS never gains an add-on href ---------------------------
const navSrc = readOrNull(NAV_FILE)
if (navSrc === null) {
  violations.push(`${rel(NAV_FILE)} — file does not exist`)
} else {
  const tabHrefs = stringArrayLiterals(navSrc, 'MOBILE_TAB_HREFS')
  if (tabHrefs === null) {
    violations.push(`${rel(NAV_FILE)} — no MOBILE_TAB_HREFS array found`)
  } else {
    const nutritionTab = tabHrefs.find((h) => h.startsWith('/nutrition'))
    if (nutritionTab) {
      violations.push(
        `${rel(NAV_FILE)} — MOBILE_TAB_HREFS contains "${nutritionTab}" — an add-on page must never claim a phone tab`,
      )
    }
  }
}

// --- 3. the page — gated, SSR-seeds the engine, and mirrors the candidates route's own window ---
const pageSrc = readOrNull(PAGE_FILE)
if (pageSrc === null) {
  violations.push(`${rel(PAGE_FILE)} — file does not exist`)
} else {
  const required = ['isAddonEnabled', 'notFound', 'force-dynamic', 'computeShoppingCandidates', 'addDays(today, 6)']
  for (const token of required) {
    if (!pageSrc.includes(token)) violations.push(`${rel(PAGE_FILE)} — does not contain "${token}"`)
  }
}
const candidatesRouteSrc = readOrNull(CANDIDATES_ROUTE_FILE)
if (candidatesRouteSrc === null) {
  violations.push(`${rel(CANDIDATES_ROUTE_FILE)} — file does not exist`)
} else if (!candidatesRouteSrc.includes('addDays(today, 6)')) {
  violations.push(
    `${rel(CANDIDATES_ROUTE_FILE)} — does not contain "addDays(today, 6)" (the default-window expression ` +
      'the page must mirror — a drift here reads as "the suggestions changed a moment after the page loaded")',
  )
}

// --- 4. the view — all three statuses wired, always-visible add, collapsible pile, no drawer ----
const viewSrc = readOrNull(VIEW_FILE)
if (viewSrc === null) {
  violations.push(`${rel(VIEW_FILE)} — file does not exist`)
} else {
  const required = [
    'useLiveBoard',
    'groupShoppingByCategory',
    'status: "bought"',
    'status: "needed"',
    'status: "dismissed"',
    'createShoppingItem',
    '<form',
    '<input',
    'aria-expanded',
  ]
  for (const token of required) {
    if (!viewSrc.includes(token)) violations.push(`${rel(VIEW_FILE)} — does not contain "${token}"`)
  }
  // "no drawer/modal required to add" at the level the repo can check: ban the IMPORT, not the
  // word, so explanatory prose (like this comment) can never trip it (ADR 0018 precedent).
  const drawerImport = viewSrc.split('\n').find((line) => /from\s+["'][^"']*drawer/i.test(line))
  if (drawerImport) {
    violations.push(`${rel(VIEW_FILE)} — imports a drawer (${drawerImport.trim()}) — tick/add/dismiss must never require one`)
  }
}

// --- 5. the client helpers the view wires to ------------------------------------------------------
const clientSrc = readOrNull(CLIENT_FILE)
if (clientSrc === null) {
  violations.push(`${rel(CLIENT_FILE)} — file does not exist`)
} else {
  for (const token of ['createShoppingItem', 'updateShoppingItem']) {
    if (!clientSrc.includes(token)) violations.push(`${rel(CLIENT_FILE)} — does not contain "${token}"`)
  }
}

if (violations.length) {
  console.error('[shopping-surface] violation(s):')
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    `[shopping-surface] ${violations.length} violation(s). /nutrition/shopping must be reachable from ` +
      'the shared nav model, grouped in aisle order, wired to all three statuses with no drawer, and ' +
      'window-pinned to the candidates route — see tests/shopping-surface.mjs.',
  )
  process.exit(1)
}

console.log(
  '[shopping-surface] /nutrition/shopping is nav-reachable, aisle-grouped, tick/restore/dismiss-wired, ' +
    'drawer-free, and window-pinned to the candidates route.',
)
process.exit(0)
