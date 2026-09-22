// cowork-skills.test.ts — pins board/lib/cowork-skills.ts, the reader that compares each
// operator skill this repo bundles against the copy Claude Cowork Desktop holds on this
// machine's disk (ops#117). Everything here is SYNTHETIC — invented skill names/bytes,
// invented account/user directory names — no real account ids, no personal data, no live
// reads outside tmpdir fixtures.
//
// Run via the repo's unit harness: `node --test tests/unit/cowork-skills.test.ts`
// (and tests/run.sh [1]).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readCoworkSkills, repoSkillFiles } from "../../board/lib/cowork-skills";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TS_RESOLVE = path.join(HERE, "ts-resolve.mjs");
const DRIVER = path.join(HERE, "cowork-skills.driver.ts");
const NODE_TS_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "--import", TS_RESOLVE];

// ── Fixture helpers ─────────────────────────────────────────────────────────────
// Every fixture dir is tracked and removed in `after`. `write` mkdirs the parent chain,
// so a test builds a whole skill/cache tree with flat calls.
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cos-cowork-skills-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
function write(root: string, rel: string, content: string): void {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
// Builds a manifest.json body shaped like the live cache's `{ lastUpdated, skills: […] }`
// (skillId, name, description, creatorType, updatedAt, enabled per entry).
function manifestJson(entries: Array<{ name: string; updatedAt?: string; enabled?: boolean }>): string {
  return JSON.stringify({
    lastUpdated: "2026-09-01T00:00:00.000Z",
    skills: entries.map((e) => ({
      skillId: `id-${e.name}`,
      name: e.name,
      description: "synthetic fixture skill",
      creatorType: "user",
      updatedAt: e.updatedAt,
      enabled: e.enabled,
    })),
  });
}

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── Row 1 ────────────────────────────────────────────────────────────────────────
test("byte-equal folder (incl. references/) + manifest entry ⇒ current, installedAt + enabled carried", () => {
  const repoDir = tmp("repo1");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  write(repoDir, "alpha/references/notes.md", "notes v1\n");

  const cacheDir = tmp("cache1");
  write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
  write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
  write(cacheDir, "org-x/user-y/skills/alpha/references/notes.md", "notes v1\n");

  const { rows, staleCount } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { skill: "alpha", state: "current", installedAt: "2026-08-01T00:00:00.000Z", enabled: true });
  assert.equal(staleCount, 0);
});

// ── Row 2 ────────────────────────────────────────────────────────────────────────
test("a one-byte difference confined to references/notes.md ⇒ stale (a references-only edit is not invisible)", () => {
  const repoDir = tmp("repo2");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  write(repoDir, "alpha/references/notes.md", "notes v1\n");

  const cacheDir = tmp("cache2");
  write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
  write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n"); // identical
  write(cacheDir, "org-x/user-y/skills/alpha/references/notes.md", "notes v2\n"); // one byte off

  const { rows, staleCount } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
  assert.equal(rows[0]?.state, "stale");
  assert.equal(staleCount, 1);
});

// ── Row 3 ────────────────────────────────────────────────────────────────────────
test("a missing file, and separately an extra file, in the installed copy ⇒ stale", () => {
  {
    const repoDir = tmp("repo3a");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    write(repoDir, "alpha/references/notes.md", "notes v1\n");
    const cacheDir = tmp("cache3a");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n"); // missing references/notes.md
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.equal(rows[0]?.state, "stale", "installed copy missing a repo file ⇒ stale");
  }
  {
    const repoDir = tmp("repo3b");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache3b");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    write(cacheDir, "org-x/user-y/skills/alpha/extra.md", "surprise\n"); // an extra file the repo doesn't have
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.equal(rows[0]?.state, "stale", "installed copy has an extra file ⇒ stale");
  }
});

