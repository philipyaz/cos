// SERVER-ONLY reader comparing each operator skill this repo bundles against the copy
// Claude Cowork Desktop holds on THIS machine's disk — so Cowork-installed-skill drift
// becomes something the hub (and any agent asking get_device_status) can SEE, not just a
// receipt of what you meant to upload (see scripts/mark-skill-uploaded.mjs).
//
// FAILURE MODE: this reader must be a FALSE ALARM, never a FALSE REASSURANCE — an
// unreadable cache, an unrecognised manifest, or a per-skill I/O error all resolve to
// `unknown`, never `current`. The one named exception (disclosed, not fixed here): this
// reader compares against the WORKING TREE, so a hub checked out to a commit from BEFORE
// a skill merge can read that skill `current` while it is actually stale against `main`
// — see docs/architecture/multi-device.md's "Cowork skills" paragraph.
//
// MIRRORS scripts/pack-skills.mjs: discoverSkills (:46-58) and IGNORED/isIgnored (:40-41)
// are RE-IMPLEMENTED here rather than imported — board/ is a separate npm package
// (`allowJs: false`) and cannot import a .mjs from above its own root (ADR 0040's
// Context; ADR 0043's Considered-and-rejected also rules out spawning pack-skills.mjs
// per request). Same shape as the backup-status.ts / vault-status.ts server-only-reader
// family. Pinned by tests/unit/cowork-skills.test.ts, which runs this file's enumeration
// against `node scripts/pack-skills.mjs --list` — edit one, edit both, or the test will
// tell you. Sibling: scripts/check-cowork-secrets.mjs is the in-tree precedent for
// exactly this shape — a hub-local reader of Cowork's on-disk state behind a COWORK_*
// machine key, whose absent case names the key.
//
// The reader NEVER throws (the whole body sits in a top-level try/catch); nothing it
// reads is ever persisted (derived fresh on every read — no SCHEMA_VERSION bump, ADR
// 0017).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineValue, expandTilde } from "./cos-env";
import type { CoworkSkillRow, CoworkSkillState } from "./types";

const IGNORED = new Set([".DS_Store", "Thumbs.db", ".git", "node_modules", "__pycache__"]);
const isIgnored = (name: string): boolean => IGNORED.has(name) || name.startsWith("._") || name.endsWith("~");

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The default Cowork installed-skill cache location (macOS) — overridable via the
// COWORK_SKILLS_DIR machine config key (env > cos.env > this default, ADR 0043's
// machineValue chain), documented beside COWORK_CONFIG in config/cos.env.example.
function defaultCacheRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions", "skills-plugin");
}

function resolveCacheRoot(override?: string): string {
  return expandTilde(override && override.trim() ? override : machineValue("COWORK_SKILLS_DIR", defaultCacheRoot()));
}

// Two-candidate probe, NOT a bare cwd join (architect divergence 1). pack-skills.mjs
// resolves its root from the MODULE's own location (config/load-config.mjs), which
// bundled board code cannot do — a naive `join(cwd, ".claude", "skills")` resolves to
// the root SETUP-skills tree (16 dirs, every one holding a SKILL.md — a tree Cowork
// never sees by design) whenever cwd is the repo root, which is exactly where
// tests/run.sh [1] runs the unit tests from. Prefer the board tree when it exists;
// otherwise fall back to the naive join so a board-rooted cwd (`board/`, or the
// `.cos-test-board` sandbox) still resolves correctly.
function resolveSkillsDir(override?: string): string {
  if (override) return override;
  const boardRooted = path.join(process.cwd(), "board", ".claude", "skills");
  if (isDirectory(boardRooted)) return boardRooted;
  return path.join(process.cwd(), ".claude", "skills");
}

