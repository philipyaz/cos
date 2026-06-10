// Resolve the ACTIVE vault — its on-disk location AND its Obsidian deep-link identity —
// for the board. Server-only (reads env + repo config). Mirrors principal.ts/retention.ts:
// an env → file → default precedence, memoized after the first resolve (config is static
// per process), and fail-safe (never throws).
//
// TWO concerns, two homes:
//   • The on-disk FOLDER (dir/name) — the single source of truth is config/cos.env
//     VAULT_NAME (the same value setup-vault writes, backup/config.mjs reads, and
//     load-config.sh derives VAULT_DIR from). The board parses cos.env directly.
//   • The OBSIDIAN identity (obsidianVaultId/obsidianVaultName) — used ONLY to build the
//     `obsidian://open?vault=…` deep-link in the case drawer. This lives in
//     config/settings.json (the board's per-machine prefs file, already read by
//     principal.ts/retention.ts) because the Obsidian-registered vault can have a
//     DIFFERENT name from the folder slug, AND because a deep-link by NAME is ambiguous
//     when two registered vaults share a basename — so we prefer the unique 16-char
//     vault ID, which setup-vault captures from ~/Library/Application Support/obsidian/
//     obsidian.json. A blank id ⇒ the client falls back to the display name.
//
// Why not read COS_VAULT_DIR from the board's process env? The board is launched by
// `next dev`/`next start` with NO env injection (ensure-bridges.sh runs as a child, it
// does not export into `next`), so COS_VAULT_DIR is normally UNSET here. We still honor
// it first (so a test/operator override works), then fall back to cos.env VAULT_NAME —
// which is exactly how backup-status.ts derives its paths.

import fs from "node:fs";
import path from "node:path";
import { parseCosEnv, nonEmpty } from "./cos-env";

export interface VaultConfig {
  /** Absolute path to the active vault root (what /api/vault reads). */
  dir: string;
  /** The on-disk folder slug (the last path segment of `dir`). */
  name: string;
  /** The unique 16-char Obsidian vault ID — the robust, unambiguous deep-link target. */
  obsidianVaultId: string | null;
  /** The Obsidian display name — deep-link fallback when no ID is configured. */
  obsidianVaultName: string | null;
}

// The board runs from REPO_ROOT/board, so config/ is one level up (same anchor
// principal.ts/backup-status.ts use). Re-derived per resolve, not cached as a const,
// so the memo can be reset between tests.
const DEFAULT_VAULT_NAME = "example-vault";

// A safe folder slug: letters/digits/dot/dash/underscore (matches backup/config.mjs's
// guard) AND explicitly NOT "." / ".." (which would pass the char-class but escape the
// vault parent when joined into a path). Anything else ⇒ fall back to the template.
function safeSlug(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";
}

let cached: VaultConfig | undefined;

export function resolveVaultConfig(): VaultConfig {
  if (cached !== undefined) return cached;
  cached = readVaultConfig();
  return cached;
}

function readVaultConfig(): VaultConfig {
  const repoRoot = path.resolve(process.cwd(), "..");
  const cosEnv = parseCosEnv(repoRoot);

  // ── Folder slug (name): env COS_VAULT_NAME → cos.env VAULT_NAME → example-vault.
  //    Slug-guarded before it is ever joined into a filesystem path.
  let name = DEFAULT_VAULT_NAME;
  const envName = process.env.COS_VAULT_NAME;
  if (nonEmpty(envName) && safeSlug(envName.trim())) {
    name = envName.trim();
  } else if (nonEmpty(cosEnv.VAULT_NAME) && safeSlug(cosEnv.VAULT_NAME.trim())) {
    name = cosEnv.VAULT_NAME.trim();
  }

  // ── Directory: env COS_VAULT_DIR (absolute, operator-supplied) → REPO_ROOT/vault/<name>.
  const envDir = process.env.COS_VAULT_DIR;
  const dir = nonEmpty(envDir)
    ? path.resolve(envDir.trim())
    : path.join(repoRoot, "vault", name);

  // ── Obsidian identity (settings.json, board-readable). env overrides for tests.
  const settings = readSettings(repoRoot);
  const obsidianVaultId =
    firstNonEmpty(process.env.COS_OBSIDIAN_VAULT_ID, settings.obsidianVaultId) ?? null;
  const obsidianVaultName =
    firstNonEmpty(process.env.COS_OBSIDIAN_VAULT_NAME, settings.obsidianVaultName) ?? name;

  return { dir, name, obsidianVaultId, obsidianVaultName };
}

// Read the two Obsidian keys from config/settings.json (repo root). Tolerates a missing
// / unreadable / malformed file (⇒ both undefined). Only these two keys are consumed here.
function readSettings(repoRoot: string): {
  obsidianVaultId?: string;
  obsidianVaultName?: string;
} {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "config", "settings.json"), "utf8");
    const j = JSON.parse(raw) as { obsidianVaultId?: unknown; obsidianVaultName?: unknown };
    return {
      obsidianVaultId: typeof j.obsidianVaultId === "string" ? j.obsidianVaultId : undefined,
      obsidianVaultName: typeof j.obsidianVaultName === "string" ? j.obsidianVaultName : undefined,
    };
  } catch {
    return {};
  }
}

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (nonEmpty(v)) return v.trim();
  return undefined;
}

// Test/maintenance escape hatch: drop the memo so a later resolve re-reads env + config.
export function _resetVaultConfigCache(): void {
  cached = undefined;
}
