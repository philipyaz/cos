#!/usr/bin/env node
// tests/shopping-list-consumers.mjs — the ADR 0014 gate (cos-ops#37): every top-level field the
// shopping-candidates engine (`ShoppingCandidatesResult` in board/lib/shopping-candidates.ts)
// returns, and every shopping tool the MCP server actually registers, must be CONSUMED — by
// name — inside nutrition-chef/SKILL.md's own JOB 6 section (the job that reads the list +
// candidates). A field or tool the code carries and no job ever reads/names is exactly the
// defect cos-ops#18 measured on the nutrition-status side — this is that gate's shopping twin
// (clones tests/nutrition-status-consumers.mjs's + tests/fitness-outcome-consumers.mjs's parser
// mechanics; the latter is read off the still-open feature/19 branch, since it had not landed
// on main at plan time — see the PR body for that deviation).
//
// Also carries three things that are NOT field-derived, because they aren't fields:
//   - a small, section-scoped set of FIXED load-bearing phrases (the batching / clean-list-says-
//     nothing / offer-reconcile_pantry / no-pending-queue / inferred-label rules) — few, and
//     named individually below so a rewording that drops the underlying RULE breaks this gate,
//     not just a keyword.
//   - two SOURCE-LEVEL rule gates (the AC's own prose, turned into greps): the engine defines no
//     new numeric threshold constant, and the three shopping route files never reference
//     `pending` (nothing routes through the approval queue).
//   - the route-vs-tool regex pair, duplicated from tests/api-nutrition-shopping.mjs's own
//     in-file check. That api test's assertion lives in a `run.sh` block that SILENTLY SKIPS
//     when no board is up (the BOARD_UP guard) — ADR 0014 names silent skips as the failure
//     mode, so the always-run copy here is the real enforcement; the api test's copy exists
//     only to satisfy the issue's own naming of that file.
//
// The tool floor is read from mcp/nutrition-server/server.mjs's own `TOOLS` array — ground
// truth in code — and cross-checked (not trusted) against board/lib/addons.ts's nutrition
// manifest, which the plan documents as already 2-tool drifted (reconcile_pantry /
// get_nutrition_status are served but unlisted there); deriving THIS gate's floor from that
// manifest would be the #18 defect one level up.
//
// Fixed-phrase checks are matched case-INSENSITIVELY, with backtick/asterisk markdown stripped
// first (a guardrail phrase is prose — a sentence-initial capital or a code-span is a style
// choice, not a semantic one). Field + tool names stay CASE-SENSITIVE (they are code
// identifiers). Static, read-only, zero deps.
//
//   node tests/shopping-list-consumers.mjs

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const ENGINE_FILE = join(REPO_ROOT, "board", "lib", "shopping-candidates.ts");
const SKILL_FILE = join(REPO_ROOT, "board", ".claude", "skills", "nutrition-chef", "SKILL.md");
const SERVER_FILE = join(REPO_ROOT, "mcp", "nutrition-server", "server.mjs");
const ADDONS_FILE = join(REPO_ROOT, "board", "lib", "addons.ts");
const ROUTE_FILES = [
  join(REPO_ROOT, "board", "app", "api", "nutrition", "shopping", "route.ts"),
  join(REPO_ROOT, "board", "app", "api", "nutrition", "shopping", "[id]", "route.ts"),
  join(REPO_ROOT, "board", "app", "api", "nutrition", "shopping", "candidates", "route.ts"),
];
const MIN_KEYS = 3; // ShoppingCandidatesResult's post-change field count.
const MIN_SHOPPING_TOOLS = 5; // list/add/update/remove/get_shopping_candidates.

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Normalizes markdown source into flat prose before a phrase search: strips blockquote `>`
// prefixes and code/bold markers, then collapses every whitespace run (including the line
// breaks Markdown word-wrap inserts mid-sentence) to a single space. Without this, a multi-word
// phrase check is fragile to cosmetic re-wrapping — a phrase can straddle a line break in the
// SOURCE file while reading as one continuous sentence to a human (or the model that wrote it).
const normalize = (s) =>
  s
    .replace(/^>\s?/gm, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const containsPhrase = (text, phrase) => normalize(text).toLowerCase().includes(normalize(phrase).toLowerCase());

// --- job 1: extract ShoppingCandidatesResult's top-level field names, by text ------------------
const engineSrc = readFileSync(ENGINE_FILE, "utf8");
const ifaceMatch = engineSrc.match(/export interface ShoppingCandidatesResult \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  console.error(`[shopping-list-consumers] could not find 'export interface ShoppingCandidatesResult { … }' in ${ENGINE_FILE}`);
  process.exit(1);
}
// A top-level field is a line indented by EXACTLY two spaces (nested sub-fields, e.g. inside
// `window: { … }`, sit on the SAME line here and never match this).
const keys = [...ifaceMatch[1].matchAll(/^\s\s(\w+):/gm)].map((m) => m[1]);
check(
  keys.length >= MIN_KEYS,
  `ShoppingCandidatesResult parses >= ${MIN_KEYS} top-level fields (got ${keys.length}: ${keys.join(", ")}) — ` +
    `a refactor that moves the interface or drops a field must fail this test, not silently pass it`,
);

// --- extract JOB 6's own section of SKILL.md ----------------------------------------------------
const skillSrc = readFileSync(SKILL_FILE, "utf8");
const job6Match = skillSrc.match(/## JOB 6[\s\S]*?\n---\n/);
if (!job6Match) {
  console.error(`[shopping-list-consumers] could not find a '## JOB 6 … \\n---\\n' section in ${SKILL_FILE} (a retitle or a dropped '---' must break this gate, not silently blank it)`);
  process.exit(1);
}
const job6 = job6Match[0];

// --- every engine field must be consumed (named) inside JOB 6 — nowhere else in the file counts -
for (const key of keys) {
  check(
    job6.includes(key),
    `JOB 6 consumes '${key}' — not found as a literal substring of the JOB 6 section (an incidental ` +
      `mention elsewhere in SKILL.md does not count)`,
  );
}

// --- job 2: parse mcp/nutrition-server/server.mjs's TOOLS array — ground truth in code, NOT
// addons.ts's manifest (which the plan documents as already 2-tool drifted: reconcile_pantry /
// get_nutrition_status are served but unlisted there). -------------------------------------------
const serverSrc = readFileSync(SERVER_FILE, "utf8");
const toolsArrayMatch = serverSrc.match(/const TOOLS = \[([\s\S]*?)\n\];/);
if (!toolsArrayMatch) {
  console.error(`[shopping-list-consumers] could not find 'const TOOLS = [ … ];' in ${SERVER_FILE}`);
  process.exit(1);
}
const toolIdentifiers = [...new Set([...toolsArrayMatch[1].matchAll(/([A-Z][A-Z0-9_]*_TOOL)/g)].map((m) => m[1]))];
const shoppingToolNames = [];
for (const ident of toolIdentifiers) {
  const defMatch = serverSrc.match(new RegExp(`const ${ident} = \\{[\\s\\S]*?name:\\s*"([a-z_]+)"`));
  if (defMatch && defMatch[1].includes("shopping")) shoppingToolNames.push(defMatch[1]);
}
check(
  shoppingToolNames.length >= MIN_SHOPPING_TOOLS,
  `server.mjs's TOOLS array registers >= ${MIN_SHOPPING_TOOLS} tools containing 'shopping' (got ` +
    `${shoppingToolNames.length}: ${shoppingToolNames.join(", ")}) — read from the TOOLS array + each ` +
    `tool's own 'name' field, not a hand-maintained manifest`,
);

// --- every shopping tool must be named inside JOB 6, AND present in addons.ts's nutrition
// manifest (a mini sync-check that enforces the AC's registration requirement without trusting
// the manifest as the floor's SOURCE). -----------------------------------------------------------
const addonsSrc = readFileSync(ADDONS_FILE, "utf8");
const nutritionAddonMatch = addonsSrc.match(/const NUTRITION_ADDON: AddonManifest = \{[\s\S]*?\n\};/);
if (!nutritionAddonMatch) {
  console.error(`[shopping-list-consumers] could not find 'const NUTRITION_ADDON: AddonManifest = { … };' in ${ADDONS_FILE}`);
  process.exit(1);
}
const nutritionToolsMatch = nutritionAddonMatch[0].match(/tools:\s*\[([\s\S]*?)\]/);
const manifestTools = nutritionToolsMatch ? [...nutritionToolsMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];

for (const name of shoppingToolNames) {
  check(job6.includes(name), `JOB 6 names the tool '${name}' — not found as a literal substring of the JOB 6 section`);
  check(manifestTools.includes(name), `board/lib/addons.ts's NUTRITION_ADDON.mcp.tools lists '${name}'`);
}

// --- job 3: fixed, load-bearing, SECTION-SCOPED phrases (few, individually named) ---------------
const JOB6_PHRASES = [
  ["at most one", "the auto-mode batching rule (at most one consolidated question)"],
  ["exactly one", "the approval-mode batching rule (exactly one yes for the whole list)"],
  ["no output at all", "the clean-list-says-nothing rule"],
  ["offer one reconcile_pantry", "the offer-reconcile_pantry rule (never a silent inventory mutation)"],
  ["nothing routes through the pending queue", "the no-pending-queue rule (confirmation is conversational)"],
  ["(inferred — no printed date)", "ADR 0025 condition 4's load-bearing inference label"],
];
for (const [phrase, label] of JOB6_PHRASES) {
  check(containsPhrase(job6, phrase), `JOB 6 states ${label} ('${phrase}')`);
}
// ADR 0025 condition 4 is "the only one whose failure is invisible in a diff" — pinned at the
// MCP render hop too, not just in skill prose.
check(
  serverSrc.includes("(inferred — no printed date)"),
  "mcp/nutrition-server/server.mjs carries the '(inferred — no printed date)' label literally (the MCP render hop)",
);

// --- job 4: two source-level rule gates (prose rules from the AC, turned into greps) ------------
check(
  !/const\s+\w+\s*=\s*\d/.test(engineSrc),
  "board/lib/shopping-candidates.ts defines no numeric const (the AC's 'no new threshold constant' rule, as a gate — not prose)",
);
for (const f of ROUTE_FILES) {
  const src = readFileSync(f, "utf8");
  check(
    !src.includes("pending"),
    `${relative(REPO_ROOT, f)} never references 'pending' (nothing routes through the approval queue)`,
  );
}

// --- job 5: the route-vs-tool pair (always-run home; the api test's copy can SKIP without a
// board — the BOARD_UP guard) ----------------------------------------------------------------
check(serverSrc.includes("/api/nutrition/shopping"), "mcp/nutrition-server/server.mjs references /api/nutrition/shopping");
check(serverSrc.includes("shopping/candidates"), "mcp/nutrition-server/server.mjs references shopping/candidates");

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — JOB 6 consumes all ${keys.length} ShoppingCandidatesResult fields and names all ` +
    `${shoppingToolNames.length} shopping tools, the load-bearing phrases hold, the engine carries no ` +
    `new threshold constant, the routes never touch 'pending', and the route-vs-tool wiring matches.`,
);
