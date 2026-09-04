#!/usr/bin/env node
// tests/nutrition-status-consumers.mjs — the ADR 0014 gate: every top-level field the nutrition
// status engine (`NutritionStatus` in board/lib/nutrition-status.ts) returns must be CONSUMED —
// given a defined action, or an explicit state-and-move-on — by JOB 0 of nutrition-chef/SKILL.md,
// the job that reads the status FIRST on every invocation. A field the engine computes and no job
// ever reads is exactly the defect cos-ops#18 measured: the board answers a question nobody asks.
//
// Static, read-only, zero deps — parses the `NutritionStatus` interface by TEXT (no TS compiler)
// to get the field list, and greps ONLY JOB 0's own section of SKILL.md, not the whole file: a
// whole-file grep passes on incidental mentions (an example line, a parenthetical) — the exact
// shape of the pre-change bug — while the acceptance criterion is that JOB 0 itself consumes the
// field. Fails loudly if fewer than 9 keys parse, so a refactor that moves the interface or drops
// a key breaks THIS test rather than silently passing it with a shrunken field list.
//
//   node tests/nutrition-status-consumers.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const ENGINE_FILE = join(REPO_ROOT, "board", "lib", "nutrition-status.ts");
const SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "nutrition-chef", "SKILL.md");
const MIN_KEYS = 9; // the post-change field count — see the header comment above.

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- extract the NutritionStatus interface's top-level field names, by text -------------------
const engineSrc = readFileSync(ENGINE_FILE, "utf8");
const ifaceMatch = engineSrc.match(/export interface NutritionStatus \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  console.error(
    `[nutrition-status-consumers] could not find 'export interface NutritionStatus { … }' in ${ENGINE_FILE}`,
  );
  process.exit(1);
}
// A top-level field is a line indented by EXACTLY two spaces (nested sub-fields, e.g. inside
// `pantryLifecycle: { … }`, are indented four+ and so never match this).
const keys = [...ifaceMatch[1].matchAll(/^\s\s(\w+):/gm)].map((m) => m[1]);

check(
  keys.length >= MIN_KEYS,
  `NutritionStatus parses >= ${MIN_KEYS} top-level fields (got ${keys.length}: ${keys.join(", ")}) — ` +
    `a refactor that moves the interface or drops a field must fail this test, not silently pass it`,
);

// --- extract JOB 0's own section of SKILL.md ----------------------------------------------------
const skillSrc = readFileSync(SKILL_FILE, "utf8");
const job0Match = skillSrc.match(/## JOB 0[\s\S]*?\n---\n/);
if (!job0Match) {
  console.error(
    `[nutrition-status-consumers] could not find a '## JOB 0 … \\n---\\n' section in ${SKILL_FILE}`,
  );
  process.exit(1);
}
const job0 = job0Match[0];

// --- every engine field must be consumed (named) inside JOB 0 — nowhere else in the file counts -
for (const key of keys) {
  check(
    job0.includes(key),
    `JOB 0 consumes '${key}' (a defined action, or an explicit state-and-move-on) — not found as a ` +
      `literal substring of the JOB 0 section (an incidental mention elsewhere in SKILL.md does not count)`,
  );
}

// --- deposit-step contract, cos-ops#67: the close-out DEPOSIT — three tool identifiers
// (case-sensitive plain substring, matching this file's existing field-check style above)
// plus two canonical guardrail phrases that must land VERBATIM. Those two are long enough
// to wrap at this file's line width, so they're matched with a whitespace/hyphen-tolerant
// regex built from the phrase's own words, not a literal substring.
const phraseRe = (phrase) =>
  new RegExp(
    phrase
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]+"),
    "i",
  );
for (const tool of ["create_reminder", "update_reminder", "complete_reminder"]) {
  check(job0.includes(tool), `JOB 0 names '${tool}' (the close-out deposit, cos-ops#67)`);
}
for (const phrase of [
  "keep exactly one open close-out reminder — find it by its exact title and update it in place; never mint a second",
  "a clean run deposits nothing",
]) {
  check(phraseRe(phrase).test(job0), `JOB 0 states (wrap-tolerantly) '${phrase}'`);
}

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS — JOB 0 consumes all ${keys.length} NutritionStatus fields.`);
