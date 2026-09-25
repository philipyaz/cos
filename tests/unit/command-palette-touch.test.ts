// A5 (cos-ops#141): command-palette.tsx is the board's only human capture route and, at
// 390x844, documented exactly one exit — the Esc key, twice (input-row <kbd>, footer Hint) plus
// arrow-key hints — none of which iOS provides; its only real touch exit was an undocumented
// backdrop onMouseDown, unverified on touch since 2026-09-09. The fix: on coarse pointers the
// whole keyboard-hint footer and the input-row esc <kbd> go pointer-coarse:hidden, and a real
// 44px "Close" button (aria-label="Close", onClick={closePalette}) takes the esc <kbd>'s place;
// below `sm` the dialog docks to y=0 (no pt offset) instead of `pt-[12vh]`; both raw `vh` lengths
// become `dvh`.
//
// Import surface: Node builtins plus ONLY { stripComments, openingTags, classNameStrings } from
// ./tsx-controls.mjs — same three as reminders-coarse-target.test.ts.
//
// Key -> body binding (ADR 0038's keyed-lookup lesson: state which element each assertion binds
// to, not just a constant's order):
//   OVERLAY = the one <div> whose resolved className tokens include fixed + inset-0 + z-50 (the
//     backdrop div is `absolute inset-0`, so it can never collide).
//   LISTBOX = the one <div> whose attrText contains the literal `id="cp-listbox"` (the input's
//     `aria-controls="cp-listbox"` is a different attribute spelling and never matches — "id="
//     must sit immediately before the quote).
//   FOOTER = the one <div> whose resolved tokens include both h-8 and border-t (the input row is
//     h-12 border-b).
//   INPUT-ROW SLICE = src.slice(i, j) between the unique markers `aria-label="Command palette"`
//     and `id="cp-listbox"`. The esc <kbd> and the Close <button> live inside it; the Run kbd
//     (CommandPreview) and the footer Hints' kbds sit outside it.
// Every keyed lookup asserts its own uniqueness (an exact count, or indexOf === lastIndexOf) as a
// forward floor before reading tokens. Those floors are green on `main` today, declared here
// OUTSIDE the ADR 0014 red claim below — the red run is "tests 1-6 fail, 7 passes", never
// "everything fails".
//
// ADR 0038 (both directions): validated on the FIXED tree — every string tests 1-5 look for is
// this plan's own literal edit spec, re-derivable by inspection; and it still fails on the
// unfixed tree (captured by the implementer, never transcribed — ADR 0014).
// ADR 0032: asserts the issue's own shipped mechanism (specific token presence), not the deferred
// design-quality scorer.
// Residual, stated plainly: this gate pins SOURCE TOKENS, not rendered behaviour — a wholesale
// semantic rewrite that happens to keep the same literal tokens would still read green here.
//
// Run: `node --test tests/unit/*.test.ts` (rides tests/run.sh's existing glob — no run.sh edit).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, openingTags, classNameStrings } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "board/components/command-palette.tsx";

// Mirrors tests/viewport-lint.mjs's RAW_VH_RE — keep the two in lockstep. Duplicated rather than
// imported: viewport-lint.mjs is a script with a module-level `process.exit()`, so importing it
// from a test file is not possible.
const RAW_VH_RE = /(?<!\w)\d+(?:\.\d+)?vh(?!\w)/g;

/** Every whitespace-delimited class token across the union of classNameStrings's reachable
 * fragments — whole-token compare, never a substring. */
function tokensOf(fragments: string[]): string[] {
  return fragments.join(" ").split(/\s+/).filter(Boolean);
}

function readSrc(): { raw: string; src: string } {
  const raw = fs.readFileSync(path.join(REPO_ROOT, FILE), "utf8");
  return { raw, src: stripComments(raw) };
}

/** Resolve attrText's className against the FULL file source, failing closed (C2 idiom) rather
 * than skipping silently — a later ternary refactor of a keyed className must red consciously. */
function resolvedTokens(attrText: string, src: string, label: string): string[] {
  const r = classNameStrings(attrText, src);
  assert.ok(r.resolved, `${FILE}: ${label} className is not statically resolvable; this gate fails closed`);
  return tokensOf(r.fragments);
}

function findOverlay(src: string) {
  const matches = openingTags(src, ["div"]).filter((d) => {
    const r = classNameStrings(d.attrText, src);
    if (!r.resolved) return false;
    const tokens = tokensOf(r.fragments);
    return ["fixed", "inset-0", "z-50"].every((t) => tokens.includes(t));
  });
  assert.equal(matches.length, 1, `expected exactly 1 OVERLAY <div> (fixed+inset-0+z-50), got ${matches.length}`);
  return matches[0];
}

function findListbox(src: string) {
  const matches = openingTags(src, ["div"]).filter((d) => d.attrText.includes('id="cp-listbox"'));
  assert.equal(matches.length, 1, `expected exactly 1 LISTBOX <div> (id="cp-listbox"), got ${matches.length}`);
  return matches[0];
}

