#!/usr/bin/env node
// tests/event-status-consumers.mjs — the ADR 0014 gate (cos-ops#47): CalendarEvent.status is
// this unit's whole PRODUCT change, and nothing else would gate it — a rule the fleet must not
// silently regress on is a check (ADR 0014), and ADR 0021's Consequences names exactly this
// failure mode ("the only thing standing between Cos and a double-booking is prose in two
// SKILL.md files"). Clones tests/triage-decisions-consumers.mjs's mechanics (static, zero-dep,
// REPO_ROOT from config/load-config.mjs, text-parses code for ground truth, greps ONLY each
// skill's OWN heading-delimited section, never the whole file — that file's header explains why
// a whole-file grep is a permanently-green no-op). Rides the existing `[2f]` run.sh step id with
// its own echo line and its own fail_reasons token, rather than minting a new [2*] id
// (cos-ops#21's direction; #94/#98/#41 already do the same).
//
// Checks:
//   1. Ground truth from code, never a manifest: mcp/calendar-server/server.mjs's OWN
//      EVENT_STATUS const carries >= 3 values including confirmed/tentative/cancelled, and
//      UPDATE_EVENT_TOOL's `status` property declares its enum as that SAME const (never a
//      hand-copied literal that can drift out from under it).
//   2. mail-to-board's ops-mapping section (the heading enclosing the "Meeting invite /
//      calendar event" row) names `update_event` AND a wrap-tolerant `status: "cancelled"`.
//   3. whatsapp-triage — BOTH twins: the STEP 4 ops-table section, and the recap section
//      holding the "A confirmed appointment → the board calendar" bullet, each name
//      `update_event` AND a wrap-tolerant `status: "cancelled"` — this is the gate that makes
//      the one-twin-amended regression (ADR 0013's recorded consequence) impossible.
//
//   node tests/event-status-consumers.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const SERVER_FILE = join(REPO_ROOT, "mcp", "calendar-server", "server.mjs");
const MAIL_SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "mail-to-board", "SKILL.md");
const WHATSAPP_SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "whatsapp-triage", "SKILL.md");
const MIN_STATUS_VALUES = 3; // confirmed, tentative, cancelled

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// A wrap-tolerant match for `status: "cancelled"` — SKILL.md prose wraps at ~72 columns, so a
// literal single-line find can MISS a real mention split across a line break (ADR 0014's #73
// wrapped-phrase near-miss, generalized). Allows optional backticks/quotes and any run of
// whitespace (incl. a newline) between the tokens.
const STATUS_CANCELLED_RE = /status[\s`'"]*:[\s`'"]*cancelled/i;

// --- check 1: ground truth from code — EVENT_STATUS + UPDATE_EVENT_TOOL's own enum ------------
const serverSrc = readFileSync(SERVER_FILE, "utf8");

const constMatch = serverSrc.match(/const EVENT_STATUS = \[([\s\S]*?)\];/);
if (!constMatch) {
  console.error(`[event-status-consumers] could not find 'const EVENT_STATUS = [ … ];' in ${SERVER_FILE}`);
  process.exit(1);
}
const statusValues = [...constMatch[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
check(
  statusValues.length >= MIN_STATUS_VALUES &&
    ["confirmed", "tentative", "cancelled"].every((v) => statusValues.includes(v)),
  `server.mjs's EVENT_STATUS carries >= ${MIN_STATUS_VALUES} values including confirmed/tentative/cancelled ` +
    `(got ${statusValues.length}: ${statusValues.join(", ")})`,
);

const updateToolMatch = serverSrc.match(/const UPDATE_EVENT_TOOL = \{[\s\S]*?\n\};/);
if (!updateToolMatch) {
  console.error(`[event-status-consumers] could not find 'const UPDATE_EVENT_TOOL = { … };' in ${SERVER_FILE}`);
  process.exit(1);
}
const updateToolSrc = updateToolMatch[0];
check(
  /status:\s*\{[\s\S]*?enum:\s*EVENT_STATUS/.test(updateToolSrc),
  "UPDATE_EVENT_TOOL's 'status' property declares its enum as the SAME EVENT_STATUS const — never a hand-copied literal that can drift",
);

// --- check 2: mail-to-board's ops-mapping section names update_event + status:"cancelled" -----
const mailSrc = readFileSync(MAIL_SKILL_FILE, "utf8");
const mailSectionMatch = mailSrc.match(/## Step 7[\s\S]*?\n## Step 8/);
if (!mailSectionMatch) {
  console.error(
    `[event-status-consumers] could not find the '## Step 7 … \\n## Step 8' ops-mapping section in ` +
      `${MAIL_SKILL_FILE} (a retitle or a renumber must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const mailSection = mailSectionMatch[0];
check(
  mailSection.includes("Meeting invite / calendar event"),
  "the extracted mail-to-board section is the ops-mapping table (row text intact)",
);
check(mailSection.includes("update_event"), "mail-to-board's ops-mapping section names 'update_event'");
check(STATUS_CANCELLED_RE.test(mailSection), `mail-to-board's ops-mapping section names status:"cancelled" (wrap-tolerant)`);

// --- check 3: whatsapp-triage — BOTH twins -----------------------------------------------------
const waSrc = readFileSync(WHATSAPP_SKILL_FILE, "utf8");

const waStepMatch = waSrc.match(/## STEP 4[\s\S]*?\n## STEP 5/);
if (!waStepMatch) {
  console.error(`[event-status-consumers] could not find a '## STEP 4 … \\n## STEP 5' section in ${WHATSAPP_SKILL_FILE}`);
  process.exit(1);
}
const waStep = waStepMatch[0];
check(waStep.includes("CONFIRMED appointment"), "the extracted whatsapp-triage STEP 4 section is the ops table (row text intact)");
check(waStep.includes("update_event"), "whatsapp-triage's STEP 4 section (twin #1) names 'update_event'");
check(STATUS_CANCELLED_RE.test(waStep), `whatsapp-triage's STEP 4 section (twin #1) names status:"cancelled" (wrap-tolerant)`);

const waRecapMatch = waSrc.match(/A confirmed appointment[\s\S]*?(?=\n- \*\*|\n## )/);
if (!waRecapMatch) {
  console.error(
    `[event-status-consumers] could not find the "A confirmed appointment → the board calendar" recap bullet in ` +
      `${WHATSAPP_SKILL_FILE} (twin #2 — this bullet is LINE-WRAPPED in the source, so a literal single-line find misses it)`,
  );
  process.exit(1);
}
const waRecap = waRecapMatch[0];
check(waRecap.includes("update_event"), "whatsapp-triage's recap bullet (twin #2) names 'update_event'");
check(
  STATUS_CANCELLED_RE.test(waRecap),
  `whatsapp-triage's recap bullet (twin #2) names status:"cancelled" (wrap-tolerant, across the line wrap)`,
);

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — CalendarEvent.status is consumed where it should be: server.mjs's own EVENT_STATUS ` +
    `const backs UPDATE_EVENT_TOOL's enum, and both mail-to-board and whatsapp-triage (BOTH twins) ` +
    `instruct status:"cancelled" over delete_event.`,
);
