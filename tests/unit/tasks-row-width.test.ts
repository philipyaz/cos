// A5 (cos-ops#133): the /tasks phone row gives the task's own title 0-13 visible characters at
// 390pt (median 10-13, zero on 11-23 of 61 live rows), because CaseChip — shrink-0 with
// max-w-[220px] — takes 220 of the 331px line before the title gets anything (66% of the line).
// This is the EIGHTH A5 scanner gate, and the SECOND to assert the pointer-coarse:min-h-11/
// min-w-11 coarse-target PAIR's presence on an unsized <button> (the first was
// reminders-coarse-target.test.ts, cos-ops#102).
//
// Import surface: Node builtins plus { stripComments, openingTags, classNameStrings, classTokens }
// from ./tsx-controls.mjs. classTokens is the shared token-splitter (cos-ops#103's fold already
// merged it) — used here instead of a locally hand-copied tokensOf, per that reference gate's own
// header license for new work to do exactly this.
//
// C2 (restated, not merely cited — ops#102's own binding correction): this gate resolves
// className with classNameStrings, never attrLiteral alone, and FAILS CLOSED (resolved: false is
// a reported violation, never a silent skip) on every scan below, never `form`-restricted. The
// corollary cuts both ways: it is classNameStrings RESOLVING TabButton's own ternary
// (`:170`, `` className={`… ${active ? "…" : "…"}`} ``) that makes its px-2.5/py-1 padding
// exemption reachable at all under the predicate below — attrLiteral + fail-closed would instead
// report `:170` as a violation on a correct build. Do NOT later tighten this gate to a
// form-restricted resolver the way the button-pair gates did post-cos#169-fold; wide + fail-closed
// is the right reading for "does this tag carry a size token, and is this className statically
// pinned at all".
//
// B1 (pm-applicative-review, binding, carried verbatim from reminders-coarse-target.test.ts): the
// BARE_PADDING/BARE_SIZE exemption predicate below is copied byte-for-byte from that gate, because
// the natural alternative reading of "unsized" (= no min-h/min-w token at all) makes TabButton's
// `:170` a SECOND violation this unit does not fix — red on a correct build. And: px-*/p-* on the
// complete toggle EXEMPTS it from this gate FOREVER — never add a padding token to that site, even
// to centre the icon (centring is Edit C's `inline-flex items-center justify-center` trio's job,
// not padding's). Exempt does not imply 44px either: a padding-exempt button passes this predicate
// unexamined, so a future widening of this gate must never read its green as target-size coverage.
//
// The BARE_* regexes are `^`-anchored, so the fix's own pointer-coarse:* tokens can never match
// them, with or without the bare-token (no `:`) filter below — the filter is defence-in-depth,
// keeping a hypothetical variant-prefixed token (e.g. a future sm:px-1) from being read as sizing
// the resting button.
//
// Scope: board/components/tasks/tasks-view.tsx, deliberately, alone (the ops#86/#94/#98/#102
// gate-scope trap). case-detail-drawer.tsx's :1411-1417 task toggle is the named, unfixed sibling
// — dated narration, not a population this gate walks.
//
// The chip mechanism: the case-title span goes `hidden sm:inline`, never `sm:inline-flex`, because
// it is a flex ITEM inside CaseChip's <Link>, not a flex container of its own — blockification
// makes `inline` render-identical to today at >=sm, while `inline-flex` would mint a flex container
// it never was (reminders-view.tsx:403/:424 + shared/drawer.tsx:70 are the `hidden sm:inline`
// precedent for elements that lay out nothing; reminders-view.tsx:360/:382 + trash-view.tsx:281
// are the `hidden sm:inline-flex` precedent for elements that carry items-center/gap-* and
// genuinely arrange children). A deliberate future change of the display value amends this gate
// consciously.
//
// Markers: the chip assertions below are anchored on "function CaseChip(" -> "function
// OpenTaskRow(" with uniqueness pins (indexOf === lastIndexOf), never on line numbers. The stated
// residual is a wholesale body swap that keeps both markers correct and unique — no parser-free
// gate can see that.
//
// Key -> body binding: inside the CaseChip slice, a <span> carrying `truncate` and NOT
// `tabular-nums` identifies the case-title span; a <span> carrying `tabular-nums` identifies the
// caseId span. A span that ever carried BOTH keys would be an id span that also truncates — the
// `tabular-nums` key wins and that span must stay visible (never `hidden`), which is why the
// title-span check below explicitly excludes `tabular-nums`. Without that exclusion, a future
// caseId span that gains `truncate` (e.g. for a longer id) would satisfy both this test's title key
// and its id key at once and make the two halves mutually unsatisfiable — red on a correct build,
// ADR 0038's named mirror error. A future author who adds `truncate` to the id span should read
// this paragraph and know why the gate still passes; one who renames either identifying token
// amends this gate consciously.
//
// ADR 0032: asserts class-token PRESENCE compatible with the issue's own shipped mechanism, not
// the deferred "gate that scores design quality" scorer. ADR 0038, both directions: green on the
// fixed tree, and still capable of failing — reverting any ONE of the three edited class strings
// (the chip cap, the title span, or the toggle) reds its own test naming that site.
//
// Run: `node --test tests/unit/tasks-row-width.test.ts` (also rides tests/run.sh's
// tests/unit/*.test.ts glob, run.sh:516/:545-546 — no run.sh edit; three open PRs already
// conflict on that file and this gate needs none of it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, openingTags, classNameStrings, classTokens } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE = "board/components/tasks/tasks-view.tsx";

