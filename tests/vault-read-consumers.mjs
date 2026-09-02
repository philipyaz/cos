#!/usr/bin/env node
// tests/vault-read-consumers.mjs — the ADR 0014 gate (cos-ops#57 step 1): fitness-health-data
// JOB 4 pushes a health report INTO the vault, and until this unit no sibling skill ever read it
// back — a closed loop that wasn't closed. This gate pins the read half: fitness-training-plan and
// fitness-weekly-review must each carry a numbered vault-read FETCH step (the `vault` MCP's
// `query`, plus the caller-side guardrails: knowledge-as-recorded, board claims verified,
// empty/unavailable never blocks) in their own context-gathering phase.
//
// Deliberately fitness-only (the SECONDED review's build-order split, cos-ops#57): mail-to-board
// and whatsapp-triage join this table when cos-ops#57 step 2 lands (held on cos#127); widening =
// adding rows to SKILLS below, not a new gate.
//
// Split of responsibilities: run.sh [3c] pins the PRODUCER copies of the ops#3 guardrail (the
// vault's own second-brain-query skill + the caller-side vault-operations skill, fixed-file
// `grep -qF`); this file is the CALLER-side complement, for the two fitness readers specifically.
//
// Family shape (ADR 0030): own file; rides the existing [2f] step id with its own echo +
// fail_reasons token rather than minting a new [2*] id; SECTION-scoped (never whole-file) — a
// qualifying section is a numbered `### N[.N] …` heading that names "vault", so a retitle that
// drops the word, or a deleted section, fails LOUDLY (that presence IS the gate's subject — unlike
// fitness-outcome-consumers' exit-1-on-missing-section idiom, a missing section here is a per-skill
// check() failure rather than a hard exit, so the on-main failing-first run lists BOTH skills in
// one pass); identifiers matched case-SENSITIVELY (`` `vault` ``, `` `query` ``, `` `board` ``),
// guardrail phrases matched case-INSENSITIVELY against the section's whole content string with a
// wrap-tolerant `[\s-]+` word separator, never line-by-line (these bodies wrap at ~72 columns, and
// board-organize's own copy of "knowledge as recorded" hyphenates it — the separator must survive
// both forms).
//
// Escape hatch: rewording a marker phrase is for genuine restructuring only — never a place to
// launder a dropped read step. A reword updates this gate in the SAME diff, visibly, or the run
// goes red the moment the wording drifts from what's pinned below.
//
// Static, read-only, zero deps.
//
//   node tests/vault-read-consumers.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config/load-config.mjs";

const SKILLS = [
  { name: "fitness-training-plan", file: join(REPO_ROOT, "board", ".claude", "skills", "fitness-training-plan", "SKILL.md") },
  { name: "fitness-weekly-review", file: join(REPO_ROOT, "board", ".claude", "skills", "fitness-weekly-review", "SKILL.md") },
];

// A qualifying section is a numbered procedure step whose HEADING names the vault — this survives
// a renumber (5.5 -> 6) and a retitle that keeps "vault". Only `###`-level headings are ever split
// into sections (see splitSections below), so `## Guardrails recap`'s own vault-mentioning bullet
// can never satisfy this by itself — it isn't a candidate section at all.
const HEADING_RE = /^###\s+[\d.]+.*vault/i;

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Wrap-tolerant phrase matcher (ADR 0030 clause 4): case-insensitive, whole-string, `[\s-]+`
// between words — so a hyphenated form (board-organize's own "knowledge-as-recorded") and a phrase
// reflowed across a line break both still match.
const phraseRegex = (phrase) =>
  new RegExp(
    phrase
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]+"),
    "i",
  );

const MARKERS = [
  { label: "the identifier `vault`", test: (body) => body.includes("`vault`") },
  { label: "the identifier `query`", test: (body) => body.includes("`query`") },
  { label: "the identifier `board`", test: (body) => body.includes("`board`") },
  { label: "the phrase 'knowledge as recorded'", test: (body) => phraseRegex("knowledge as recorded").test(body) },
  { label: "the phrase 'board claim'", test: (body) => phraseRegex("board claim").test(body) },
  { label: "the phrase 'never blocks'", test: (body) => phraseRegex("never blocks").test(body) },
];

// Split a SKILL.md into `###`-heading-delimited sections. A `## ` (level-2) heading is never a
// split point, so trailing prose under the LAST `###` section (e.g. `## Guardrails recap`) rides
// along inside that section's body — harmless here, since candidacy is decided on the HEADING
// alone, never on body content.
function splitSections(src) {
  const starts = [...src.matchAll(/^### .*$/gm)];
  return starts.map((m, i) => ({
    heading: m[0],
    body: src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
  }));
}

for (const skill of SKILLS) {
  const src = readFileSync(skill.file, "utf8");
  const candidates = splitSections(src).filter((s) => HEADING_RE.test(s.heading));

  if (candidates.length === 0) {
    check(
      false,
      `${skill.name}/SKILL.md has no vault-read step section (a numbered '### N[.N] …' heading naming "vault")`,
    );
    continue;
  }

  const passing = candidates.find((s) => MARKERS.every((m) => m.test(s.body)));
  const reported = passing ?? candidates[0];
  if (candidates.length > 1) {
    console.log(
      `  (${skill.name}: ${candidates.length} candidate vault-titled sections found; reporting against "${reported.heading}"` +
        (passing ? "" : " — none carries the full marker set") +
        ")",
    );
  }
  for (const marker of MARKERS) {
    check(marker.test(reported.body), `${skill.name}'s "${reported.heading}" section carries ${marker.label}`);
  }
}

if (failures) {
  console.error(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nPASS — ${SKILLS.map((s) => s.name).join(" + ")} each carry a vault-read step section with all ${MARKERS.length} markers.`,
);
