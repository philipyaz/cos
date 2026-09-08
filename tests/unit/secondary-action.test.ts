// A5 (cos-ops#86): the phone can't see nine hover-only controls, and every non-primary drawer
// button is still mouse-sized. Two independent gates share this file because they share one
// scanner and one census (tsx-controls.mjs, cos-ops#82/#83) and were designed + reviewed
// together; each states its own subject up front rather than making a reader infer it from the
// tests below.
//
// ── Assertion 1 — CONSOLIDATION (AC 5) ───────────────────────────────────────────────────────
// The secondary (border-ink-200 + hover:bg-white) and destructive (border-rose-200 +
// text-rose-600) pairs must live in exactly board/components/shared/action-button.tsx, never
// re-declared at any <button>/<a>/<Link> call site — byte-for-byte primary-action.test.ts's own
// recipe: the NARROW resolver (a literal className="…", or className={IDENT} resolving to a
// same-file string const), deliberately not tsx-controls.mjs's wider `classNameStrings` (which
// also resolves templates/ternaries — the right choice for assertion 2 below, the wrong one
// here).
//
// Why narrow, not wide: `whitelist-view.tsx:323` is a ternary flip-tier button whose "blocked"
// arm carries the destructive pair — the same segmented/state-arm shape primary-action.test.ts's
// own header excludes for the primary pair. Naming it here means a later reader doesn't
// "discover" it as a missed site: the wide resolver would flag it forever, and the narrow one
// excludes it for free.
//
// THE DENOMINATOR THIS GATE ACTUALLY COVERS — stated outright so a green run is never read as
// more than it is: of 48 `border-ink-200` buttons, this matches exactly the 7 routed secondary
// sites. The other 39 hover `bg-ink-50` (the white-surface idiom elsewhere in board/) and are
// invisible to this gate FOREVER, by design — action-button.tsx's header explains why they
// aren't routed (a call-site `hover:bg-ink-50` against this base's `hover:bg-white` would be a
// same-specificity fight decided by emitted stylesheet order, exactly the trap ADR 0035 exists to
// prevent). Of 38 destructive sites, this matches exactly the 5 routed sites — the 17
// `text-rose-500` sites (a deliberately quieter, borderless affordance) are likewise invisible
// forever. A new hand-spelled `hover:bg-ink-50` secondary passes this gate unimpeded; that is the
// correct scope, not a hole in the gate.
//
// ── Assertion 2 — VISIBILITY (AC 6, amended) ─────────────────────────────────────────────────
// Every opacity-0 + group-hover…:opacity-100 reveal must also carry pointer-coarse:opacity-100
// — Tailwind v4 compiles `group-hover:` inside `@media (hover: hover)`, which iOS Safari never
// matches, so the control is operable but UNDISCOVERABLE on a coarse pointer (never say
// "unreachable": opacity-0 still occupies layout and still takes taps) — UNLESS the exact
// (file, class-string) pair is one of three named decorative sites.
//
// Scope is ANY opening tag, not <button>/<a>/<Link>: strategy-view.tsx's inline create-child
// actions cluster is a <div> (its buttons arrive as {actions}), so a button-scoped gate would
// cover 8 of the 9 real controls and go green with the ninth unfixed. Resolution is the WIDE
// `classNameStrings`, with every fragment joined before tokenizing: two of the nine sites
// (board-view.tsx's card star, strategy-view.tsx's tree-row star) carry opacity-0 only inside a
// ternary arm, and only the wide resolver reaches into it.
//
// The allowlist keys on basename + the exact joined class-string (never file+line — a line
// number drifts on any edit above it): the three decorative sites named below. Each entry must
// match EXACTLY ONCE — zero means the decorative site's own shape changed (prune the entry, or
// investigate); more than once means a new site is silently riding an old entry. Either way this
// fails LOUDLY instead of the allowlist quietly rotting into a list that can never fire (the
// reason a button-scoped design with this same allowlist was rejected: it could never match
// anything).
//
// Accepted floors, named so a future reader doesn't rediscover them as bugs: the joined-fragment
// match can't tell WHICH ternary arm carries the escape token, so an (implausible) cross-arm
// pairing would still pass — fail-open there is deliberate, the real per-arm correctness is
// reviewed by hand in the PR, not re-derived here; and an unresolvable dynamic className (no
// static literal, no same-file const, no resolvable ternary) is invisible to this assertion
// entirely — every one of the 12 known family sites resolves today (the red-first count below is
// the proof), so this floor costs nothing on the current tree.
//
// This assertion is EFFECTIVELY remedy-agnostic, not flatly "mechanism-agnostic": the predicate
// names the blessed escape token (pointer-coarse:opacity-100) rather than scoring a height, but
// because it keys on the UNPREFIXED opacity-0 token being present at rest, both blessed remedies
// pass it — adding the coarse route (the fix this unit ships for 8 sites) or deleting the tag
// outright (pantry-view.tsx's quick-delete) — and so would the rejected `pointer-fine:opacity-0`
// restructure, since it also removes the unprefixed token. What the predicate forbids is exactly
// "hidden at rest behind a hover-only reveal", not any one fix for it.
//
// ADR 0032/0014 apply to both assertions: deletion-shaped, mechanism-agnostic where stated above,
// and neither computes a height from any class string (the deferred, dropped shape named in
// primary-action.test.ts's own header).
//
// Run: `node --test tests/unit/secondary-action.test.ts` (rides tests/run.sh's
// `tests/unit/*.test.ts` glob — no run.sh edit needed).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkTsx, stripComments, openingTags, attrLiteral, classNameStrings } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [path.join(REPO_ROOT, "board/components"), path.join(REPO_ROOT, "board/app")];
const PRIMITIVE_DEFINITION_FILE = path.join(REPO_ROOT, "board/components/shared/action-button.tsx");

