// dependabot-config.test.ts — pins the /board ecosystem's majors-only `ignore` block, and the
// repo-wide invariant that makes it safe: every `ignore` entry names `update-types`, and every
// value is a version-update:* type.
//
// WHY THIS TEST EXISTS
// ────────────────────
// eslint-config-next pins typescript-eslint@^8.46.0, whose peer range is
// typescript ">=4.8.4 <6.1.0" — so a Dependabot-proposed TypeScript 7 / ESLint 10 major
// deterministically fails `npm run lint` ("typescript-eslint does not support TS 7.0", exit 2).
// .github/dependabot.yml (cos-ops#64) holds back both packages' MAJOR updates with an `ignore`
// block scoped by `update-types: ["version-update:semver-major"]` — patch/minor bumps, and any
// future SECURITY update for either package, still flow. Dropping that qualifier would silently
// suppress security updates too (dependabot/dependabot-core#4027) — the exact inversion of the
// block's purpose, and exactly the kind of change that leaves no other trace until a security PR
// silently never opens (ADR 0014: "a gate that skips looks exactly like a gate that passed").
//
// This test pins the shape as a STRUCTURAL lint of the source, not a prose comment (ADR 0024's
// boundary: the RULE is repo-observable, so it gets a gate; the removal condition lives in a
// transitive npm manifest this repo can't assert on, so that part stays prose in the YAML
// comment). A real YAML parse would be unsafe here — no `yaml`/`js-yaml` package exists in the
// root workspace (only board/node_modules carries one, transitively, and importing it from
// tests/unit/ would couple this repo-wide step to board's install state) — so this is a
// hand-written line-scanner over the file's own committed 2-space indent discipline. Reads only
// committed repo content: no machine-local state, no env key, no SKIP case (ADR 0029 does not
// attach).
//
// Run via the repo's unit harness: `node --test tests/unit/dependabot-config.test.ts`
// (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "..", "..", ".github", "dependabot.yml");
const RAW = readFileSync(CONFIG_PATH, "utf8");
const LINES = RAW.split("\n");

type Block = { start: number; lines: string[] };
type Entry = { name: string; updateTypesRaw: string; line: number };
type Section = { ecosystemHeader: string; directory: string; entries: Entry[] };

// ── shared parsing — ONE path, consumed by every subtest below that needs it, so a broken ──
// indent assumption breaks every subtest at once rather than letting one drift green while
// another goes red on a different path (ADR 0014).

// Splits the file into per-ecosystem blocks on the list-item marker `  - package-ecosystem:`.
// Each block runs from its own marker line up to (not including) the next one, or EOF.
function splitEcosystemBlocks(lines: string[]): Block[] {
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^  - package-ecosystem:/.test(line)) starts.push(i);
  });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return { start, lines: lines.slice(start, end) };
  });
}

function directoryOf(block: string[]): string {
  const dirLine = block.find((l) => /^    directory:\s*/.test(l));
  return dirLine ? dirLine.replace(/^    directory:\s*/, "").trim() : "";
}

// Quote-tolerant: `"x"` and `'x'` are the same YAML scalar.
function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Value extraction is quote-tolerant — NOT JSON.parse, which would pin double-quote style and
// turn a harmless `['x']` vs `["x"]` edit into a false red for semantically identical YAML.
// Fails closed: an update-types line this can't read must not silently read as "no values".
function extractListValues(raw: string, lineNo: number): string[] {
  const trimmed = raw.trim();
  const m = trimmed.match(/^\[(.*)\]$/);
  if (!m) {
    assert.fail(`could not extract a value list from line ${lineNo}: update-types: ${raw}`);
  }
  const inner = m[1].trim();
  if (inner === "") return [];
  return inner.split(",").map((v) => stripQuotes(v));
}

