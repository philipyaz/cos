#!/usr/bin/env node
// tests/fitness-outcome-consumers.mjs — the ADR 0014 gate (cos-ops#19): every top-level field
// the fitness plan-reconciliation engine (`PlanReconciliation` in board/lib/fitness-plan-status.ts)
// returns must be CONSUMED — by name — inside fitness-training-plan/SKILL.md's own weekly
// close-out section; `unresolvedDays` must ALSO be consumed inside
// fitness-pre-workout-brief/SKILL.md's daily close-out section. A field the engine computes and
// no close-out ever reads is exactly the defect cos-ops#18 measured on the nutrition side —
// this is that same gate's fitness twin (clones its parser mechanics exactly).
//
// Also carries two things that are NOT field-derived, because they aren't fields:
//   - a small, section-scoped set of FIXED load-bearing phrases (the batching / never-fabricate
//     / no-second-code-path / local-busy-windows-statement rules) — few, and named individually
//     below so a rewording that drops the underlying RULE breaks this gate, not just a keyword.
//   - the route-vs-tool regex pair, duplicated from tests/api-fitness-plan-outcome.mjs's own
//     in-file check. That api test's assertion lives in a `run.sh` block that SILENTLY SKIPS
//     when no board is up (the BOARD_UP guard) — ADR 0014 names silent skips as the failure
//     mode, so the always-run copy here is the real enforcement; the api test's copy exists
//     only to satisfy the issue's own naming of that file.
//
// Fixed-phrase checks are matched case-INSENSITIVELY (a guardrail phrase is prose — a sentence-
// initial capital is a style choice, not a semantic one). Field names stay CASE-SENSITIVE (they
// are code identifiers). Static, read-only, zero deps.
//
//   node tests/fitness-outcome-consumers.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const ENGINE_FILE = join(REPO_ROOT, "board", "lib", "fitness-plan-status.ts");
const TRAINING_PLAN_FILE = join(REPO_ROOT, "board", ".claude", "skills", "fitness-training-plan", "SKILL.md");
const BRIEF_FILE = join(REPO_ROOT, "board", ".claude", "skills", "fitness-pre-workout-brief", "SKILL.md");
const SERVER_FILE = join(REPO_ROOT, "mcp", "fitness-server", "server.mjs");
const CLIENT_FILE = join(REPO_ROOT, "board", "lib", "fitness-client.ts");
const MIN_KEYS = 4; // the post-change field count — see the header comment above.

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const containsPhrase = (text, phrase) => text.toLowerCase().includes(phrase.toLowerCase());

// --- job 1: extract PlanReconciliation's top-level field names, by text -----------------------
const engineSrc = readFileSync(ENGINE_FILE, "utf8");
const ifaceMatch = engineSrc.match(/export interface PlanReconciliation \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  console.error(`[fitness-outcome-consumers] could not find 'export interface PlanReconciliation { … }' in ${ENGINE_FILE}`);
  process.exit(1);
}
// A top-level field is a line indented by EXACTLY two spaces (nested sub-fields, e.g. inside
// `unresolvedDays: { … }`, are indented four+ and so never match this).
const keys = [...ifaceMatch[1].matchAll(/^\s\s(\w+):/gm)].map((m) => m[1]);
check(
  keys.length >= MIN_KEYS,
  `PlanReconciliation parses >= ${MIN_KEYS} top-level fields (got ${keys.length}: ${keys.join(", ")}) — ` +
    `a refactor that moves the interface or drops a field must fail this test, not silently pass it`,
);