const BARE_PADDING = /^(p|px|py|pt|pb|pl|pr)-/; // B1: verbatim from reminders-coarse-target.test.ts
const BARE_SIZE = /^(w|h|min-w|min-h|size)-/; // B1: verbatim
const REQUIRED = ["pointer-coarse:min-h-11", "pointer-coarse:min-w-11"];
const CHIP_START = "function CaseChip("; // marker-anchored, never line numbers
const CHIP_END = "function OpenTaskRow(";

function readStripped(): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, FILE), "utf8");
  return stripComments(raw);
}

/** The CaseChip function body — marker-anchored (never line numbers), with a uniqueness pin
 * that closes the duplicate-hardcoded-block route. `src` must already be stripComments-ed. */
function chipSlice(src: string): string {
  const startIdx = src.indexOf(CHIP_START);
  const startLastIdx = src.lastIndexOf(CHIP_START);
  assert.ok(startIdx !== -1, `expected marker "${CHIP_START}" in ${FILE}`);
  assert.equal(
    startIdx,
    startLastIdx,
    `expected exactly one "${CHIP_START}" marker in ${FILE} (duplicate-hardcoded-block guard)`,
  );

  const endIdx = src.indexOf(CHIP_END);
  const endLastIdx = src.lastIndexOf(CHIP_END);
  assert.ok(endIdx !== -1, `expected marker "${CHIP_END}" in ${FILE}`);
  assert.equal(
    endIdx,
    endLastIdx,
    `expected exactly one "${CHIP_END}" marker in ${FILE} (duplicate-hardcoded-block guard)`,
  );

  assert.ok(startIdx < endIdx, `expected "${CHIP_START}" to precede "${CHIP_END}" in ${FILE}`);
  return src.slice(startIdx, endIdx);
}

