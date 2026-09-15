// A5 (cos-ops#90): three of the board's nine right-side drawers have exactly one exit on a
// phone — a 26.0px "Close · Esc" in the top-right corner. This is the CONSOLIDATION half of the
// issue — the coarse-pointer >=44px target claim and the `sm`-gated `· Esc` hint are carried by
// the PR body's per-drawer statement and DoD 6, not by a gate here (same split
// primary-action.test.ts's own header describes for the button family).
//
// Shares tsx-controls.mjs's scanner, resolver, token-matcher and exclusion helper with every
// other A5 gate — cos-ops#103 folded what were four hand-copied `staticClassNameLiteral`/
// `classTokens`/`hasAllTokens` copies and two incompatible definition-site exclusion idioms into
// that one shared module; this file no longer carries any of its own.
//
// ── Scope ─────────────────────────────────────────────────────────────────────────────────────
// ROOTS are `board/components` + `board/app`, inherited from both shipped gates — so
// `board/lib` (which legitimately holds class MAPS, e.g. format.ts's LABEL_CHIP family) is never
// walked, and AC 1's "anywhere under board/" is enforced at the same breadth every A5 gate uses,
// not literally every file under `board/`. The exclusion is `walkTsxExcept(ROOTS, [DRAWER_FILE])`
// — exactly the one file that defines what this gate pins, not the whole
// `board/components/shared/` DIRECTORY (the pre-fold rule, and false even then: `shared/` holds
// seven files, not three, and six of them — action-button.tsx, field.tsx, alert.tsx,
// markdown.tsx, message-link.tsx, source-icon.tsx — are reachable by this walk now, including
// markdown.tsx's own hand-rolled interactive `<button>`, cos-ops#103's own motivating example).
//
// Declared skip floor (cos-ops#103, Correction 1): an unresolvable or className-less opening tag
// is invisible to this walk — `classNameStrings` reports `resolved: false` and the scan skips it
// rather than reporting it (measured count in the PR body).
//
// Scope is ANY opening tag (derived per file, exactly as secondary-action.test.ts's visibility
// assertion does), not `<button>/<a>/<Link>` — the drawer header string sits on a `<div>`.
//
// ── Per-assertion predicate choice — each grounded in a measured site list ──────────────────────
// Close (test 1): whole-token SET over all eight original tokens (`ml-auto`, `text-[12px]`,
// `text-ink-500`, `hover:text-ink-900`, `px-2`, `py-1`, `rounded`, `hover:bg-ink-50`). Measured:
// exactly 9 hits on `main`, zero false positives. Why not substring: the fixed `CLOSE_CLASS`
// inserts `inline-flex items-center justify-center` right after `ml-auto`, so after this PR the
// OLD substring exists nowhere in the tree — not even in drawer.tsx itself — and a substring
// predicate would go permanently vacuous (the exact trap primary-action.test.ts's own header
// names and avoids: "Test 1 is then permanently green and cannot fire on the realistic future
// regression"). The token SET survives in the new constant, so a future copy IS caught.
//
// Header (test 2): exact-substring CONTAINMENT, the opposite choice, for a measured reason a
// token set is wrong here: eight view toolbars — calendar-view.tsx:132, trash-view.tsx:127,
// priorities-view.tsx:121, pantry-view.tsx:105, shopping-view.tsx:150, food-log-view.tsx:100,
// meal-plan-view.tsx:92, reminders-view.tsx:123 — carry all seven header tokens in a DIFFERENT
// order (`h-12 px-5 flex items-center gap-2 border-b border-ink-100 bg-white shrink-0`). A token
// set flags all seventeen; ordered-substring containment hits exactly the nine. `HEADER_CLASS`
// stays byte-identical in drawer.tsx, so containment is fix-invariant here — unlike the Close
// case above. Accepted floor, same shape as the shipped gates' denominator statements: a
// REORDERED hand-rolled header escapes this test; it pins the canonical spelling, not the concept.
//
// ── Not in the family — named so a future reader doesn't "discover" them ────────────────────────
// `mobile-nav.tsx` (a bottom-sheet scrim, not `fixed top-0 right-0`) and `command-palette.tsx` (a
// spotlight overlay) are two of the eleven `role="dialog"` components on the board; neither is a
// right-side drawer and neither carries either gate string. `case-detail-drawer.tsx`'s attachment
// preview overlay carries a TENTH `aria-label="Close …"` (`aria-label="Close preview"`) — it is an
// inline `mt-3 rounded-md` card inside one of the nine, not a drawer shell, and is untouched.
//
// ADR 0032:123-126 applies: this is a CONSOLIDATION assertion over two class strings — deletion-
// shaped and mechanism-agnostic — never the deferred "gate that scores design quality (contrast,
// target size, token coverage)".
//
// Run: `node --test tests/unit/drawer-shell.test.ts` (also rides `tests/run.sh`'s
// `tests/unit/*.test.ts` glob at `tests/run.sh:527` — no run.sh edit needed; imports only Node
// builtins + tsx-controls.mjs, so no ts-resolve hook is required to run it standalone).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, openingTags, classNameStrings, hasAllTokens, walkTsxExcept } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [path.join(REPO_ROOT, "board/components"), path.join(REPO_ROOT, "board/app")];
const DRAWER_FILE = path.join(REPO_ROOT, "board/components/shared/drawer.tsx");