// ── Row 4 ────────────────────────────────────────────────────────────────────────
test("manifest entry present with no installed folder ⇒ stale; Finder junk in the installed folder does not flip an otherwise-equal skill stale", () => {
  {
    const repoDir = tmp("repo4a");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache4a");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    // no org-x/user-y/skills/alpha folder at all
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.equal(rows[0]?.state, "stale", "an entry with no installed folder ⇒ stale, not not-installed");
  }
  {
    const repoDir = tmp("repo4b");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache4b");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    write(cacheDir, "org-x/user-y/skills/alpha/.DS_Store", "junk");
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.equal(rows[0]?.state, "current", "Finder junk in the installed copy must not flip an otherwise byte-equal skill to stale");
  }
});

// ── Row 5 ────────────────────────────────────────────────────────────────────────
test("no manifest entry and no installed folder ⇒ not-installed, and it never counts toward staleCount", () => {
  const repoDir = tmp("repo5");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  write(repoDir, "beta/SKILL.md", "beta v1\n");
  const cacheDir = tmp("cache5");
  write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
  write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
  // beta has no manifest entry and no installed folder
  const { rows, staleCount } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
  const beta = rows.find((r) => r.skill === "beta");
  assert.equal(beta?.state, "not-installed");
  assert.equal(beta?.installedAt, null);
  assert.equal(beta?.enabled, null);
  assert.equal(staleCount, 0, "not-installed never counts toward staleCount");
});

// ── Row 6 ────────────────────────────────────────────────────────────────────────
test("cache root absent ⇒ every row unknown, staleCount 0", () => {
  const repoDir = tmp("repo6");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  write(repoDir, "beta/SKILL.md", "beta v1\n");
  const missingCache = path.join(tmp("cache6-parent"), "does-not-exist");
  const { rows, staleCount } = readCoworkSkills({ cacheRoot: missingCache, skillsDir: repoDir });
  assert.equal(rows.length, 2, "every repo skill still gets a row");
  assert.ok(rows.every((r) => r.state === "unknown"), "every row is unknown when the cache root can't be read");
  assert.equal(staleCount, 0);
});

// ── Row 7 ────────────────────────────────────────────────────────────────────────
test("two org directories, and separately two user directories, ⇒ every row unknown", () => {
  {
    const repoDir = tmp("repo7a");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache7a");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    write(cacheDir, "org-z/.keep", ""); // a second org dir
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.ok(rows.every((r) => r.state === "unknown"), "two org dirs ⇒ unknown");
  }
  {
    const repoDir = tmp("repo7b");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache7b");
    write(cacheDir, "org-x/user-y/manifest.json", manifestJson([{ name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true }]));
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    write(cacheDir, "org-x/user-w/.keep", ""); // a second user dir under the SAME org
    const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
    assert.ok(rows.every((r) => r.state === "unknown"), "two user dirs under one org ⇒ unknown");
  }
});

// ── Row 8 ────────────────────────────────────────────────────────────────────────
test("manifest not the recognised shape (top-level array; and separately invalid JSON) ⇒ every row unknown, and neither throws", () => {
  {
    const repoDir = tmp("repo8a");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache8a");
    write(cacheDir, "org-x/user-y/manifest.json", JSON.stringify([{ name: "alpha" }])); // top-level array, not { skills: […] }
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    assert.doesNotThrow(() => {
      const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
      assert.ok(rows.every((r) => r.state === "unknown"), "a top-level-array manifest ⇒ unknown");
    });
  }
  {
    const repoDir = tmp("repo8b");
    write(repoDir, "alpha/SKILL.md", "alpha v1\n");
    const cacheDir = tmp("cache8b");
    write(cacheDir, "org-x/user-y/manifest.json", "{not valid json");
    write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n");
    assert.doesNotThrow(() => {
      const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
      assert.ok(rows.every((r) => r.state === "unknown"), "invalid JSON ⇒ unknown");
    });
  }
});