function relPath(file) {
  return path.relative(REPO_ROOT, file);
}

/** Every whitespace-delimited class token in `classString` (whole-token compare — never a
 * substring — so e.g. `bg-ink-900/90` never matches `bg-ink-900`). */
function classTokens(classString) {
  return classString.split(/\s+/).filter(Boolean);
}

// ── Assertion 1 — consolidation ──────────────────────────────────────────────────────────────

function hasSecondaryPair(tokens) {
  return tokens.includes("border-ink-200") && tokens.includes("hover:bg-white");
}
function hasDestructivePair(tokens) {
  return tokens.includes("border-rose-200") && tokens.includes("text-rose-600");
}

/** `className="…"`, or `className={IDENT}` resolved against a same-file `const IDENT = "…"` —
 * deliberately nothing wider (see header). Returns the literal string, or null. */
function staticClassNameLiteral(attrText, src) {
  const lit = attrLiteral(attrText, "className");
  if (lit !== null) return lit;

  const m = attrText.match(/\bclassName\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/);
  if (!m) return null;
  const identRe = new RegExp(`\\bconst\\s+${m[1]}\\s*(?::[^=]+)?=\\s*(["'])((?:(?!\\1).)*)\\1`);
  const cm = src.match(identRe);
  return cm ? cm[2] : null;
}

function scanConsolidation() {
  const files = walkTsx(ROOTS).filter((f) => f !== PRIMITIVE_DEFINITION_FILE);
  const violations = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const { tag, attrText, line } of openingTags(src, ["button", "a", "Link"])) {
      const lit = staticClassNameLiteral(attrText, src);
      if (lit === null) continue;
      const tokens = classTokens(lit);
      if (hasSecondaryPair(tokens) || hasDestructivePair(tokens)) {
        violations.push(`${relPath(file)}:${line} — <${tag}> className="${lit}"`);
      }
    }
  }
  return { violations, filesWalked: files.length };
}

test("consolidation: no <button>/<a>/<Link> outside action-button.tsx re-declares the secondary or destructive pair", () => {
  const { violations } = scanConsolidation();
  if (violations.length > 0) {
    assert.fail(`${violations.length} re-declared secondary/destructive site(s):\n${violations.join("\n")}`);
  }
});

