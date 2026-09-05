#!/usr/bin/env node
// tests/triage-decisions-consumers.mjs — the ADR 0014 gate (cos-ops#41): every top-level field
// the triage-decisions engine (`TriageDecisionSummary` in board/lib/triage-decisions.ts) returns,
// and every triage tool the board MCP server actually registers, must be CONSUMED — by name — by
// the two skills that produce and review the mail-triage editorial-drop decision record. A field
// or tool the code carries and no skill ever reads/names is exactly the defect cos-ops#18
// measured on the nutrition side — this is that gate's triage-decisions twin (clones
// tests/nutrition-status-consumers.mjs's + tests/shopping-list-consumers.mjs's parser
// mechanics). Rides the existing `[2f]` run.sh step id with its own echo line and its own
// `fail_reasons` token, rather than minting a new `[2*]` id — cos-ops#21's direction for a
// parser-grade, no-new-test-step addition (two in-flight siblings, #94 and #98, already do the
// same); NOT cited as "ADR 0022" (that ADR's subject is pack-skills owning generated skill
// artifacts, a different question — a plan-time miscitation this file does not repeat).
//
// Also carries the record-before-watermark ORDER check (criterion 5): within mail-to-board's own
// drop region, the first mention of `record_triage_decision` must PRECEDE the first mention of
// `cos/processed` — a mechanical proxy for "record, then watermark" that a reordering edit would
// trip.
//
// Also carries (cos-ops#72) the digest's zero-drops BRANCH contract: the empty-ledger render
// in server.mjs must interpolate summary.promoted (the only carrier the digest ever sees) and
// open with the "No drop records" recognition prefix, and STEP 5's own section must carry the
// anomaly branch — skill phrases + a server render fragment pinned together, the
// whatsapp-shopping-capture.mjs shape.
//
// Static, read-only, zero deps — parses interfaces/tool arrays by TEXT (no TS compiler) and
// greps ONLY each skill's OWN section, never the whole file: a whole-file grep passes on
// incidental mentions (an example line, a parenthetical) — the exact shape of the pre-change bug
// — while the acceptance criterion is that the RIGHT section consumes the field/tool.
//
//   node tests/triage-decisions-consumers.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const ENGINE_FILE = join(REPO_ROOT, "board", "lib", "triage-decisions.ts");
const TOOLS_FILE = join(REPO_ROOT, "mcp", "board-server", "tools.mjs");
const SERVER_FILE = join(REPO_ROOT, "mcp", "board-server", "server.mjs");
const MAIL_SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "mail-to-board", "SKILL.md");
const REVIEW_SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "reminders-review", "SKILL.md");
const MIN_KEYS = 4; // TriageDecisionSummary's field count: dropped, senders, promoted, firstTime.
const MIN_TRIAGE_TOOLS = 3; // record_triage_decision, list_triage_decisions, resolve_triage_decision.

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- check 1: parse TriageDecisionSummary's top-level field names, by text ---------------------
const engineSrc = readFileSync(ENGINE_FILE, "utf8");
const ifaceMatch = engineSrc.match(/export interface TriageDecisionSummary \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  console.error(`[triage-decisions-consumers] could not find 'export interface TriageDecisionSummary { … }' in ${ENGINE_FILE}`);
  process.exit(1);
}
// A top-level field is a line indented by EXACTLY two spaces (a refactor that nests a field or
// moves the interface must fail this test, not silently pass it with a shrunken field list).
const keys = [...ifaceMatch[1].matchAll(/^\s\s(\w+):/gm)].map((m) => m[1]);
check(
  keys.length >= MIN_KEYS,
  `TriageDecisionSummary parses >= ${MIN_KEYS} top-level fields (got ${keys.length}: ${keys.join(", ")}) — ` +
    `a refactor that moves the interface or drops a field must fail this test, not silently pass it`,
);

// --- check 2: tool ground truth — derive the three triage tool names from tools.mjs's OWN TOOLS
// array (never a manifest — the plan-#37 lesson: a listing that lags the server is the bug),
// then assert each name also appears in server.mjs's dispatch switch. -----------------------------
const toolsSrc = readFileSync(TOOLS_FILE, "utf8");
const toolsArrayMatch = toolsSrc.match(/export const TOOLS = \[([\s\S]*?)\n\];/);
if (!toolsArrayMatch) {
  console.error(`[triage-decisions-consumers] could not find 'export const TOOLS = [ … ];' in ${TOOLS_FILE}`);
  process.exit(1);
}
const toolIdentifiers = [...new Set([...toolsArrayMatch[1].matchAll(/([A-Z][A-Z0-9_]*_TOOL)/g)].map((m) => m[1]))];
const triageToolNames = [];
for (const ident of toolIdentifiers) {
  const defMatch = toolsSrc.match(new RegExp(`const ${ident} = \\{[\\s\\S]*?name:\\s*"([a-z_]+)"`));
  if (defMatch && defMatch[1].includes("triage")) triageToolNames.push(defMatch[1]);
}
check(
  triageToolNames.length >= MIN_TRIAGE_TOOLS,
  `tools.mjs's TOOLS array registers >= ${MIN_TRIAGE_TOOLS} tools containing 'triage' (got ` +
    `${triageToolNames.length}: ${triageToolNames.join(", ")}) — read from the TOOLS array + each ` +
    `tool's own 'name' field, not a hand-maintained manifest`,
);

const serverSrc = readFileSync(SERVER_FILE, "utf8");
for (const name of triageToolNames) {
  check(serverSrc.includes(`case "${name}"`), `server.mjs's dispatch switch handles '${name}'`);
}

