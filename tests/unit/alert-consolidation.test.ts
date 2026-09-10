// A5 (cos-ops#94): the board's error-banner family — rose "an operation failed" banners — is
// hand-rolled 24 times across 23 files in 8 distinct className spellings, disagreeing with itself
// on dismissibility (17/7) and on whether it shows a warning icon (12/12). This is the
// CONSOLIDATION half of the issue — the 44px coarse-pointer dismiss-target claim is carried by
// the PR body and by reading alert.tsx (AC 2), not by a gate here, the same split every A5 gate
// before this one makes.
//
// C1 (pm-applicative-review, binding): the review's gate correction — scan `openingTags` over
// per-file-DERIVED tag names, never a fixed `["button","a","Link"]` list. Both byte-identical
// banner strings sit on a `<div>`, and shopping-view's straggler sits on a `<p>` — a
// `["button","a","Link"]` scan would see zero of these 24 sites and go green on the completely
// unfixed tree. Adopts drawer-shell.test.ts's exact mechanism (every tag that appears in the
// file, via a matchAll over `<([A-Za-z][A-Za-z0-9]*)`), a strict superset of `["div","p"]`.
//
// ── Scope ────────────────────────────────────────────────────────────────────────────────────
// ROOTS + the whole-`shared/`-directory exclusion are the same as every A5 gate before this one
// (board/components + board/app; board/lib is never walked — it legitimately holds class MAPS).
//
// ── Per-assertion predicate choice — each grounded in a measured site list (re-verified at
// cos main@804cdda by the architect and again this session) ────────────────────────────────────
// Tests 1–3 (drawer / card / the two straggler pairs): exact-substring CONTAINMENT of the byte-
// identical spelling — the AC's own words ("neither byte-identical banner class string … is
// declared at any call site outside shared/alert.tsx"). After the fix these four strings exist
// NOWHERE in the tree (base + edge split every one of them apart), so containment goes vacuous
// the instant a future dev pastes the OLD spelling back in — exactly the regression this pins.
// It does NOT catch a hand-rolled NEW rose banner at a different size/shape; that is test 4's job.
//
// Test 4 (family token set): the durable future-copier catcher — whole-TOKEN ALL-OF (never
// substring, so `text-[12.5px]` never satisfies `text-[12px]`) over {text-[12px], text-rose-700,
// bg-rose-50}, the trio ALERT_BASE keeps post-fix, so it stays satisfiable (unlike tests 1–3).
// Measured 20 hits, 0 false positives: the four sites that carry the rose-failure MEANING but not
// this EXACT token trio (case-detail-drawer.tsx's reminders-section banner is text-[11.5px]; the
// artifact-feed/training-plan-view straggler pair is text-[13px] with no bg-rose-50 on the tag
// carrying role="alert"; shopping-view's addError is a bare text-[11.5px] `<p>` with no
// bg-rose-50 at all) are accepted floors of the family CONCEPT, not this gate's target — the same
// "pins the canonical family, not the concept" bound drawer-shell.test.ts states for its own
// reordered-header floor.
//
// ── Not in the family — named so a future reader doesn't "discover" them ───────────────────────
// The amber `notice` banner beside label-manager's error (a bundle-install confirmation, not a
// failure) and training-plan-view's amber/emerald calendar-push outcome box are a DIFFERENT tone
// family — out of scope (the issue scopes to rose). The 5 `role="alert"` chips (shopping ×2
// status confirmations, reminders, tasks, the body-hub ring-chip family) are a live-region
// concern, not this banner family — a named residue, untouched here.
//
// ADR 0032:123-126 applies: this is a CONSOLIDATION assertion over class strings — deletion-
// shaped and mechanism-agnostic — never the deferred "gate that scores design quality".
//
// Run: `node --test tests/unit/alert-consolidation.test.ts` (also rides `tests/run.sh`'s
// `tests/unit/*.test.ts` glob — no run.sh edit needed; imports only Node builtins + tsx-
// controls.mjs, so no ts-resolve hook is required to run it standalone).
//
// Accumulation, carried here rather than silently: this is the FOURTH byte-for-byte copy of both
// `staticClassNameLiteral` (primary-action.test.ts:76, secondary-action.test.ts:111, drawer-
// shell.test.ts:119) and of `classTokens`/`hasAllTokens` (same three files) — folding either into
// tsx-controls.mjs would edit three shipped gate files, which no AC here licenses. This is also
// the fourth A5 scanner gate and the 50th tracked `tests/unit/*.test.ts`. ADR 0014's revisit
// condition takes pressure from both sides; no single unit can see it, so it is recorded again.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkTsx, stripComments, openingTags, attrLiteral } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [path.join(REPO_ROOT, "board/components"), path.join(REPO_ROOT, "board/app")];
const ALERT_FILE = path.join(REPO_ROOT, "board/components/shared/alert.tsx");
const SHARED_DIR = path.join(REPO_ROOT, "board/components/shared") + path.sep;

