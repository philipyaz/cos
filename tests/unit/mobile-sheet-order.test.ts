// A5 (cos-ops#122): on the phone, the More sheet rendered Search + daily remainder, then the WHOLE
// Review group (SYSTEM_NAV — the group nav.ts's own comment ranks "visit less often"), then the 11
// add-on rows. The sheet caps at max-h-[75dvh] with 44px coarse rows, so the fold landed between
// /body and /nutrition/log at every plausible iPhone viewport: all four Nutrition and all six
// Fitness rows sat below it, behind 228px of Activity/Trash/Security/Backups/Devices. The fix is a
// pure presentation reorder — daily -> add-ons -> system — stated once as MOBILE_SHEET_SECTIONS in
// board/lib/nav.ts and rendered from that constant in mobile-nav.tsx.
//
// C1 (pm-applicative-review, binding): the original AC 5 asked for a SOURCE-ORDER assertion over
// mobile-nav.tsx. That is red on a correct build (reorder the block definitions) and green on a
// restored defect (flip the constant without moving JSX), because once AC 2 holds ("mobile-nav.tsx
// renders from the constant and holds no second ordering of its own") the JSX source positions ARE
// the second ordering AC 2 forbids being load-bearing. So this gate pins the CONSTANT's order, and
// deliberately asserts nothing about where SYSTEM_NAV.map/addons.map sit in the file — post-AC-2
// that position decides nothing. Test 1 covers the constant; tests 2-4 cover "mobile-nav.tsx really
// renders from it" without ever reading a source position.
//
// The stated residual (fixed-tab-widths.test.ts's known-shape idiom, per the architect): tests 3-4
// catch a swapped Record value (addons: renderSystemSection) and a duplicated hard-coded block, but
// an edit that swaps the two thunks' whole BODIES while keeping their names — every name lying at
// once — is invisible to any parser-free gate. That shape is deliberate sabotage, not a plausible
// edit, and this is named rather than pretended-covered.
//
// This gate pins only addons < system (AC 1's invariant). `daily`-first is deliberately UNPINNED —
// the Search block carries the sheet's top pt-3, so a future reorder that demotes `daily` should
// re-home that padding; that is a scope question for the future editor, not a defect here.
//
// ADR 0032: this is an ordering/presence assertion, never the deferred layout scorer — the fold
// arithmetic (which pixel the fold lands on) stays in the issue/PR as evidence, not in this gate.
// ADR 0038, fixed-tree direction: every assertion below is validated against the blessed fix's own
// spellings (MOBILE_SHEET_SECTIONS, the named thunks, the Record) — pasting the fix back in clears
// all four tests.
//
// Import surface: Node builtins plus ONLY `stripComments` from ./tsx-controls.mjs — two pinned
// files, so `walkTsxExcept` does not apply (C1's own words).
//
// Run: `node --test tests/unit/mobile-sheet-order.test.ts` — also rides tests/run.sh's
// `tests/unit/*.test.ts` glob (run.sh:545-546); no run.sh edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const NAV_FILE = path.join(REPO_ROOT, "board/lib/nav.ts");
const MOBILE_NAV_FILE = path.join(REPO_ROOT, "board/components/mobile-nav.tsx");

test("nav.ts states the sheet order once — add-ons before system", () => {
  const src = stripComments(fs.readFileSync(NAV_FILE, "utf8"));
  const m = src.match(/export const MOBILE_SHEET_SECTIONS\s*=\s*\[([^\]]*)\]/);
  assert.ok(
    m,
    "board/lib/nav.ts does not declare MOBILE_SHEET_SECTIONS — the sheet order has no single stated home",
  );
  const members = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  for (const want of ["daily", "addons", "system"]) {
    assert.ok(
      members.includes(want),
      `MOBILE_SHEET_SECTIONS is missing "${want}" — a rename/deletion must red here, never pass vacuously (members: [${members.join(", ")}])`,
    );
  }
  assert.ok(
    members.indexOf("addons") < members.indexOf("system"),
    "MOBILE_SHEET_SECTIONS orders system before addons — the phone fold defect (ops#122) is restored",
  );
});

test("mobile-nav renders the sheet from the constant", () => {
  const src = stripComments(fs.readFileSync(MOBILE_NAV_FILE, "utf8"));
  assert.match(
    src,
    /import\s*\{[^}]*MOBILE_SHEET_SECTIONS[^}]*\}\s*from\s*"@\/lib\/nav"/,
    "mobile-nav.tsx does not import MOBILE_SHEET_SECTIONS from @/lib/nav",
  );
  assert.ok(
    src.includes("MOBILE_SHEET_SECTIONS.map("),
    "mobile-nav.tsx does not render the sheet by mapping MOBILE_SHEET_SECTIONS — a hard-coded JSX order is a second ordering (AC 2)",
  );
});

test("presence floor: both section bodies exist exactly once", () => {
  const src = stripComments(fs.readFileSync(MOBILE_NAV_FILE, "utf8"));
  for (const marker of ["SYSTEM_NAV.map(", "addons.map("]) {
    assert.ok(src.includes(marker), `mobile-nav.tsx no longer contains ${marker} — the block was deleted or renamed`);
    assert.equal(
      src.indexOf(marker),
      src.lastIndexOf(marker),
      `mobile-nav.tsx contains ${marker} more than once — a duplicated hard-coded block can restore the ops#122 order while this gate's other assertions stay green`,
    );
  }
});

test("key→body binding: each section key is bound to its matching named thunk", () => {
  const src = stripComments(fs.readFileSync(MOBILE_NAV_FILE, "utf8"));
  assert.match(
    src,
    /daily:\s*renderDailySection\b/,
    "the sheet's daily key is not bound to renderDailySection — a swapped Record value renders the wrong section under a correct-looking key",
  );
  assert.match(
    src,
    /addons:\s*renderAddonsSection\b/,
    "the sheet's addons key is not bound to renderAddonsSection — a swapped Record value renders the ops#122 order with a green constant",
  );
  assert.match(
    src,
    /system:\s*renderSystemSection\b/,
    "the sheet's system key is not bound to renderSystemSection — a swapped Record value renders the ops#122 order with a green constant",
  );
});
