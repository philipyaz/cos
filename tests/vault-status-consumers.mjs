#!/usr/bin/env node
// tests/vault-status-consumers.mjs — the ADR 0014 gate (cos-ops#56): a terminal `ingest_status`
// payload echoes the board case ids the job was submitted with (`structuredContent.cases`), so the
// stamping agent reads them off the payload it is already holding at the moment it decides, instead
// of recall of the earlier `ingest` call some turns (maybe a compaction) ago. Four checks, one
// subject — the terminal cases echo → board-side receipt handoff:
//
//   1. producer marker — mcp/vault-server/server.mjs actually sets `sc.cases = …` in
//      shapeStatusResult (the static, always-run half; [13b]'s api-vault.mjs owns the runtime
//      behavior and self-SKIPs when the vault server's deps aren't installed — the same producer /
//      behavior split as fitness-outcome-consumers, tests/run.sh: "the live-board api test's own
//      copy of that assertion silently SKIPs").
//   2. call-time narration — INGEST_STATUS_TOOL's description names BOTH `structuredContent.cases`
//      and `mark_vault_ingested`, so even a caller that never loaded the skill is told (AC 2).
//   3. consumer, receipt section — vault-operations/SKILL.md's "## The board-side receipt" section
//      (the completed-only rule is [3d]'s subject; NOT re-asserted here — ADR 0020 disjointness)
//      names both the echo field and the stamp tool.
//   4. consumer, poll-loop twin — the "## ingest is ASYNCHRONOUS" section's own completed bullet
//      also names the echo field. The skill states the stamp rule TWICE; both copies must read the
//      echo, not just one (the cos#89-era half-twin defect this guards against).
//
// All four matched CASE-SENSITIVELY as identifiers (ADR 0030 clause 4); no reword escape hatch is
// offered (clause 5 — these are identifiers, not phrases). This is a NEW [2f] rider (ADR 0030 clause
// 2: a new MCP field an operator skill must consume implies a gate) — cited by that ADR, NOT ADR
// 0022 (pack-skills owning generated skill artifacts — a different subject; the recurring
// miscitation triage-decisions-consumers.mjs:11-13 declines it by name). It is a further rider past
// ADR 0030's own "seventh instance" revisit trigger — flagged in the PR body, not silently skipped.
//
// Static, read-only, zero deps — parses by TEXT, heading-delimited per section so a whole-file grep
// can't pass on an incidental mention outside the section that must actually consume the field.
//
//   node tests/vault-status-consumers.mjs

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const SERVER_FILE = join(REPO_ROOT, "mcp", "vault-server", "server.mjs");
const SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "vault-operations", "SKILL.md");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- check 1: producer marker — the terminal echo assignment exists in shapeStatusResult --------
const serverSrc = readFileSync(SERVER_FILE, "utf8");
check(
  /sc\.cases\s*=/.test(serverSrc),
  `${relative(REPO_ROOT, SERVER_FILE)} sets 'sc.cases =' in shapeStatusResult (the terminal echo) — ` +
    `the always-run static half; api-vault.mjs's runtime assertion is the behavioral half and ` +
    `self-SKIPs without the vault server's deps installed, same split as fitness-outcome-consumers`,
);

// --- check 2: call-time narration — INGEST_STATUS_TOOL's description names the echo + the stamp --
const toolMatch = serverSrc.match(/const INGEST_STATUS_TOOL = \{[\s\S]*?\n\};/);
if (!toolMatch) {
  console.error(
    `[vault-status-consumers] could not find 'const INGEST_STATUS_TOOL = { … };' in ${SERVER_FILE} ` +
      `(a rename or restructure must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const toolBlock = toolMatch[0];
check(toolBlock.includes("structuredContent.cases"), "INGEST_STATUS_TOOL's description names 'structuredContent.cases'");
check(toolBlock.includes("mark_vault_ingested"), "INGEST_STATUS_TOOL's description names 'mark_vault_ingested'");

// --- check 3: consumer, receipt section — heading-delimited to the next '## ' (Cancelling follows) -
const skillSrc = readFileSync(SKILL_FILE, "utf8");
const receiptMatch = skillSrc.match(/## The board-side receipt[\s\S]*?\n## /);
if (!receiptMatch) {
  console.error(
    `[vault-status-consumers] could not find a '## The board-side receipt … \\n## ' section in ${SKILL_FILE} ` +
      `(a retitle or a dropped heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const receiptSection = receiptMatch[0];
check(receiptSection.includes("structuredContent.cases"), "the board-side-receipt section names 'structuredContent.cases'");
check(receiptSection.includes("mark_vault_ingested"), "the board-side-receipt section names 'mark_vault_ingested'");

// --- check 4: consumer, poll-loop twin — the skill states the stamp rule TWICE; both copies must
// read the echo, not just one (the cos#89-era half-twin defect) ----------------------------------
const pollMatch = skillSrc.match(/## ingest is ASYNCHRONOUS[\s\S]*?\n## /);
if (!pollMatch) {
  console.error(
    `[vault-status-consumers] could not find a '## ingest is ASYNCHRONOUS … \\n## ' section in ${SKILL_FILE} ` +
      `(a retitle or a dropped heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
check(
  pollMatch[0].includes("structuredContent.cases"),
  "the poll-loop section's completed bullet also names 'structuredContent.cases'",
);

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "\nPASS — the terminal ingest_status cases echo is produced (server.mjs), narrated at call time " +
    "(INGEST_STATUS_TOOL), and consumed by both places vault-operations states the stamp rule.",
);
