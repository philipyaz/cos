#!/usr/bin/env node
// tests/whatsapp-shopping-capture.mjs — the ADR 0014 gate (cos-ops#39): whatsapp-triage's STEP 4.5
// (explicit purchase statements → the persistent shopping list, cos-ops#37's `nutrition` MCP) must
// exist, must be reachable from STEP 4's own routing table, must name the two shopping tools it
// calls, must state every load-bearing rule (qualification, provenance, dedupe, anti-resurrection,
// honest degradation, mode parity) as a fixed, individually-pinned phrase, must stay READ-ONLY on
// the `whatsapp` MCP, and its two dependent hops in mcp/nutrition-server/server.mjs — the
// `sourceRef` render and the ADD tool's call-time description — must carry the channel form.
// Clones tests/shopping-list-consumers.mjs's mechanics (same normalize()/containsPhrase() helpers,
// same TOOLS-array parser, the hard-exit-on-missing section-extraction pattern) — this is that
// gate's whatsapp-side twin: static, read-only, zero deps, always-run (ADR 0014 names a silent
// skip as the failure mode, not a red).
//
// Fixed-phrase checks are matched case-INSENSITIVELY, with backtick/asterisk markdown stripped
// first (a guardrail phrase is prose — a sentence-initial capital or a code-span is a style
// choice, not a semantic one) — EXCEPT the three code-facing literals (`"channel"`, `whatsapp:`,
// `sourceRef`), which are matched the way the sibling gate matches field/tool names: a plain,
// case-sensitive substring (they are identifiers, not sentences). Section HEADING regexes stay
// case-sensitive throughout (headings genuinely are uppercase); the in-section "STEP 4.5"
// cross-reference (check 2) is the one exception routed through the case-insensitive helper,
// because the file's own prose voice writes cross-references lowercase ("see Step 4.5") far more
// often than upper ("STEP 4.5").
//
//   node tests/whatsapp-shopping-capture.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "whatsapp-triage", "SKILL.md");
const SERVER_FILE = join(REPO_ROOT, "mcp", "nutrition-server", "server.mjs");
const AUTOMATION_FILE = join(REPO_ROOT, "board", ".claude", "skills", "automation.json");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Cloned verbatim from tests/shopping-list-consumers.mjs.
const normalize = (s) =>
  s
    .replace(/^>\s?/gm, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const containsPhrase = (text, phrase) => normalize(text).toLowerCase().includes(normalize(phrase).toLowerCase());

const skillSrc = readFileSync(SKILL_FILE, "utf8");
const serverSrc = readFileSync(SERVER_FILE, "utf8");

// --- check 1: section extraction (hard exit — a retitle or a swallowed next-heading must break
// this gate loudly, not silently blank it) ---------------------------------------------------------
const step45Match = skillSrc.match(/## STEP 4\.5[\s\S]*?\n## /);
if (!step45Match) {
  console.error(
    `[whatsapp-shopping-capture] could not find a '## STEP 4.5 … \\n## ' section in ${SKILL_FILE} ` +
      `(a retitle or a dropped next-heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const step45 = step45Match[0];
console.log("  ✓ '## STEP 4.5' section exists in whatsapp-triage/SKILL.md and extracts cleanly");

// --- check 2: flow reachability, scoped to STEP 4's OWN section (the em-dash disambiguates the
// heading from '## STEP 4.5') — an intro-only mention must not satisfy this ------------------------
const step4Match = skillSrc.match(/## STEP 4 —[\s\S]*?\n## /);
if (!step4Match) {
  console.error(`[whatsapp-shopping-capture] could not find a '## STEP 4 — … \\n## ' section in ${SKILL_FILE}`);
  process.exit(1);
}
check(
  containsPhrase(step4Match[0], "STEP 4.5"),
  "STEP 4's own section references STEP 4.5 (case-insensitive — the file's prose voice writes " +
    "'Step 4.5' lowercase) — the table row / DROP carve-out actually route into it, not just an intro mention",
);

// --- check 3: tool floor, ground truth in code — parse server.mjs's TOOLS array (verbatim parser
// from shopping-list-consumers.mjs), require both tools this step calls to be served AND named
// inside STEP 4.5 itself ------------------------------------------------------------------------
const toolsArrayMatch = serverSrc.match(/const TOOLS = \[([\s\S]*?)\n\];/);
if (!toolsArrayMatch) {
  console.error(`[whatsapp-shopping-capture] could not find 'const TOOLS = [ … ];' in ${SERVER_FILE}`);
  process.exit(1);
}
const toolIdentifiers = [...new Set([...toolsArrayMatch[1].matchAll(/([A-Z][A-Z0-9_]*_TOOL)/g)].map((m) => m[1]))];
const servedNames = [];
for (const ident of toolIdentifiers) {
  const defMatch = serverSrc.match(new RegExp(`const ${ident} = \\{[\\s\\S]*?name:\\s*"([a-z_]+)"`));
  if (defMatch) servedNames.push(defMatch[1]);
}
for (const name of ["add_shopping_item", "list_shopping"]) {
  check(servedNames.includes(name), `server.mjs's TOOLS array registers '${name}'`);
  check(step45.includes(name), `STEP 4.5 names the tool '${name}' — not found as a literal substring of the section`);
}

// --- check 4: load-bearing phrases, SECTION-SCOPED, individually named (16 rows / 18 assertions;
// rows 7 and 8 each carry two strings) ------------------------------------------------------------
const PHRASE_PINS = [
  ["an explicit, unambiguous statement that something needs to be bought", "the qualification rule"],
  ["said by the user, or addressed to them", "who can put a line on the list"],
  [
    "never inferred from a food being mentioned, a restaurant, a recipe, a photo, or a plan to cook",
    "the no-inference rule (carries the AC's restaurant + recipe negatives)",
  ],
  ["when in doubt, do not add", "fail-closed"],
  ["in passing", "the AC's third required negative class (worked example)"],
  ["do not add it twice", "the dedupe rule (behavior)"],
  ["normalised name", "the dedupe rule (key)"],
  ["already carries this message's id", "the anti-resurrection key"],
  ["never flip a bought or dismissed row back to needed", "the manual-action guarantee on the list"],
  ["a new row with the new message's id", "recurring purchases stay possible"],
  ["skip the step and say so in the sweep report", "honest degradation"],
  ["never fall back to minting a case or a reminder", "no substitute destination"],
  ["one confirmation for the whole sweep, never a prompt per item", "mode parity"],
  ["nothing routes through the pending queue", "the no-db.pending rule (same string JOB 6 pins)"],
  ["/addons", "the degradation report carries the remedy, not just the loss"],
];
for (const [phrase, label] of PHRASE_PINS) {
  check(containsPhrase(step45, phrase), `STEP 4.5 states ${label} ('${phrase}')`);
}
// Identifier/marker-shaped literals — matched the way the sibling gate matches field and tool
// names (plain, case-sensitive substring), not as prose sentences.
const LITERAL_PINS = [
  ['"channel"', "the source attribution"],
  ["whatsapp:", "per-message provenance, in the stated format (the channel prefix)"],
  ["sourceRef", "per-message provenance, in the stated format (the field)"],
];
for (const [literal, label] of LITERAL_PINS) {
  check(step45.includes(literal), `STEP 4.5 states ${label} ('${literal}')`);
}

// --- check 5: read-only on WhatsApp preserved (scoped negative grep + the file-wide guarantee) ---
for (const forbidden of ["send_message", "send_file", "send_audio_message"]) {
  check(!step45.includes(forbidden), `STEP 4.5 does not call '${forbidden}' — the sweep stays read-only on WhatsApp`);
}
check(
  containsPhrase(skillSrc, "never calls send_message"),
  "SKILL.md still carries the read-only-on-WhatsApp guarantee sentence ('never calls send_message')",
);

// --- check 6: the render hop — shoppingLine renders sourceRef (the MCP/HTTP read-parity fix) -----
const shoppingLineMatch = serverSrc.match(/function shoppingLine\([\s\S]*?\n\}/);
if (!shoppingLineMatch) {
  console.error(`[whatsapp-shopping-capture] could not find 'function shoppingLine(...) { … }' in ${SERVER_FILE}`);
  process.exit(1);
}
check(
  shoppingLineMatch[0].includes("sourceRef"),
  "server.mjs's shoppingLine() renders sourceRef — the anti-resurrection rule is enforceable over MCP",
);

// --- check 7: the call-time narration — ADD_SHOPPING_ITEM_TOOL names the channel form -------------
const addToolMatch = serverSrc.match(/const ADD_SHOPPING_ITEM_TOOL = \{[\s\S]*?\n\};/);
if (!addToolMatch) {
  console.error(`[whatsapp-shopping-capture] could not find 'const ADD_SHOPPING_ITEM_TOOL = { … };' in ${SERVER_FILE}`);
  process.exit(1);
}
check(
  addToolMatch[0].includes("whatsapp:"),
  "ADD_SHOPPING_ITEM_TOOL's definition names the 'whatsapp:' sourceRef form — the sweeping agent reads this at call time",
);

// --- check 8: the catalog — whatsapp-triage's summary names the new destination -------------------
const automation = JSON.parse(readFileSync(AUTOMATION_FILE, "utf8"));
check(
  typeof automation["whatsapp-triage"]?.summary === "string" && /shopping/i.test(automation["whatsapp-triage"].summary),
  "automation.json's whatsapp-triage.summary mentions 'shopping'",
);

// --- check 9: STEP 8 carries the new log-line template + report bullet ----------------------------
const step8Match = skillSrc.match(/## STEP 8[\s\S]*?\n## /);
if (!step8Match) {
  console.error(`[whatsapp-shopping-capture] could not find a '## STEP 8 … \\n## ' section in ${SKILL_FILE}`);
  process.exit(1);
}
check(step8Match[0].includes("Shopping:"), "the STEP 8 section carries the 'Shopping:' log-line template addition");

// --- check 10: the write-surface twin sentence — Conventions names the third MCP ------------------
const conventionsMatch = skillSrc.match(/## Conventions[\s\S]*?\n## /);
if (!conventionsMatch) {
  console.error(`[whatsapp-shopping-capture] could not find a '## Conventions … \\n## ' section in ${SKILL_FILE}`);
  process.exit(1);
}
check(
  conventionsMatch[0].includes("nutrition"),
  "the Conventions recap's write-surface bullet names the 'nutrition' MCP — the file's two statements " +
    "of its write surface cannot drift apart silently",
);

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — whatsapp-triage's STEP 4.5 exists, is reachable from STEP 4, names both shopping tools, ` +
    `states all ${PHRASE_PINS.length + LITERAL_PINS.length} pinned rules, stays read-only on WhatsApp, and the ` +
    `nutrition-server render + call-time narration both carry the whatsapp: form.`,
);