const DRAWER_STRING =
  "px-5 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-100 flex items-center gap-2";
const CARD_STRING =
  "flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md";
const PAIR_A_STRING =
  "mx-5 mt-3 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md";
const PAIR_B_STRING = "rounded-lg border border-rose-200 bg-rose-50 px-4 py-3";
const FAMILY_TOKENS = ["text-[12px]", "text-rose-700", "bg-rose-50"];

// The fixed list of the 23 routed files, repo-relative — the AC's own words. Loud-staleness by
// design: deleting one of these later reds this list, which is the prompt to prune it.
const ROUTED_FILES = [
  "board/components/body/body-profile-drawer.tsx",
  "board/components/body/diet-profile-drawer.tsx",
  "board/components/calendar/event-drawer.tsx",
  "board/components/case-detail-drawer.tsx",
  "board/components/nutrition/goal-drawer.tsx",
  "board/components/nutrition/pantry-item-drawer.tsx",
  "board/components/priorities/priorities-view.tsx",
  "board/components/reminders/reminder-drawer.tsx",
  "board/components/trash/trash-view.tsx",
  "board/components/inbox/inbox-view.tsx",
  "board/components/addons/addons-view.tsx",
  "board/components/backups/backups-view.tsx",
  "board/components/fitness/health-view.tsx",
  "board/components/fitness/overview-view.tsx",
  "board/components/security/guard-control.tsx",
  "board/components/security/quarantine-view.tsx",
  "board/components/security/whitelist-view.tsx",
  "board/components/board/label-manager.tsx",
  "board/components/board/unanswered-messages.tsx",
  "board/components/board/strategy-view.tsx",
  "board/components/fitness/artifact-feed.tsx",
  "board/components/fitness/training-plan-view.tsx",
  "board/components/nutrition/shopping-view.tsx",
];

function relPath(file: string): string {
  return path.relative(REPO_ROOT, file);
}

/** Every whitespace-delimited class token in `classString` (whole-token compare — never a
 * substring — so e.g. `bg-rose-50/90` never matches `bg-rose-50`). */
function classTokens(classString: string): string[] {
  return classString.split(/\s+/).filter(Boolean);
}

function hasAllTokens(classString: string, required: string[]): boolean {
  const tokens = classTokens(classString);
  return required.every((t) => tokens.includes(t));
}

/** `className="…"`, or `className={IDENT}` resolved against a same-file `const IDENT = "…"` —
 * deliberately nothing wider (see header). Returns the literal string, or null. Byte-for-byte
 * copy of primary-action.test.ts's / secondary-action.test.ts's / drawer-shell.test.ts's own
 * helper (see header — a fourth copy, recorded as residue rather than folded into
 * tsx-controls.mjs). */
function staticClassNameLiteral(attrText: string, src: string): string | null {
  const lit = attrLiteral(attrText, "className");
  if (lit !== null) return lit;

  const m = attrText.match(/\bclassName\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/);
  if (!m) return null;
  const identRe = new RegExp(`\\bconst\\s+${m[1]}\\s*(?::[^=]+)?=\\s*(["'])((?:(?!\\1).)*)\\1`);
  const cm = src.match(identRe);
  return cm ? cm[2] : null;
}

function scanAlertClasses(): {
  drawerViolations: string[];
  cardViolations: string[];
  pairViolations: string[];
  familyViolations: string[];
  filesWalked: number;
} {
  const files = walkTsx(ROOTS).filter((f) => !f.startsWith(SHARED_DIR));
  const drawerViolations: string[] = [];
  const cardViolations: string[] = [];
  const pairViolations: string[] = [];
  const familyViolations: string[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    // Any opening tag, derived per file (C1) — this family's sites sit on <div> AND <p>, and
    // never on <button>/<a>/<Link>.
    const tagNames = [...new Set([...src.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))];

    for (const { tag, attrText, line } of openingTags(src, tagNames)) {
      const lit = staticClassNameLiteral(attrText, src);
      if (lit === null) continue;
      const tagRef = `${relPath(file)}:${line} — <${tag}> className="${lit}"`;
      if (lit.includes(DRAWER_STRING)) drawerViolations.push(tagRef);
      if (lit.includes(CARD_STRING)) cardViolations.push(tagRef);
      if (lit.includes(PAIR_A_STRING) || lit.includes(PAIR_B_STRING)) pairViolations.push(tagRef);
      if (hasAllTokens(lit, FAMILY_TOKENS)) familyViolations.push(tagRef);
    }
  }
  return { drawerViolations, cardViolations, pairViolations, familyViolations, filesWalked: files.length };
}