// --- check 3: mail-to-board consumes + orders — Step 7's drop region (heading-bounded: from the
// "**Case vs reminder vs drop" anchor through the start of "## Step 8") must name BOTH tools the
// sweep calls, and record_triage_decision must be mentioned BEFORE cos/processed (record, then
// watermark — criterion 5, as a mechanical check). Step 10's own section must consume `dropped`
// and `promoted` (the run-level ratio line). -----------------------------------------------------
const mailSrc = readFileSync(MAIL_SKILL_FILE, "utf8");
const dropRegionMatch = mailSrc.match(/\*\*Case vs reminder vs drop[\s\S]*?\n## Step 8/);
if (!dropRegionMatch) {
  console.error(
    `[triage-decisions-consumers] could not find the '**Case vs reminder vs drop … \\n## Step 8' drop ` +
      `region in ${MAIL_SKILL_FILE} (a retitle or a dropped heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const dropRegion = dropRegionMatch[0];
check(dropRegion.includes("record_triage_decision"), "mail-to-board's drop region names 'record_triage_decision'");
check(dropRegion.includes("list_triage_decisions"), "mail-to-board's drop region names 'list_triage_decisions'");
const recordIdx = dropRegion.indexOf("record_triage_decision");
const watermarkIdx = dropRegion.indexOf("cos/processed");
check(
  recordIdx !== -1 && watermarkIdx !== -1 && recordIdx < watermarkIdx,
  `'record_triage_decision' (index ${recordIdx}) is mentioned BEFORE 'cos/processed' (index ${watermarkIdx}) ` +
    `in the drop region — the record-before-watermark ordering, mechanically checked`,
);

const step10Match = mailSrc.match(/## Step 10[\s\S]*?\n## /);
if (!step10Match) {
  console.error(`[triage-decisions-consumers] could not find a '## Step 10 … \\n## ' section in ${MAIL_SKILL_FILE}`);
  process.exit(1);
}
const step10 = step10Match[0];
check(step10.includes("dropped"), "mail-to-board's Step 10 section consumes 'dropped'");
check(step10.includes("promoted"), "mail-to-board's Step 10 section consumes 'promoted'");

// --- check 4: reminders-review consumes — the digest STEP's own section (heading-bounded) must
// consume firstTime/dropped/senders and name both tools it calls. --------------------------------
const reviewSrc = readFileSync(REVIEW_SKILL_FILE, "utf8");
const digestMatch = reviewSrc.match(/## STEP 5[\s\S]*?\n## /);
if (!digestMatch) {
  console.error(
    `[triage-decisions-consumers] could not find a '## STEP 5 … \\n## ' section in ${REVIEW_SKILL_FILE} ` +
      `(a retitle or renumber must break this gate, not silently blank it — the gate anchors on the heading TEXT, not the number)`,
  );
  process.exit(1);
}
const digest = digestMatch[0];
check(digest.includes("The filtered-mail digest"), "the extracted STEP 5 section is the filtered-mail digest (heading text intact)");
for (const key of ["firstTime", "dropped", "senders"]) {
  check(digest.includes(key), `reminders-review's digest section consumes '${key}'`);
}
check(digest.includes("resolve_triage_decision"), "reminders-review's digest section names 'resolve_triage_decision'");
check(digest.includes("list_triage_decisions"), "reminders-review's digest section names 'list_triage_decisions'");

// --- check 5 (cos-ops#72): the digest's zero-drops anomaly branch, + the render that feeds it ---
// An empty ledger (`dropped` 0 while mail was promoted) must be reported as an anomaly, never as
// the "nothing new" reassurance — and the tool's empty-ledger render must interpolate
// summary.promoted, or the branch is unreachable-by-construction (the early return at
// handleListTriageDecisions is the ONLY carrier the Cowork digest ever sees). Skill phrases + a
// server render fragment pinned together — the whatsapp-shopping-capture.mjs shape. Phrases are
// prose: case-insensitive, wrap-tolerant `[\s-]+` joins (ADR 0030 clause 4; idiom from
// tests/task-list-consumers.mjs). Identifiers/source fragments stay case-sensitive.
const phraseRe = (phrase) => new RegExp(phrase.split(/[\s-]+/).join("[\\s-]+"), "i");
check(
  phraseRe("nothing new was filtered from your mail").test(digest),
  "the digest keeps the healthy no-op line (the dropped > 0 path — criterion 4)",
);
check(
  phraseRe("the filter's receipt has never been written").test(digest),
  "the digest carries the zero-drops anomaly branch (criterion 1)",
);
check(
  phraseRe("a receipt count, never a drop rate").test(digest),
  "the anomaly line scopes its numbers honestly — receipt count, never a drop rate (Correction 1)",
);
check(
  phraseRe("predates the drop ledger").test(digest),
  "the anomaly branch names candidate cause (a): a Cowork bundle predating the ledger",
);
check(
  phraseRe("genuinely never fired").test(digest),
  "the anomaly branch names candidate cause (b): the five-test gate genuinely never firing",
);
check(
  phraseRe("No drop records").test(digest),
  "the digest quotes the render's recognition prefix — the branch's trigger is stated, not implied",
);
check(
  serverSrc.includes("No drop records for source"),
  "server.mjs's empty-ledger render opens with the recognition prefix the skill branch keys on",
);
check(
  serverSrc.includes("against ${summary.promoted} promoted inbound message(s) on the board"),
  "server.mjs's empty-ledger render interpolates summary.promoted — the number the branch needs",
);

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — TriageDecisionSummary's ${keys.length} fields + ${triageToolNames.length} triage tools are ` +
    `all consumed/named where they should be, mail-to-board records before it watermarks, and the ` +
    `reminders-review digest consumes the summary it renders.`,
);
