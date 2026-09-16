// tests/unit/store-path-defaults.test.ts — ADR 0029's host rule ("take the path from
// COS_BOARD_DATA and SKIP when it is unset; never default to board/data/cases.json, in any
// file, for any reason") as a gate (cos-ops#109). ADR 0029:108-110 names its own *Revisit when*
// home as `[2f]` under ADR 0030 — this gate lives in `[1]` instead (rides the working-tree glob,
// no `run.sh` edit, the shape `fixed-tab-widths.test.ts:57-59` already precedents), for two
// reasons the PR body also states: (i) `[2f]` is exactly where cos#127/#132/#133 all hold
// conflicting hunks, and (ii) ADR 0030's family is consumer *contracts*, not store paths.
//
// Predicate: for every direct-child `tests/*.mjs` file, with comments stripped, find each
// `process.env.<KEY>` `||`/`??` fallback (resolving a bare-identifier fallback through its
// same-file `const` — no such `const` is itself a violation, exactly how a literal anchor gets
// dodged) and fail if the (resolved) expression names the repo's `board/data`: a
// `"board", "data"` path-segment pair or a literal `board/data/` string.
//
// Must stay green: the three ratified `|| ""` exemplars (api-nutrition-shopping.mjs,
// api-nutrition-shelf-life.mjs, api-schema-guard.mjs); api-vault.mjs's `VAULT_SERVER` and
// mcp-kit-idle.mjs's `BOARD_SERVER` (both fall back into `mcp/`, never `board/data/`); every
// `CRM_BASE_URL || "http://localhost:3000"` (37 files — an implicit-board-URL question ADR 0029
// itself routes to the architect, out of this gate's scope); `concurrency.mjs`'s
// `COS_CONCURRENCY || 25`; `board-lint.mjs` (argv-based, read-only, out of the predicate by
// construction); `backup-hardening.mjs` (temp-dir joins, not env fallbacks).
//
// The regex sees ONLY member-access fallbacks (`process.env.KEY ||`/`??`) — the six
// `{ ...process.env }` spreads (api-vault.mjs, backup-hardening.mjs, gen-roles.mjs ×2,
// mcp-kit-idle.mjs, upgrade-check.mjs) and boardapp-deploy.mjs's `"process.env"` string literal
// are invisible by construction and must NOT be banned (a wider "no other process.env shape"
// rule is red on the fixed tree). Ternary and destructuring-default fallback forms are
// recognised NOT AT ALL, because 0 exist in `tests/` today — this stays true on the FIXED tree
// too: api-prefs.mjs's own fix puts its ternary on the already-resolved `DATA_FILE` local, never
// directly on `process.env`. Extend this scan if a ternary-on-`process.env` or a
// destructuring-default fallback ever appears.
//
// `stripComments` (imported from `./tsx-controls.mjs`) is used here for the first time outside
// `board/components/**`; measured this session over all 57 direct-child `tests/*.mjs` files:
// length-preserving with 0 length changes, and all 77 `process.env.` occurrences survive the
// strip unharmed.
//
// Denominator (re-derived this session, over the 57 direct-child `tests/*.mjs` files this gate
// actually reads — NOT the issue's 72-over-115-tracked-files count, a different, larger
// population): 75 total `process.env` `||`/`??` fallbacks — CRM_BASE_URL 37, COS_BOARD_DATA 31,
// COS_GUARD_URL 3, the now-deleted prefs-path env key 1 (this unit deletes it — see AC 3, and
// this sentence deliberately does not spell its name so `git grep` for it still returns
// nothing), VAULT_SERVER 1, COS_CONCURRENCY 1, BOARD_SERVER 1.
//
// Run: `node --test tests/unit/store-path-defaults.test.ts` (hub Node >= 23 strips types
// unflagged — also rides `tests/run.sh`'s `tests/unit/*.test.ts` glob, `run.sh:510`/`:540`, so
// this new file needs no `run.sh` edit either).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, "..");

const FALLBACK_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*(\|\||\?\?)\s*([\s\S]*?);/g;
const BARE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BOARD_DATA_PAIR_RE = /["']board["']\s*,\s*["']data["']/;

interface ScanResult {
  violations: string[];
  fallbacksSeen: number;
}

function fallsIntoBoardData(expr: string): boolean {
  return BOARD_DATA_PAIR_RE.test(expr) || expr.includes("board/data/");
}

/** Resolve a bare-identifier fallback through its same-file `const <name> = <expr>;` — null
 * when no such const exists (itself a violation: exactly how a literal anchor gets dodged). */
function resolveIdentifier(src: string, name: string): string | null {
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*([\\s\\S]*?);");
  const m = re.exec(src);
  return m ? m[1] : null;
}

function listDirectChildMjsFiles(): string[] {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
}

/** Scan one file's stripped source for every `process.env.<KEY> ||`/`??` fallback. */
function scanFile(file: string): ScanResult {
  const raw = fs.readFileSync(path.join(TESTS_DIR, file), "utf8");
  const src = stripComments(raw);
  const violations: string[] = [];
  let fallbacksSeen = 0;

  FALLBACK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FALLBACK_RE.exec(src))) {
    fallbacksSeen++;
    const key = m[1];
    let expr = m[3].trim();
    const line = src.slice(0, m.index).split("\n").length;

    if (BARE_IDENTIFIER_RE.test(expr)) {
      const resolved = resolveIdentifier(src, expr);
      if (resolved === null) {
        violations.push(`${file}:${line} — ${key} falls back into board/data`);
        continue;
      }
      expr = resolved;
    }

    if (fallsIntoBoardData(expr)) {
      violations.push(`${file}:${line} — ${key} falls back into board/data`);
    }
  }

  return { violations, fallbacksSeen };
}

function scanAll(): { files: string[] } & ScanResult {
  const files = listDirectChildMjsFiles();
  const violations: string[] = [];
  let fallbacksSeen = 0;
  for (const file of files) {
    const result = scanFile(file);
    violations.push(...result.violations);
    fallbacksSeen += result.fallbacksSeen;
  }
  return { files, violations, fallbacksSeen };
}

test("gate: no tests/*.mjs resolves a process.env fallback into the repo's board/data (ADR 0029, cos-ops#109)", () => {
  const { violations } = scanAll();
  if (violations.length > 0) {
    assert.fail(`${violations.length} store-path-default violation(s):\n${violations.join("\n")}`);
  }
});

test("loud existence: the corpus is non-empty (ADR 0041)", () => {
  const { files } = scanAll();
  console.log(`store-path-defaults: read ${files.length} tests/*.mjs files`);
  assert.ok(files.length > 0, "expected at least one direct-child tests/*.mjs file to scan");
});

test("vacuous-pass floor: the scan reaches a meaningful number of process.env fallbacks", () => {
  const { fallbacksSeen } = scanAll();
  console.log(`store-path-defaults: ${fallbacksSeen} process.env ||/?? fallbacks seen`);
  assert.ok(
    fallbacksSeen >= 30,
    `expected >=30 process.env ||/?? fallbacks across the corpus, got ${fallbacksSeen}`,
  );
});