// --- extract the training-plan skill's own weekly close-out section ("### 0.5 …") --------------
const trainingPlanSrc = readFileSync(TRAINING_PLAN_FILE, "utf8");
const closeOutMatch = trainingPlanSrc.match(/### 0\.5 CLOSE OUT last week[\s\S]*?\n### /);
if (!closeOutMatch) {
  console.error(
    `[fitness-outcome-consumers] could not find a '### 0.5 CLOSE OUT last week … \\n### ' section in ${TRAINING_PLAN_FILE} ` +
      `(a retitle must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const closeOutSection = closeOutMatch[0];

// --- extract the training-plan skill's STEP 4 (rotation) section --------------------------------
const step4Match = trainingPlanSrc.match(/### 4\. FETCH the LAST few plans for ROTATION[\s\S]*?\n### /);
if (!step4Match) {
  console.error(`[fitness-outcome-consumers] could not find the STEP 4 (rotation) section in ${TRAINING_PLAN_FILE}`);
  process.exit(1);
}
const step4Section = step4Match[0];

// --- extract the brief skill's own daily close-out section ("## STEP 1.5 …") -------------------
const briefSrc = readFileSync(BRIEF_FILE, "utf8");
const closeOutYesterdayMatch = briefSrc.match(/## STEP 1\.5[\s\S]*?\n## /);
if (!closeOutYesterdayMatch) {
  console.error(
    `[fitness-outcome-consumers] could not find a '## STEP 1.5 … \\n## ' section in ${BRIEF_FILE} ` +
      `(a retitle must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const closeOutYesterdaySection = closeOutYesterdayMatch[0];

// --- every engine field must be consumed (named) inside the training-plan close-out section ----
for (const key of keys) {
  // The BACKTICKED field reference — plain prose ("record the outcomes") must not satisfy it.
  check(
    closeOutSection.includes("`" + key + "`"),
    `fitness-training-plan's "### 0.5 CLOSE OUT" section consumes '\`${key}\`' — not found as a backticked ` +
      `field reference in that section (an incidental prose mention does not count)`,
  );
}
// `unresolvedDays` is the one field the daily close-out also reads directly.
check(
  closeOutYesterdaySection.includes("unresolvedDays"),
  `fitness-pre-workout-brief's "## STEP 1.5" section also consumes 'unresolvedDays'`,
);

// --- job 2: fixed, load-bearing, SECTION-SCOPED phrases (few, individually named) --------------
for (const phrase of ["set_plan_day_outcome", "provenDone", "one batched", "unattended", "proceed to STEP 1", "keep the old date", "one entry per date"]) {
  check(containsPhrase(closeOutSection, phrase), `the training-plan "### 0.5" section states '${phrase}'`);
}

// --- job 2b: the close-out DEPOSIT contract (cos-ops#67) — three tool identifiers (case-
// sensitive plain substring, like the field checks above — NOT containsPhrase, which is
// case-insensitive and blind to a line wrap) plus two canonical guardrail phrases that must
// land VERBATIM. Those two are long enough to wrap at this file's ~72-col width, so they're
// matched with a whitespace/hyphen-tolerant regex built from the phrase's own words rather
// than a literal substring (ops#68's complaint about this family's exact-substring phrase
// checks going silently blind to a line wrap).
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
  check(
    closeOutSection.includes(tool),
    `the training-plan "### 0.5" section names '${tool}' (the close-out deposit, cos-ops#67)`,
  );
}
for (const phrase of [
  "keep exactly one open close-out reminder — find it by its exact title and update it in place; never mint a second",
  "a clean run deposits nothing",
]) {
  check(
    phraseRe(phrase).test(closeOutSection),
    `the training-plan "### 0.5" section states (wrap-tolerantly) '${phrase}'`,
  );
}
check(
  containsPhrase(trainingPlanSrc, "a rest day OR a `resolved` day — carries an\n`eventId`") ||
    containsPhrase(trainingPlanSrc, "a rest day OR a `resolved` day"),
  "fitness-training-plan/SKILL.md relays a resolved day's stale eventId like a rest day's (offer to remove)",
);
check(containsPhrase(step4Section, "outcomes, not intentions"), `the training-plan STEP 4 section states 'outcomes, not intentions'`);
check(
  containsPhrase(trainingPlanSrc, "never include `status`"),
  "fitness-training-plan/SKILL.md states the re-save discipline: never include `status` (…) in the days you send",
);

for (const phrase of ["set_plan_day_outcome", "provenDone", "busy_windows", "keep the old date", "one entry per date"]) {
  check(containsPhrase(closeOutYesterdaySection, phrase), `the brief's "## STEP 1.5" section states '${phrase}'`);
}
for (const phrase of ["never relocate", "confirmation", "no extra output"]) {
  check(containsPhrase(briefSrc, phrase), `fitness-pre-workout-brief/SKILL.md states '${phrase}'`);
}

// --- job 3: the route-vs-tool regex pair (always-run home; the api test's copy can SKIP) -------
// Anchored to the CODE shape (a template literal ending in /day`), so a doc comment that
// mentions the path cannot satisfy it.
const DAY_ROUTE_RE = /\/api\/fitness\/coaching\/\$\{[^}]+\}\/day`/;
const serverSrc = readFileSync(SERVER_FILE, "utf8");
const clientSrc = readFileSync(CLIENT_FILE, "utf8");
check(DAY_ROUTE_RE.test(serverSrc), "mcp/fitness-server/server.mjs references the /day-suffixed coaching path");
check(DAY_ROUTE_RE.test(clientSrc), "board/lib/fitness-client.ts references the SAME /day-suffixed coaching path");

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — the training-plan + pre-workout-brief close-outs consume all ${keys.length} PlanReconciliation fields, ` +
    `the load-bearing phrases hold, and the route-vs-tool wiring matches.`,
);