function findFooter(src: string) {
  const matches = openingTags(src, ["div"]).filter((d) => {
    const r = classNameStrings(d.attrText, src);
    if (!r.resolved) return false;
    const tokens = tokensOf(r.fragments);
    return tokens.includes("h-8") && tokens.includes("border-t");
  });
  assert.equal(matches.length, 1, `expected exactly 1 FOOTER <div> (h-8+border-t), got ${matches.length}`);
  return matches[0];
}

/** src.slice(i, j) between the two unique markers — the input row's span. */
function findInputRowSlice(src: string): string {
  const startMarker = 'aria-label="Command palette"';
  const endMarker = 'id="cp-listbox"';
  const i = src.indexOf(startMarker);
  assert.notEqual(i, -1, `expected to find ${startMarker}`);
  assert.equal(i, src.lastIndexOf(startMarker), `expected exactly 1 occurrence of ${startMarker}`);
  const j = src.indexOf(endMarker);
  assert.notEqual(j, -1, `expected to find ${endMarker}`);
  assert.equal(j, src.lastIndexOf(endMarker), `expected exactly 1 occurrence of ${endMarker}`);
  assert.ok(i < j, `expected ${startMarker} to precede ${endMarker}`);
  return src.slice(i, j);
}

test("1: OVERLAY carries sm:pt-[12dvh] and no unprefixed pt-[...]", () => {
  const { src } = readSrc();
  const overlay = findOverlay(src);
  const tokens = resolvedTokens(overlay.attrText, src, "OVERLAY");
  assert.ok(tokens.includes("sm:pt-[12dvh]"), `expected OVERLAY to carry sm:pt-[12dvh], got: ${tokens.join(" ")}`);
  const unprefixedPt = tokens.filter((t) => /^pt-\[/.test(t));
  assert.equal(unprefixedPt.length, 0, `expected no unprefixed pt-[...] token, got: ${unprefixedPt.join(", ")}`);
});

test("2: LISTBOX carries max-h-[52dvh]", () => {
  const { src } = readSrc();
  const listbox = findListbox(src);
  const tokens = resolvedTokens(listbox.attrText, src, "LISTBOX");
  assert.ok(tokens.includes("max-h-[52dvh]"), `expected LISTBOX to carry max-h-[52dvh], got: ${tokens.join(" ")}`);
});

test("3: FOOTER carries pointer-coarse:hidden", () => {
  const { src } = readSrc();
  const footer = findFooter(src);
  const tokens = resolvedTokens(footer.attrText, src, "FOOTER");
  assert.ok(tokens.includes("pointer-coarse:hidden"), `expected FOOTER to carry pointer-coarse:hidden, got: ${tokens.join(" ")}`);
});

test("4: exactly 1 <kbd> in the input-row slice, carrying pointer-coarse:hidden", () => {
  const { src } = readSrc();
  const slice = findInputRowSlice(src);
  const kbds = openingTags(slice, ["kbd"]);
  assert.equal(kbds.length, 1, `expected exactly 1 <kbd> in the input-row slice, got ${kbds.length}`);
  const tokens = resolvedTokens(kbds[0].attrText, src, "input-row <kbd>");
  assert.ok(
    tokens.includes("pointer-coarse:hidden"),
    `expected the esc <kbd> to carry pointer-coarse:hidden, got: ${tokens.join(" ")}`,
  );
});

test("5: exactly 1 <button> in the input-row slice — Close, wired, sized and gated", () => {
  const { src } = readSrc();
  const slice = findInputRowSlice(src);
  const buttons = openingTags(slice, ["button"]);
  assert.equal(buttons.length, 1, `expected exactly 1 <button> in the input-row slice, got ${buttons.length}`);
  const btn = buttons[0];
  assert.ok(btn.attrText.includes('aria-label="Close"'), `expected the button's aria-label to be exactly "Close"`);
  assert.ok(btn.attrText.includes("closePalette"), `expected the button's attrText to reference closePalette`);
  const tokens = resolvedTokens(btn.attrText, src, "Close button");
  for (const required of ["hidden", "pointer-coarse:inline-flex", "pointer-coarse:min-h-11", "pointer-coarse:min-w-11"]) {
    assert.ok(tokens.includes(required), `expected the Close button to carry ${required}, got: ${tokens.join(" ")}`);
  }
});

test("6: zero raw-vh matches in the raw file text (comments included, mirrors [2c])", () => {
  const { raw } = readSrc();
  const hits = [...raw.matchAll(RAW_VH_RE)].map((m) => {
    const lineNo = raw.slice(0, m.index).split("\n").length;
    return `${FILE}:${lineNo} — ${m[0]}`;
  });
  assert.equal(hits.length, 0, `expected zero raw-vh matches, got:\n${hits.join("\n")}`);
});

test("7: loud existence — the file exists and is non-empty", () => {
  const full = path.join(REPO_ROOT, FILE);
  assert.ok(fs.existsSync(full), `expected ${FILE} to exist`);
  assert.ok(fs.readFileSync(full, "utf8").length > 0, `expected ${FILE} to be non-empty`);
});
