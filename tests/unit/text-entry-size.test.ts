// A5 (cos-ops#82): every text-entry control on the board must resolve to an effective font
// size >= 16px. Mobile Safari zooms the viewport when a focused control's COMPUTED font-size
// is below 16px, and does not zoom back out on blur — the fix is size, never a viewport
// `maximum-scale`/`user-scalable` edit (the documented anti-pattern; WCAG 1.4.4 violation).
//
// The C1 lesson (pm-applicative-review on cos-ops#82): a bare tag-and-regex scan is wrong in
// BOTH directions on this tree. It flags five `<select>`s that are only prose inside comments
// (label-filter.tsx:10, :114; case-detail-drawer.tsx — two comment mentions; artifact-feed.tsx:41), and it
// misses seven real controls sized through same-file indirection a naive scan can't see
// (fitness/overview-view.tsx's five INPUT_CLASS-driven controls; case-detail-drawer.tsx's two
// `common`-spread inline editors). `tsx-controls.mjs` strips comments and resolves same-file
// className constants/spreads/template-interpolations before anything is measured — see its
// header for the exact resolution rules and known floors.
//
// This is ONE platform constant pinned as an ADR-0014 regression test for one issue — not
// ADR 0032's deferred "gate that scores design quality" (contrast, target size, token
// coverage). That gate is explicitly for later, once A5 has shipped enough to know what's
// genuinely mechanical; this one is exactly the mechanical subset that row blesses.
//
// The unprefixed-token rule: `fontSizeTokens` (tsx-controls.mjs) ignores variant-prefixed
// tokens (`md:text-[13px]`, `focus:text-sm`) on purpose — Tailwind's breakpoints are min-width
// and 390px sits below all of them, so the unprefixed token is what the phone renders, and a
// `md:` override on top of an unprefixed >=16px base is the sanctioned desktop-density route.
// Known floor: a `max-*` variant would evade this; nothing in the tree uses one today.
//
// Run: `node --test tests/unit/text-entry-size.test.ts` (also rides `tests/run.sh`'s
// `tests/unit/*.test.ts` glob — no run.sh edit needed).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkTsx, stripComments, openingTags, attrLiteral, classNameStrings, fontSizeTokens } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [path.join(REPO_ROOT, "board/components"), path.join(REPO_ROOT, "board/app")];
const MIN_PX = 16;

// Types whose controls never trigger iOS Safari's zoom-on-focus behaviour.
const EXCLUDED_TYPES = new Set(["checkbox", "radio", "file", "range", "color", "hidden", "button", "submit"]);

// The primitive's OWN definition file is not a call site — its raw <input>/<textarea>/<select>
// tags exist to IMPLEMENT the >=16px floor (CONTROL_CLASS, inspectable three lines above each
// one), not to instantiate it. Their className is `className ? \`${CONTROL_CLASS} ${className}\`
// : CONTROL_CLASS` — a bare ternary whose arms are a template and an identifier, a shape that
// exists ONLY here (every real call site's ternary lives inside a template's `${…}`, which
// classNameStrings does resolve). Excluding this one file keeps the floor assertion about real
// usage; the "prop loophole" assertion below still walks the whole tree for call sites that pass
// a bad override.
const PRIMITIVE_DEFINITION_FILE = path.join(REPO_ROOT, "board/components/shared/field.tsx");

function relPath(file) {
  return path.relative(REPO_ROOT, file);
}

function scanRawControls() {
  const files = walkTsx(ROOTS).filter((f) => f !== PRIMITIVE_DEFINITION_FILE);
  const violations = [];
  let controlCount = 0;
  const filesWithControls = new Set();

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const { attrText, line } of openingTags(src, ["input", "textarea", "select"])) {
      const typeLit = attrLiteral(attrText, "type");
      if (typeLit && EXCLUDED_TYPES.has(typeLit)) continue;

      controlCount++;
      filesWithControls.add(file);

      const { fragments } = classNameStrings(attrText, src);
      const tokens = fragments.flatMap(fontSizeTokens);
      if (tokens.length === 0) {
        violations.push(`${relPath(file)}:${line} — unresolvable className (no literal, no resolvable const/spread, no size token)`);
        continue;
      }
      for (const t of tokens) {
        if (t.px < MIN_PX) violations.push(`${relPath(file)}:${line} — ${t.token} (${t.px}px, needs >=${MIN_PX}px)`);
      }
    }
  }
  return { violations, controlCount, fileCount: filesWithControls.size, totalFilesWalked: files.length };
}

function scanPrimitiveUsages() {
  const files = walkTsx(ROOTS);
  const violations = [];
  let usageCount = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const { tag, attrText, line } of openingTags(src, ["TextInput", "TextArea", "Select"])) {
      usageCount++;
      const { fragments } = classNameStrings(attrText, src);
      const tokens = fragments.flatMap(fontSizeTokens);
      for (const t of tokens) {
        if (t.px < MIN_PX) violations.push(`${relPath(file)}:${line} — <${tag}> className carries ${t.token} (${t.px}px, needs >=${MIN_PX}px)`);
      }
    }
  }
  return { violations, usageCount };
}

test("floor: every raw text-entry control resolves to an explicit size >=16px", () => {
  const { violations, controlCount } = scanRawControls();
  if (violations.length > 0) {
    assert.fail(`${violations.length} sub-16px / unresolvable text-entry control(s):\n${violations.join("\n")}`);
  }
  // Sanity: this assertion must be exercising real controls, not walking an empty tree.
  assert.ok(controlCount > 0, "expected to find at least one text-entry control");
});

test("prop loophole: no <TextInput>/<TextArea>/<Select> usage carries a sub-16px className", () => {
  const { violations } = scanPrimitiveUsages();
  if (violations.length > 0) {
    assert.fail(`${violations.length} sub-16px primitive usage(s):\n${violations.join("\n")}`);
  }
});

test("vacuous-pass floor: the walk actually reaches a meaningful number of controls and files", () => {
  const { controlCount, fileCount, totalFilesWalked } = scanRawControls();
  const { usageCount } = scanPrimitiveUsages();
  assert.ok(
    controlCount + usageCount >= 70,
    `expected >=70 control instances (raw + primitive), got ${controlCount + usageCount}`,
  );
  assert.ok(fileCount >= 15, `expected raw controls across >=15 files, got ${fileCount}`);
  assert.ok(totalFilesWalked >= 40, `expected to walk >=40 .tsx/.ts files, got ${totalFilesWalked}`);
});
