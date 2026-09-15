// A5 (cos-ops#102): the Reminders tab's phone row gives the reminder's own title 0-53px of a
// 331px row (seven of eight children are shrink-0 chips), and its completion toggle is a
// 16.0x16.0px <button> with no pointer-coarse floor — a missed tap opens the edit drawer instead
// of completing the reminder. This is the SEVENTH A5 scanner gate, and the first to assert the
// pointer-coarse:min-h-11/min-w-11 coarse-target PAIR's presence on an unsized <button>.
//
// C1 (pm-applicative-review, binding): no shared primitive fits — every action-button.tsx export
// carries border/rounded/hover-box chrome a bare icon toggle must not gain, and routing through
// one would swap this <button> for a <SecondaryButton>, removing the site from this gate's own
// openingTags(src, ["button"]) walk and redding the >=2 floor below. The toggle's existing class
// string is edited in place instead.
//
// C2 (pm-applicative-review, binding): this gate resolves className with classNameStrings, not
// attrLiteral. attrLiteral is the weakest resolver in the tree — null on a template literal, a
// ternary or a spread, silently skipped by a naive caller — and reminders-view.tsx already
// spells five OTHER classNames in this same file as ternaries/templates; the next <button>
// written in the file's own idiom would be invisible to attrLiteral, and the gate would go green
// on an unfixed tree. classNameStrings is identical to attrLiteral on a direct literal (it calls
// attrLiteral first and returns early) and FAILS CLOSED (resolved: false) on anything it cannot
// pin — a resolved: false is a reported violation here, never a silent skip.
//
// Scope: this ONE file, deliberately. The same rule run over the six fixed-tab-view files is red
// at ten sites at cos main@defe2c7 (dated narration, not an assertion this gate makes or a
// population it walks): inbox-view.tsx 437/529/661/750/906, board-view.tsx 1247/1254,
// case-card.tsx 187 + 220-unresolved, and this file's own 316 — nine of which this unit does not
// fix, so a wider file set is red on the correct build (the ops#86/#94/#98 gate-scope trap).
//
// Import surface: Node builtins plus ONLY { stripComments, openingTags, classNameStrings } from
// ./tsx-controls.mjs. stripComments/openingTags are byte-identical, and classNameStrings is
// return-compatible (cos#169's still-open fold only ADDS a `form` field to the return value; the
// fragments/resolved computation itself is untouched), on both sides of that PR — so this gate is
// green whichever of cos#169 / this PR merges first. Consume only `fragments` + `resolved`; never
// read `form` (post-fold-only). The whole-token split below restates fixed-tab-widths.test.ts's /
// primary-action.test.ts's own local pattern purely for that same merge-order independence — once
// cos#169 lands, folding it into the shared classTokens/hasAllTokens is a licensed one-line
// cleanup this sentence authorizes, not a silent residue. Do NOT later tighten this gate to a
// `form`-restricted resolver the way the two button-pair gates did post-fold — C2 wants this one
// wide + fail-closed: every reachable fragment is the right reading for "is this button unsized,
// and does it carry the coarse pair".
//
// ADR 0032: asserts class-token PRESENCE compatible with the issue's own shipped mechanism, not
// the deferred "gate that scores design quality (contrast, target size, token coverage)".
//
// ADR 0038, both directions: validated on the FIXED tree (the trio+pair toggle string: 0
// violations, the >=2 floor holds) and still capable of failing (restore the pair-less string ->
// exactly one violation, naming :316). The BARE_* regexes below are `^`-anchored, so they already
// cannot match the fix's own `pointer-coarse:min-w-11` (a token starting `pointer-` never matches
// `^(w|h|min-w|min-h|size)-`) WITH OR WITHOUT the bare-token (no `:`) filter — the filter is
// defence-in-depth, not the reason self-exemption can't happen; its real job is keeping a
// VARIANT-prefixed padding/size token (a hypothetical `sm:px-1`, `hover:p-2`) from being read as
// sizing the resting button. Two facts stated here rather than left to be rediscovered: `px-*`/
// `p-*` on the toggle EXEMPTS it from this gate — do not add a padding token to that site, ever,
// even to centre the icon (alert.tsx:62's DISMISS_CLASS is the nearest chrome precedent in the
// tree and carries `px-1`; do not copy that part). And exempt does not mean 44px — a button sized
// by something else (a `w-5 h-5` box elsewhere in the tree) passes this predicate unexamined, so a
// future widening of this gate must not read its green as target-size coverage.
//
// Run: `node --test tests/unit/reminders-coarse-target.test.ts` (also rides tests/run.sh's
// tests/unit/*.test.ts glob, run.sh:510/:539-540 — no run.sh edit; three open PRs already
// conflict on that file and this gate needs none of it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, openingTags, classNameStrings } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "board/components/reminders/reminders-view.tsx";

const BARE_PADDING = /^(p|px|py|pt|pb|pl|pr)-/;
const BARE_SIZE = /^(w|h|min-w|min-h|size)-/;
const REQUIRED = ["pointer-coarse:min-h-11", "pointer-coarse:min-w-11"];

/** Every whitespace-delimited class token across the union of `classNameStrings`'s reachable
 * fragments — whole-token compare, never a substring (so e.g. a hypothetical `min-w-11/2` would
 * never match `min-w-11`). */
function tokensOf(fragments: string[]): string[] {
  return fragments.join(" ").split(/\s+/).filter(Boolean);
}

function scanButtons(): { violations: string[]; tagCount: number } {
  const raw = fs.readFileSync(path.join(REPO_ROOT, FILE), "utf8");
  const src = stripComments(raw);
  const tags = openingTags(src, ["button"]);
  const violations: string[] = [];

  for (const { attrText, line } of tags) {
    const r = classNameStrings(attrText, src);
    if (!r.resolved) {
      violations.push(`${FILE}:${line} — className not statically resolvable; this gate fails closed (C2)`);
      continue;
    }
    const tokens = tokensOf(r.fragments);
    const bare = tokens.filter((w) => !w.includes(":"));
    const exempt = bare.some((w) => BARE_PADDING.test(w) || BARE_SIZE.test(w));
    if (!exempt) {
      const missing = REQUIRED.filter((q) => !tokens.includes(q));
      if (missing.length > 0) {
        violations.push(`${FILE}:${line} — unsized <button> missing ${missing.join(", ")}`);
      }
    }
  }
  return { violations, tagCount: tags.length };
}

test("gate: every unsized <button> in reminders-view.tsx carries the coarse-pointer pair", () => {
  const { violations } = scanButtons();
  if (violations.length > 0) {
    assert.fail(
      `${violations.length} unsized <button> site(s) missing the coarse-pointer pair:\n${violations.join("\n")}`,
    );
  }
});

test("loud existence: the file exists and is non-empty", () => {
  const full = path.join(REPO_ROOT, FILE);
  assert.ok(fs.existsSync(full), `expected ${FILE} to exist`);
  assert.ok(fs.readFileSync(full, "utf8").length > 0, `expected ${FILE} to be non-empty`);
});

test("vacuous-pass floor: the walk found at least 2 <button> opening tags", () => {
  const { tagCount } = scanButtons();
  assert.ok(tagCount >= 2, `expected >=2 <button> tags in ${FILE}, got ${tagCount}`);
});