// Every directory under skillsDir that actually holds a SKILL.md — the mirror of
// pack-skills.mjs's discoverSkills(). An unreadable skillsDir (a broken checkout, not a
// Cowork state) yields [] — nothing to claim, never a Cowork-shaped `unknown` row.
function discoverRepoSkills(skillsDir: string): string[] {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isIgnored(e.name))
      .filter((e) => {
        try {
          return fs.statSync(path.join(skillsDir, e.name, "SKILL.md")).isFile();
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface WalkedFile {
  relPath: string; // posix-relative to the skill dir
  abs: string;
}

// Walk one skill folder → sorted, junk-filtered, posix-relative file list (+ absolute
// paths for byte reads). Mirrors pack-skills.mjs's collectFiles() walk + sort.
function walkSkillFolder(dir: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  const walk = (sub: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sub, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ relPath: path.relative(dir, abs).split(path.sep).join("/"), abs });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

// The repo-side enumeration: every bundled skill's sorted relative file list. Exported
// for the B2 pin test (tests/unit/cowork-skills.test.ts) and reused internally below —
// one walk implementation, so the pin test and the live comparison cannot drift apart.
export function repoSkillFiles(skillsDir?: string): { skill: string; files: string[] }[] {
  const dir = resolveSkillsDir(skillsDir);
  return discoverRepoSkills(dir).map((skill) => ({
    skill,
    files: walkSkillFolder(path.join(dir, skill)).map((f) => f.relPath),
  }));
}

// Stat-size shortcut first, then Buffer.equals only when sizes match — cheap for the
// common (unchanged) case, correct always.
function filesEqual(a: WalkedFile, b: WalkedFile): boolean {
  try {
    if (fs.statSync(a.abs).size !== fs.statSync(b.abs).size) return false;
    return fs.readFileSync(a.abs).equals(fs.readFileSync(b.abs));
  } catch {
    return false;
  }
}

// Equal path sets AND per-path byte equality ⇒ true. Any differing/missing/extra file
// (junk already excluded from both walks) ⇒ false.
function folderMatches(repoDir: string, installedDir: string): boolean {
  const repoFiles = walkSkillFolder(repoDir);
  const installedFiles = walkSkillFolder(installedDir);
  if (repoFiles.length !== installedFiles.length) return false;
  for (let i = 0; i < repoFiles.length; i++) {
    if (repoFiles[i]!.relPath !== installedFiles[i]!.relPath) return false;
    if (!filesEqual(repoFiles[i]!, installedFiles[i]!)) return false;
  }
  return true;
}

interface ManifestEntry {
  name?: unknown;
  updatedAt?: unknown;
  enabled?: unknown;
}

// Parse <userDir>/manifest.json into its `skills` array. null on any trouble (missing
// file, invalid JSON, wrong top-level shape, or `skills` not an array) — the caller
// treats null as "every row unknown", never as "empty ⇒ nothing installed".
function readManifestSkills(userDir: string): ManifestEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(userDir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const skills = (parsed as { skills?: unknown }).skills;
  return Array.isArray(skills) ? (skills as ManifestEntry[]) : null;
}

// The sole subdirectory of `dir`, excluding isIgnored names and dot-prefixed names —
// null when there isn't EXACTLY one (missing/unreadable dir, zero matches, or more than
// one). Used at both the org level and the user level one directory down.
function soleSubdirectory(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory() && !isIgnored(e.name) && !e.name.startsWith(".")).map((e) => e.name);
  return dirs.length === 1 ? dirs[0]! : null;
}

function unknownRow(skill: string): CoworkSkillRow {
  return { skill, state: "unknown", installedAt: null, enabled: null };
}

// The public read: compare every repo-bundled skill against Cowork's installed cache.
// opts.cacheRoot / opts.skillsDir override the machine-config / cwd-probe defaults (the
// unit test always passes both explicitly, pointing at synthetic tmpdir fixtures).
export function readCoworkSkills(opts?: { cacheRoot?: string; skillsDir?: string }): {
  rows: CoworkSkillRow[];
  staleCount: number;
} {
  try {
    const skillsDir = resolveSkillsDir(opts?.skillsDir);
    const repoSkills = discoverRepoSkills(skillsDir);
    if (repoSkills.length === 0) return { rows: [], staleCount: 0 };

    const cacheRoot = resolveCacheRoot(opts?.cacheRoot);
    const orgName = soleSubdirectory(cacheRoot);
    const userName = orgName ? soleSubdirectory(path.join(cacheRoot, orgName)) : null;
    if (!orgName || !userName) {
      return { rows: repoSkills.map(unknownRow), staleCount: 0 };
    }

    const userDir = path.join(cacheRoot, orgName, userName);
    const manifestSkills = readManifestSkills(userDir);
    if (manifestSkills === null) {
      return { rows: repoSkills.map(unknownRow), staleCount: 0 };
    }

    const rows: CoworkSkillRow[] = repoSkills.map((skill) => {
      try {
        const entry = manifestSkills.find((s) => typeof s.name === "string" && s.name === skill);
        const installedAt = typeof entry?.updatedAt === "string" ? entry.updatedAt : null;
        const enabled = typeof entry?.enabled === "boolean" ? entry.enabled : null;
        const installedDir = path.join(userDir, "skills", skill);
        const folderExists = isDirectory(installedDir);

        if (!entry && !folderExists) return { skill, state: "not-installed", installedAt, enabled };
        if (!folderExists) return { skill, state: "stale", installedAt, enabled };

        const state: CoworkSkillState = folderMatches(path.join(skillsDir, skill), installedDir) ? "current" : "stale";
        return { skill, state, installedAt, enabled };
      } catch {
        // Any per-skill I/O trouble ⇒ that row unknown — can't verify ⇒ never current.
        return unknownRow(skill);
      }
    });

    // B4: a deliberately disabled skill must not light a badge that never clears;
    // not-installed/unknown never count either (the never-a-false-reassurance rule).
    const staleCount = rows.filter((r) => r.state === "stale" && r.enabled !== false).length;
    return { rows, staleCount };
  } catch {
    return { rows: [], staleCount: 0 };
  }
}