// Returns every `ignore:` section in the file (any ecosystem, not just /board) as
// { ecosystemHeader, directory, entries: [{ name, updateTypesRaw, line }] }. Fails closed on a
// malformed entry (an ignore: with zero parseable entries, or a dependency-name with no
// update-types line right after it) rather than silently dropping it — a gate that skips looks
// exactly like a gate that passed.
function parseIgnoreSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  for (const { start, lines: block } of splitEcosystemBlocks(lines)) {
    const headerMatch = block[0].match(/^  - package-ecosystem:\s*(.+)$/);
    const ecosystemHeader = headerMatch ? headerMatch[1].trim() : "";
    const directory = directoryOf(block);
    const ignoreIdx = block.findIndex((l) => /^    ignore:\s*$/.test(l));
    if (ignoreIdx === -1) continue;

    const entries: Entry[] = [];
    for (let i = ignoreIdx + 1; i < block.length; i++) {
      const entryMatch = block[i].match(/^      - dependency-name:\s*(.+)$/);
      if (!entryMatch) {
        if (/^ {8}/.test(block[i])) continue; // an update-types line already consumed below
        break; // dedent out of the ignore list (blank line, or the block's end)
      }
      const name = stripQuotes(entryMatch[1]);
      const utLineIdx = i + 1;
      const utLine = block[utLineIdx];
      const utMatch = utLine ? utLine.match(/^        update-types:\s*(.+)$/) : null;
      if (!utMatch) {
        assert.fail(
          `ignore entry "${name}" at line ${start + i + 1} has no update-types line immediately after it`,
        );
      }
      entries.push({ name, updateTypesRaw: utMatch![1].trim(), line: start + utLineIdx + 1 });
    }
    if (entries.length === 0) {
      assert.fail(`ignore: at line ${start + ignoreIdx + 1} has zero parseable entries`);
    }
    sections.push({ ecosystemHeader, directory, entries });
  }
  return sections;
}

// ── subtest 1 — the ADR 0014 red-first demonstration: the /board block has an ignore key ────
test("the /board ecosystem carries an ignore key", () => {
  const boardBlocks = splitEcosystemBlocks(LINES).filter((b) => directoryOf(b.lines) === "/board");
  assert.equal(
    boardBlocks.length,
    1,
    `expected exactly one ecosystem block with directory: /board, found ${boardBlocks.length}`,
  );
  const hasIgnore = boardBlocks[0].lines.some((l) => /^    ignore:\s*$/.test(l));
  assert.ok(hasIgnore, "expected the /board ecosystem block to contain an `    ignore:` key");
});

// ── subtest 2 — the /board ignore holds exactly the two majors this repo can't take ─────────
test("the /board ignore holds exactly typescript and eslint, majors only", () => {
  const sections = parseIgnoreSections(LINES);
  const board = sections.find((s) => s.directory === "/board");
  assert.ok(board, "expected an ignore section for the /board ecosystem");
  const names = board!.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ["eslint", "typescript"]);
  for (const entry of board!.entries) {
    const values = extractListValues(entry.updateTypesRaw, entry.line);
    assert.deepEqual(
      values,
      ["version-update:semver-major"],
      `entry "${entry.name}" (line ${entry.line}) must ignore majors only`,
    );
  }
});

// ── subtest 3 — the repo-wide security-suppression gate: EVERY ignore, EVERY ecosystem ──────
test("no ignore entry anywhere in the file omits update-types, and every value is a version-update:* type", () => {
  const sections = parseIgnoreSections(LINES);
  // Floor: zero sections would make every check below pass vacuously — exactly the failure
  // mode ADR 0014 warns about. After cos-ops#64 the file has one section (/board); subtest 2
  // above already pins its two entries into existence, so this only needs "at least one".
  assert.ok(sections.length >= 1, "expected at least one ignore section in the file (today: /board)");
  for (const section of sections) {
    for (const entry of section.entries) {
      const values = extractListValues(entry.updateTypesRaw, entry.line);
      assert.ok(
        values.length > 0,
        `entry "${entry.name}" (line ${entry.line}) has an empty update-types list — a bare ` +
          `ignore also suppresses SECURITY updates (dependabot/dependabot-core#4027)`,
      );
      for (const v of values) {
        assert.ok(
          v.startsWith("version-update:"),
          `entry "${entry.name}" (line ${entry.line}) has a non-version-update value "${v}" in update-types`,
        );
      }
    }
  }
});
