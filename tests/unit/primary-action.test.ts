// A5 (cos-ops#83): the board's primary action (`bg-ink-900 text-white`) must live in exactly one
// place — board/components/shared/action-button.tsx — not be re-declared at any <button>/<a>/
// <Link> call site. This is the CONSOLIDATION half of the issue; the coarse-pointer >=44px target
// claim is carried by the PR body's per-control statement (AC 2) and DoD 6, not by a gate here.
//
// C1 (pm-applicative-review, binding): the issue's original gate (i) — a computed-height
// assertion over the base class string — was DROPPED. It goes red on the correct fix: the
// blessed mechanism (`pointer-coarse:min-h-11`) deliberately leaves the BASE string at its
// existing 26px-equivalent and only raises the box under `@media (pointer: coarse)`, so scoring
// height from the base classes would fail a good build. It is also close enough to ADR 0032's
// deferred "gate that scores design quality (contrast, target size, token coverage)" to be worth
// not building on A5's first slice. Gate (ii) below — the one that ships — has neither problem:
// it is mechanism-agnostic and deletion-shaped, which is what ADR 0032 says A5 owes T1.
//
// Deliberately NOT scanned: template/ternary classNames (the census's own floor — segmented/
// selected-state styling, e.g. body-profile-drawer.tsx's unit toggle
// `` `text-[12px] px-3 py-1.5 ${unit === u ? "bg-ink-900 text-white" : "..."}` ``, is not a button
// spelling; scanning it would flag one of the ~14 deliberate sites the issue excludes). So this
// gate acts only on the two STATIC `form`s tsx-controls.mjs's `classNameStrings` reports —
// `form === "literal"` (a bare `className="…"`) or `form === "const"` (`className={IDENT}`
// resolving to a plain same-file string const) — never its wider template/ternary resolution,
// which is the right choice for the sibling text-entry-size gate but the wrong one here.
//
// Token-boundary trap (named in the census): `spoke-chip.tsx:41` carries `bg-ink-900/90` — a
// DIFFERENT Tailwind token. Matching must compare whole whitespace-delimited tokens, never a
// substring.
//
// Non-interactive carriers of the same pair, named so a future wider matcher doesn't "discover"
// them as missed sites: inbox-view.tsx's count badge (a <span>) and avatar circle (a <div>) carry
// the pair but are tag-excluded (this gate only walks <button>/<a>/<Link>); board-view.tsx's bulk
// toolbar and toast are <div>s carrying the same palette for chrome, not tap targets — also
// tag-excluded. `vault-view.tsx`'s Obsidian deep-link is the one real primary action that is an
// <a> rather than a <button> — it IS in scope here (an <a> styled as a primary action would
// otherwise escape a buttons-only matcher; this one does not, since <a> is walked too).
//
// Run: `node --test tests/unit/primary-action.test.ts` (also rides `tests/run.sh`'s
// `tests/unit/*.test.ts` glob — no run.sh edit needed).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, openingTags, classNameStrings, classTokens, walkTsxExcept } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [path.join(REPO_ROOT, "board/components"), path.join(REPO_ROOT, "board/app")];

// The primitive's OWN definition file is not a call site — walked out via walkTsxExcept, the
// same EFFECT as field.tsx's exclusion in text-entry-size.test.ts but not the same mechanism:
// that gate keeps its own inline filter (cos-ops#103, Correction 2), this one routes through the
// shared helper. Here the exclusion is belt-and-braces rather than load-bearing:
// PrimaryButton/PrimaryLink's className is `className ? \`${PRIMARY_CLASS} ${className}\` :
// PRIMARY_CLASS` — a bare ternary whose branches are a template and an identifier, i.e.
// `form: "expr"` from classNameStrings, which this gate's static-only check (below) never acts
// on, so it already reports nothing here. Excluding the file anyway keeps the AC's own "outside
// action-button.tsx" wording literally true rather than true by accident of today's exact source
// shape.
const PRIMITIVE_DEFINITION_FILE = path.join(REPO_ROOT, "board/components/shared/action-button.tsx");

function relPath(file) {
  return path.relative(REPO_ROOT, file);
}

function hasPrimaryActionPair(classString) {
  const tokens = classTokens(classString);
  return tokens.includes("bg-ink-900") && tokens.includes("text-white");
}

function scanButtonSites() {
  const files = walkTsxExcept(ROOTS, [PRIMITIVE_DEFINITION_FILE]);
  const violations = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const { tag, attrText, line } of openingTags(src, ["button", "a", "Link"])) {
      const { fragments, resolved, form } = classNameStrings(attrText, src);
      // Static forms only (see header): a template/ternary className is segmented state-arm
      // styling, not a button spelling — measured 2026-09-15: acting on resolved templates here
      // flags 7 deliberate selected-state sites.
      if ((form !== "literal" && form !== "const") || !resolved) continue;
      const lit = fragments.join(" ");
      if (hasPrimaryActionPair(lit)) {
        violations.push(`${relPath(file)}:${line} — <${tag}> className="${lit}"`);
      }
    }
  }
  return { violations, filesWalked: files.length };
}

test("consolidation: no <button>/<a>/<Link> outside action-button.tsx re-declares the primary-action pair", () => {
  const { violations } = scanButtonSites();
  if (violations.length > 0) {
    assert.fail(`${violations.length} re-declared primary-action site(s):\n${violations.join("\n")}`);
  }
});

test("presence floor: action-button.tsx exists and defines the primary-action pair", () => {
  assert.ok(fs.existsSync(PRIMITIVE_DEFINITION_FILE), "expected board/components/shared/action-button.tsx to exist");
  const raw = fs.readFileSync(PRIMITIVE_DEFINITION_FILE, "utf8");
  const literals = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    literals.some((lit) => hasPrimaryActionPair(lit)),
    "expected a string literal in action-button.tsx to carry both bg-ink-900 and text-white",
  );
});

test("vacuous-pass floor: the walk actually reaches a meaningful number of files", () => {
  const { filesWalked } = scanButtonSites();
  assert.ok(filesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${filesWalked}`);
});