test("consolidation: no opening tag outside board/components/shared/ carries the drawer banner string", () => {
  const { drawerViolations } = scanAlertClasses();
  if (drawerViolations.length > 0) {
    assert.fail(`${drawerViolations.length} re-declared drawer banner site(s):\n${drawerViolations.join("\n")}`);
  }
});

test("consolidation: no opening tag outside board/components/shared/ carries the card banner string", () => {
  const { cardViolations } = scanAlertClasses();
  if (cardViolations.length > 0) {
    assert.fail(`${cardViolations.length} re-declared card banner site(s):\n${cardViolations.join("\n")}`);
  }
});

test("consolidation: no opening tag outside board/components/shared/ carries either straggler-pair string", () => {
  const { pairViolations } = scanAlertClasses();
  if (pairViolations.length > 0) {
    assert.fail(`${pairViolations.length} re-declared straggler site(s):\n${pairViolations.join("\n")}`);
  }
});

test("consolidation: no opening tag outside board/components/shared/ carries the full rose-banner family token set", () => {
  const { familyViolations } = scanAlertClasses();
  if (familyViolations.length > 0) {
    assert.fail(`${familyViolations.length} re-declared family-token site(s):\n${familyViolations.join("\n")}`);
  }
});

test("presence floor: alert.tsx exists, carries the family tokens, and onDismiss is required-nullable", () => {
  assert.ok(fs.existsSync(ALERT_FILE), "expected board/components/shared/alert.tsx to exist");
  const raw = fs.readFileSync(ALERT_FILE, "utf8");
  const literals = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    literals.some((lit) => hasAllTokens(lit, FAMILY_TOKENS)),
    "expected a string literal in alert.tsx to carry text-[12px], text-rose-700 and bg-rose-50",
  );
  // AC 4's type-level seam: onDismiss must be required (no `?`) and nullable, so tsc forces every
  // routed call site to state its dismissibility decision explicitly.
  assert.ok(
    /\bonDismiss\s*:\s*\(\s*\(\s*\)\s*=>\s*void\s*\)\s*\|\s*null/.test(raw),
    "expected onDismiss to be declared required-nullable: (() => void) | null",
  );
  assert.ok(!/\bonDismiss\s*\?\s*:/.test(raw), "expected onDismiss to NOT be declared optional");
});

test("routing floor: every one of the 23 routed files imports shared/alert", () => {
  const missing: string[] = [];
  for (const rel of ROUTED_FILES) {
    const full = path.join(REPO_ROOT, rel);
    const raw = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    if (!raw.includes("shared/alert")) missing.push(rel);
  }
  assert.deepEqual(missing, [], `expected all 23 files to import shared/alert; missing:\n${missing.join("\n")}`);
});

test("passthrough contract: every <Alert> call site's className carries only spacing tokens", () => {
  const files = walkTsx(ROOTS).filter((f) => !f.startsWith(SHARED_DIR));
  const violations: string[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const { attrText, line } of openingTags(src, ["Alert"])) {
      const idx = attrText.search(/\bclassName\s*=/);
      if (idx === -1) continue; // no className passed — nothing to police
      const lit = staticClassNameLiteral(attrText, src);
      if (lit === null) {
        violations.push(`${relPath(file)}:${line} — <Alert> className is not statically resolvable`);
        continue;
      }
      const bad = classTokens(lit).filter((t) => !/^(px-|mx-|mt-|mb-)/.test(t));
      if (bad.length > 0) {
        violations.push(
          `${relPath(file)}:${line} — <Alert> className="${lit}" carries non-spacing token(s): ${bad.join(", ")}`,
        );
      }
    }
  }
  if (violations.length > 0) {
    assert.fail(`${violations.length} <Alert> site(s) with a non-spacing className:\n${violations.join("\n")}`);
  }
});

test("vacuous-pass floor: the walk actually reaches a meaningful number of files", () => {
  const { filesWalked } = scanAlertClasses();
  assert.ok(filesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${filesWalked}`);
});