// ── Row 9 (B4) ───────────────────────────────────────────────────────────────────
test("B4 — a disabled-in-Cowork skill still reads stale, but is excluded from staleCount; an enabled stale sibling keeps the count at exactly 1", () => {
  const repoDir = tmp("repo9");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  write(repoDir, "beta/SKILL.md", "beta v1\n");
  const cacheDir = tmp("cache9");
  write(
    cacheDir,
    "org-x/user-y/manifest.json",
    manifestJson([
      { name: "alpha", updatedAt: "2026-08-01T00:00:00.000Z", enabled: false },
      { name: "beta", updatedAt: "2026-08-01T00:00:00.000Z", enabled: true },
    ]),
  );
  write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha DIFFERENT\n"); // stale, disabled
  write(cacheDir, "org-x/user-y/skills/beta/SKILL.md", "beta DIFFERENT\n"); // stale, enabled

  const { rows, staleCount } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
  const alpha = rows.find((r) => r.skill === "alpha");
  const beta = rows.find((r) => r.skill === "beta");
  assert.equal(alpha?.state, "stale");
  assert.equal(alpha?.enabled, false);
  assert.equal(beta?.state, "stale");
  assert.equal(beta?.enabled, true);
  assert.equal(staleCount, 1, "the disabled stale skill must not count; the enabled stale sibling must");
});

// ── Row 10 ───────────────────────────────────────────────────────────────────────
test("unknown is never current: an unrecognised manifest never yields current even when the installed folder is byte-equal to the repo", () => {
  const repoDir = tmp("repo10");
  write(repoDir, "alpha/SKILL.md", "alpha v1\n");
  const cacheDir = tmp("cache10");
  write(cacheDir, "org-x/user-y/manifest.json", "not even json");
  write(cacheDir, "org-x/user-y/skills/alpha/SKILL.md", "alpha v1\n"); // byte-equal to the repo copy
  const { rows } = readCoworkSkills({ cacheRoot: cacheDir, skillsDir: repoDir });
  assert.equal(rows[0]?.state, "unknown", "an unreadable manifest must never let a byte-equal folder read as current");
});

// ── Row 11 + 11b ─────────────────────────────────────────────────────────────────
// B2 pin (repo-only, runs in CI, no Cowork state needed): repoSkillFiles() must report
// the SAME skill set + per-skill file lists as `node scripts/pack-skills.mjs --list` —
// the mirror ADR 0040 requires. Never import pack-skills.mjs (it runs its main at module
// level); spawn it instead.
test("B2 pin — repoSkillFiles(real repo tree) matches `node scripts/pack-skills.mjs --list`, and the no-argument default resolves the same tree from the repo root (architect divergence 1)", () => {
  const listOut = execFileSync(process.execPath, ["scripts/pack-skills.mjs", "--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const fromList: { skill: string; files: string[] }[] = [];
  let current: { skill: string; files: string[] } | null = null;
  for (const line of listOut.split("\n")) {
    const header = line.match(/^(\S+)  \(/);
    if (header) {
      current = { skill: header[1]!, files: [] };
      fromList.push(current);
      continue;
    }
    if (line.startsWith("    ") && current) {
      const rel = line.slice(4);
      const prefix = `${current.skill}/`;
      current.files.push(rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
    }
  }
  assert.ok(fromList.length > 0, "pack-skills.mjs --list must report at least one skill on this checkout");

  const fromReader = repoSkillFiles(path.join(REPO_ROOT, "board", ".claude", "skills"));
  assert.deepEqual(
    fromReader,
    fromList,
    "repoSkillFiles(explicit path) must match pack-skills.mjs --list's skill set AND per-skill file lists exactly",
  );

  // 11b — the no-argument default, exercised with cwd = REPO_ROOT (run.sh [1]'s own cwd
  // for the unit tests — exactly the input that used to resolve to the root SETUP-skills
  // tree under a naive cwd join; architect divergence 1). Spawned (not chdir'd in-process)
  // so this test can never mutate this process's own cwd for tests that run after it.
  const driverOut = execFileSync(process.execPath, [...NODE_TS_FLAGS, DRIVER], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.deepEqual(
    JSON.parse(driverOut),
    fromReader,
    "repoSkillFiles() with no argument must resolve the same board/.claude/skills tree when cwd is the repo root",
  );
});