function scanButtons(src: string): { violations: string[]; tagCount: number } {
  const tags = openingTags(src, ["button"]);
  const violations: string[] = [];

  for (const { attrText, line } of tags) {
    const r = classNameStrings(attrText, src);
    if (!r.resolved) {
      violations.push(`${FILE}:${line} — className not statically resolvable; this gate fails closed (C2)`);
      continue;
    }
    const tokens = classTokens(r.fragments.join(" "));
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

test("gate: every unsized <button> in tasks-view.tsx carries the coarse-pointer pair", () => {
  const src = readStripped();
  const { violations } = scanButtons(src);
  if (violations.length > 0) {
    assert.fail(
      `${violations.length} unsized <button> site(s) missing the coarse-pointer pair:\n${violations.join("\n")}`,
    );
  }
});

test("gate: the chip's case-title span is hidden below sm and the caseId span stays visible", () => {
  const src = readStripped();
  const slice = chipSlice(src);
  const spans = openingTags(slice, ["span"]);

  const titleSpans: string[] = [];
  const idSpans: string[] = [];
  let i = 0;
  for (const { attrText } of spans) {
    const r = classNameStrings(attrText, src);
    assert.ok(
      r.resolved,
      `expected <span> #${i} in the CaseChip slice of ${FILE} to have a statically resolvable className; this gate fails closed (C2)`,
    );
    const tokens = classTokens(r.fragments.join(" "));
    // Key -> body binding (see header): tabular-nums identifies the caseId span; truncate
    // WITHOUT tabular-nums identifies the case-title span. A span carrying both is an id span
    // that truncates, and the tabular-nums key wins — it must stay visible, never hidden.
    const isIdSpan = tokens.includes("tabular-nums");
    const isTitleSpan = tokens.includes("truncate") && !isIdSpan;

    if (isIdSpan) {
      idSpans.push(attrText);
      assert.ok(
        !tokens.includes("hidden"),
        `expected the caseId span (<span> #${i}, CaseChip slice of ${FILE}) to never carry "hidden" — the chip must show the caseId at every width (AC 1)`,
      );
    }
    if (isTitleSpan) {
      titleSpans.push(attrText);
      assert.ok(
        tokens.includes("hidden") && tokens.includes("sm:inline"),
        `expected the case-title span (<span> #${i}, CaseChip slice of ${FILE}) to carry both "hidden" and "sm:inline", got: ${tokens.join(" ")}`,
      );
    }
    i++;
  }

  assert.ok(
    titleSpans.length >= 1,
    `expected >=1 case-title span (truncate, not tabular-nums) in the CaseChip slice of ${FILE}`,
  );
  assert.ok(idSpans.length >= 1, `expected >=1 caseId span (tabular-nums) in the CaseChip slice of ${FILE}`);
});

test("gate: the chip's <Link> cap is sm-prefixed, never bare", () => {
  const src = readStripped();
  const slice = chipSlice(src);
  const links = openingTags(slice, ["Link"]);
  assert.ok(links.length >= 1, `expected >=1 <Link> tag in the CaseChip slice of ${FILE}, got ${links.length}`);

  let i = 0;
  for (const { attrText } of links) {
    const r = classNameStrings(attrText, src);
    assert.ok(
      r.resolved,
      `expected <Link> #${i} in the CaseChip slice of ${FILE} to have a statically resolvable className; this gate fails closed (C2)`,
    );
    const tokens = classTokens(r.fragments.join(" "));
    assert.ok(
      tokens.includes("sm:max-w-[220px]"),
      `expected <Link> #${i} in the CaseChip slice of ${FILE} to carry "sm:max-w-[220px]", got: ${tokens.join(" ")}`,
    );
    assert.ok(
      !tokens.includes("max-w-[220px]"),
      `expected <Link> #${i} in the CaseChip slice of ${FILE} to NOT carry the bare "max-w-[220px]" (whole-token compare — sm:max-w-[220px] can never substring-satisfy this), got: ${tokens.join(" ")}`,
    );
    i++;
  }
});

test("loud existence: the file exists and is non-empty", () => {
  const full = path.join(REPO_ROOT, FILE);
  assert.ok(fs.existsSync(full), `expected ${FILE} to exist`);
  assert.ok(fs.readFileSync(full, "utf8").length > 0, `expected ${FILE} to be non-empty`);
});

test("vacuous-pass floor: button and chip populations are non-zero", () => {
  const src = readStripped();
  const { tagCount } = scanButtons(src);
  assert.ok(tagCount >= 2, `expected >=2 <button> tags in ${FILE}, got ${tagCount}`);

  const slice = chipSlice(src);
  const links = openingTags(slice, ["Link"]);
  const spans = openingTags(slice, ["span"]);
  assert.ok(links.length >= 1, `expected >=1 <Link> tag in the CaseChip slice of ${FILE}, got ${links.length}`);
  assert.ok(spans.length >= 2, `expected >=2 <span> tags in the CaseChip slice of ${FILE}, got ${spans.length}`);
});