test("presence floor: action-button.tsx defines both the secondary and destructive pair", () => {
  assert.ok(fs.existsSync(PRIMITIVE_DEFINITION_FILE), "expected board/components/shared/action-button.tsx to exist");
  const raw = fs.readFileSync(PRIMITIVE_DEFINITION_FILE, "utf8");
  const literals = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    literals.some((lit) => hasSecondaryPair(classTokens(lit))),
    "expected a string literal in action-button.tsx to carry both border-ink-200 and hover:bg-white",
  );
  assert.ok(
    literals.some((lit) => hasDestructivePair(classTokens(lit))),
    "expected a string literal in action-button.tsx to carry both border-rose-200 and text-rose-600",
  );
});

test("vacuous-pass floor: the consolidation walk actually reaches a meaningful number of files", () => {
  const { filesWalked } = scanConsolidation();
  assert.ok(filesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${filesWalked}`);
});

// ── Assertion 2 — visibility ──────────────────────────────────────────────────────────────────

const GROUP_HOVER_REVEAL_RE = /^group-hover(\/[A-Za-z0-9_-]+)?:opacity-100$/;

// Keyed on basename + the EXACT joined class-string (C1/C3) — never file+line. These are the
// three sites §A of the plan verified as decoration, byte-unchanged by this unit: two drag-grip
// hints (both aria-hidden) and one calendar "add event" hint.
const DECORATIVE_ALLOWLIST = [
  {
    file: "strategy-view.tsx",
    classString: "shrink-0 -ml-1 text-ink-300 opacity-0 group-hover:opacity-100 transition",
  },
  {
    file: "strategy-view.tsx",
    classString: "shrink-0 -ml-2 text-ink-300 opacity-0 group-hover/leaf:opacity-100 transition",
  },
  {
    file: "calendar-view.tsx",
    classString: "w-3 h-3 ml-auto text-ink-300 opacity-0 group-hover:opacity-100 transition",
  },
];

function allowlistKey(file, classString) {
  return `${file} ${classString}`;
}

function scanVisibility() {
  const files = walkTsx(ROOTS);
  const violations = [];
  const allowlistHits = new Map(DECORATIVE_ALLOWLIST.map((e) => [allowlistKey(e.file, e.classString), 0]));

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const basename = path.basename(file);
    // Any opening tag (C1) — derive the file's own tag-name list rather than a fixed
    // button/a/Link set, so a non-button carrier (strategy-view.tsx's <div> cluster) is reached.
    const tagNames = [...new Set([...src.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))];

    for (const { tag, attrText, line } of openingTags(src, tagNames)) {
      const { fragments, resolved } = classNameStrings(attrText, src);
      if (!resolved) continue; // unresolvable dynamic className — invisible to this assertion (see header)

      const joined = fragments.join(" ");
      const tokens = classTokens(joined);
      if (!tokens.includes("opacity-0")) continue;
      if (!tokens.some((t) => GROUP_HOVER_REVEAL_RE.test(t))) continue;
      if (tokens.includes("pointer-coarse:opacity-100")) continue;

      const key = allowlistKey(basename, joined);
      if (allowlistHits.has(key)) {
        allowlistHits.set(key, allowlistHits.get(key) + 1);
        continue;
      }
      violations.push(`${relPath(file)}:${line} — <${tag}> className="${joined}"`);
    }
  }
  return { violations, filesWalked: files.length, allowlistHits };
}

test("visibility: every opacity-0 + group-hover reveal outside the decorative allowlist also carries pointer-coarse:opacity-100", () => {
  const { violations } = scanVisibility();
  if (violations.length > 0) {
    assert.fail(`${violations.length} hover-only control(s) with no coarse-pointer route:\n${violations.join("\n")}`);
  }
});

test("decorative allowlist stays live: each of the three entries matches exactly once", () => {
  const { allowlistHits } = scanVisibility();
  for (const entry of DECORATIVE_ALLOWLIST) {
    const hits = allowlistHits.get(allowlistKey(entry.file, entry.classString));
    assert.equal(
      hits,
      1,
      `expected the ${entry.file} decorative allowlist entry to match exactly once, matched ${hits}:\n  "${entry.classString}"`,
    );
  }
});

test("vacuous-pass floor: the any-tag visibility walk actually reaches a meaningful number of files", () => {
  const { filesWalked } = scanVisibility();
  assert.ok(filesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${filesWalked}`);
});