const CLOSE_TOKENS = [
  "ml-auto",
  "text-[12px]",
  "text-ink-500",
  "hover:text-ink-900",
  "px-2",
  "py-1",
  "rounded",
  "hover:bg-ink-50",
];
const HEADER_STRING = "px-5 h-12 flex items-center border-b border-ink-100 gap-2";
const HEADER_TOKENS = HEADER_STRING.split(/\s+/);

// The fixed list of the nine drawers, repo-relative — the AC's own words. Loud-staleness by
// design: deleting a drawer later reds this list, which is the prompt to prune it.
const DRAWER_FILES = [
  "board/components/calendar/event-drawer.tsx",
  "board/components/case-detail-drawer.tsx",
  "board/components/board/label-manager.tsx",
  "board/components/board/unanswered-messages.tsx",
  "board/components/body/body-profile-drawer.tsx",
  "board/components/body/diet-profile-drawer.tsx",
  "board/components/nutrition/pantry-item-drawer.tsx",
  "board/components/nutrition/goal-drawer.tsx",
  "board/components/reminders/reminder-drawer.tsx",
];

function relPath(file: string): string {
  return path.relative(REPO_ROOT, file);
}

function scanDrawerClasses(): {
  closeViolations: string[];
  headerViolations: string[];
  filesWalked: number;
  files: string[];
} {
  const files = walkTsxExcept(ROOTS, [DRAWER_FILE]);
  const closeViolations: string[] = [];
  const headerViolations: string[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    // Any opening tag, derived per file — the header string sits on a <div>, not a control tag.
    const tagNames = [...new Set([...src.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))];

    for (const { tag, attrText, line } of openingTags(src, tagNames)) {
      const { fragments, resolved } = classNameStrings(attrText, src);
      if (!resolved) continue; // unresolvable or absent className — invisible to this walk (floor: header)
      const lit = fragments.join(" ");
      if (hasAllTokens(lit, CLOSE_TOKENS)) {
        closeViolations.push(`${relPath(file)}:${line} — <${tag}> className="${lit}"`);
      }
      if (lit.includes(HEADER_STRING)) {
        headerViolations.push(`${relPath(file)}:${line} — <${tag}> className="${lit}"`);
      }
    }
  }
  return { closeViolations, headerViolations, filesWalked: files.length, files };
}

test("consolidation: no opening tag outside board/components/shared/ carries the drawer Close token set", () => {
  const { closeViolations } = scanDrawerClasses();
  if (closeViolations.length > 0) {
    assert.fail(`${closeViolations.length} re-declared drawer Close site(s):\n${closeViolations.join("\n")}`);
  }
});

test("consolidation: no opening tag outside board/components/shared/ carries the drawer header string", () => {
  const { headerViolations } = scanDrawerClasses();
  if (headerViolations.length > 0) {
    assert.fail(`${headerViolations.length} re-declared drawer header site(s):\n${headerViolations.join("\n")}`);
  }
});

test("presence floor: drawer.tsx exists and defines both the header and Close class strings", () => {
  assert.ok(fs.existsSync(DRAWER_FILE), "expected board/components/shared/drawer.tsx to exist");
  const raw = fs.readFileSync(DRAWER_FILE, "utf8");
  const literals = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  // Token-set on BOTH here (not substring containment for the header, unlike test 2 above) —
  // placement-agnostic on purpose: the fixed CLOSE_CLASS inserts new tokens between `ml-auto` and
  // `text-[12px]`, so old-substring containment would go red on the correct build (the
  // predicate-vs-blessed-fix trap ops#86 named). Do NOT assert the coarse-pointer/active tokens
  // here — the 44px claim is carried by the PR body, not pinned as a gate.
  assert.ok(
    literals.some((lit) => hasAllTokens(lit, HEADER_TOKENS)),
    "expected a string literal in drawer.tsx to carry every header token",
  );
  assert.ok(
    literals.some((lit) => hasAllTokens(lit, CLOSE_TOKENS)),
    "expected a string literal in drawer.tsx to carry every original Close token",
  );
});

test("routing floor: every one of the nine drawers imports shared/drawer", () => {
  const missing: string[] = [];
  for (const rel of DRAWER_FILES) {
    const full = path.join(REPO_ROOT, rel);
    const raw = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    if (!raw.includes("shared/drawer")) missing.push(rel);
  }
  assert.deepEqual(missing, [], `expected all nine drawers to import shared/drawer; missing:\n${missing.join("\n")}`);
});

test("vacuous-pass floor: the walk actually reaches a meaningful number of files", () => {
  const { filesWalked } = scanDrawerClasses();
  assert.ok(filesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${filesWalked}`);
});

test("coverage floor: the narrowed exclusion walks the non-definition shared/ files (cos-ops#103)", () => {
  const { files } = scanDrawerClasses();
  assert.ok(
    files.includes(path.join(REPO_ROOT, "board/components/shared/markdown.tsx")),
    "expected the walk to include board/components/shared/markdown.tsx (excluded only drawer.tsx, not the whole shared/ directory)",
  );
});
