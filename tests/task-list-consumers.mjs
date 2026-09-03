#!/usr/bin/env node
// tests/task-list-consumers.mjs — the ADR 0014 gate (cos-ops#51), clause-compliant with ADR 0030
// (the consumer-gate family): board-organize's STEP 7 ("no new routine" — the weekly staleness
// lens gains one paragraph reading the open-task list alongside `starving`) must actually NAME the
// tool it reads (`list_tasks`), and both STEP 7 and STEP 8 must carry the pinned phrase the report
// names its findings with ("overdue and long-undated tasks") — a skill edit that lands the field
// but never wires the sweep's own report is exactly the class of defect ADR 0014 exists to catch
// (cos-ops#18's nutrition-status-consumers.mjs is the original; this clones
// tests/triage-decisions-consumers.mjs's section-scoping mechanics).
//
// Clause 1 (home): its own file. Clause 2 (step id): rides the existing `[2f]` run.sh step, with
// its own echo line and its own `fail_reasons` token — never a new `[2*]` id. Clause 3 (scope):
// greps ONLY each STEP's OWN heading-delimited section, never the whole file — a whole-file grep
// passes on an incidental mention (an example line, a parenthetical aside), the exact shape of the
// bug this gate exists to catch. Clause 4 (matching): the tool name is a code identifier, matched
// case-sensitively, exactly; the pinned phrase is prose, matched case-insensitively against the
// whole section content with wrap-tolerant separators (these bodies wrap at ~72 cols, so line-mode
// matching is a silent no-op the day the phrase reflows). Clause 5 (escape hatch): the
// NON_SKILL_TOKENS-style sentence (skill-reachability.mjs:35-43) — any reword allowance is for
// incidental mentions, never a place to launder a genuinely missing consumer; nothing here loosens
// that the phrase and the tool name must both be PRESENT.
//
// Static, read-only, zero deps.
//
//   node tests/task-list-consumers.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "board-organize", "SKILL.md");
const TOOLS_FILE = join(REPO_ROOT, "mcp", "board-server", "tools.mjs");
const SERVER_FILE = join(REPO_ROOT, "mcp", "board-server", "server.mjs");
const ROUTE_FILE = join(REPO_ROOT, "board", "app", "api", "tasks", "route.ts");

const PINNED_PHRASE = "overdue and long-undated tasks";

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Wrap-tolerant, case-insensitive match: the phrase's words joined by `[\s-]+` so a rewrap at
// ~72 cols (a newline landing where a space or a hyphen was) still matches. Every word of the
// phrase must still appear, in order — this loosens formatting, never content.
function hasPinnedPhrase(section) {
  const words = PINNED_PHRASE.split(/[\s-]+/);
  const re = new RegExp(words.join("[\\s-]+"), "i");
  return re.test(section);
}

// --- check 1: STEP 7's own section (heading-bounded, clause 3) ---------------------------------
const skillSrc = readFileSync(SKILL_FILE, "utf8");
const step7Match = skillSrc.match(/## STEP 7[\s\S]*?\n## /);
if (!step7Match) {
  console.error(
    `[task-list-consumers] could not find a '## STEP 7 … \\n## ' section in ${SKILL_FILE} ` +
      `(a retitle or a dropped heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const step7 = step7Match[0];
check(step7.includes("list_tasks"), "STEP 7's section names 'list_tasks' (case-sensitive, exact)");
check(hasPinnedPhrase(step7), `STEP 7's section carries the pinned phrase "${PINNED_PHRASE}"`);

// --- check 2: STEP 8's own section (heading-bounded, clause 3) ---------------------------------
const step8Match = skillSrc.match(/## STEP 8[\s\S]*?\n## /);
if (!step8Match) {
  console.error(
    `[task-list-consumers] could not find a '## STEP 8 … \\n## ' section in ${SKILL_FILE} ` +
      `(a retitle or a dropped heading must break this gate, not silently blank it)`,
  );
  process.exit(1);
}
const step8 = step8Match[0];
check(hasPinnedPhrase(step8), `STEP 8's section carries the pinned phrase "${PINNED_PHRASE}"`);

// --- check 3: the wiring trio — a tool named list_tasks is registered, dispatched, and the route
// it rides exists (the fitness-outcome-consumers precedent: this always-run static half holds even
// when the api-lifecycle step SKIPs for lack of a running board). --------------------------------
const toolsSrc = readFileSync(TOOLS_FILE, "utf8");
const toolsArrayMatch = toolsSrc.match(/export const TOOLS = \[([\s\S]*?)\n\];/);
if (!toolsArrayMatch) {
  console.error(`[task-list-consumers] could not find 'export const TOOLS = [ … ];' in ${TOOLS_FILE}`);
  process.exit(1);
}
const toolIdentifiers = [...new Set([...toolsArrayMatch[1].matchAll(/([A-Z][A-Z0-9_]*_TOOL)/g)].map((m) => m[1]))];
let hasListTasksTool = false;
for (const ident of toolIdentifiers) {
  const defMatch = toolsSrc.match(new RegExp(`const ${ident} = \\{[\\s\\S]*?name:\\s*"([a-z_]+)"`));
  if (defMatch && defMatch[1] === "list_tasks") hasListTasksTool = true;
}
check(hasListTasksTool, "tools.mjs's TOOLS array registers a tool named 'list_tasks'");

const serverSrc = readFileSync(SERVER_FILE, "utf8");
check(serverSrc.includes('case "list_tasks"'), "server.mjs's dispatch switch handles 'list_tasks'");

check(existsSync(ROUTE_FILE), `board/app/api/tasks/route.ts exists`);
if (existsSync(ROUTE_FILE)) {
  const routeSrc = readFileSync(ROUTE_FILE, "utf8");
  check(/export\s+(async\s+)?function\s+GET\b/.test(routeSrc), "board/app/api/tasks/route.ts exports GET");
}

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "\nPASS — board-organize's STEP 7 names list_tasks and, with STEP 8, carries the pinned " +
    `"${PINNED_PHRASE}" phrase; the list_tasks tool is registered, dispatched, and its route exists.`,
);
