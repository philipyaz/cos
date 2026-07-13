// Backup configuration. Repo-root-relative scope paths + locations.
// Nothing secret lives here — the AES-256 key is resolved separately (Keychain/env).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This file is backup/config.mjs → repo root is one level up. COS_BACKUP_REPO_ROOT
// exists ONLY so the hermetic test (tests/backup-hardening.mjs) can point the whole
// pipeline at a synthetic skeleton — real runs never set it. DEFAULT_REPO_ROOT is
// exported so backup.mjs's identity gate (assertDefaultRepoOrRefuse) can refuse an
// overridden root the same way it refuses an overridden repo — fail closed unless
// the COS_BACKUP_ALLOW_NONDEFAULT=1 test escape hatch is set.
export const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const REPO_ROOT =
  process.env.COS_BACKUP_REPO_ROOT && process.env.COS_BACKUP_REPO_ROOT.trim()
    ? path.resolve(process.env.COS_BACKUP_REPO_ROOT.trim())
    : DEFAULT_REPO_ROOT;

// ── config/cos.env reader (fail-safe; mirrors board/lib/principal.ts discipline) ──
// config/cos.env is the machine-local public config (paths/ports/binaries). It is a
// SHELL env file of QUOTED KEY="value" lines, read by the setup skills via a loader
// that is NOT wired into launchd and NOT read here — so this Node side must PARSE the
// file ITSELF (it cannot rely on the loader exporting anything). The board side
// (board/lib/backup-status.ts) re-implements this same reader — the two can't
// cross-import (this .mjs lives outside the Next root), so the logic is duplicated.
// Every read is wrapped so a missing/unreadable/garbage file degrades to {} — never throws.
function parseCosEnv(repoRoot) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(repoRoot, "config", "cos.env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      // Strip ONE layer of surrounding single OR double quotes (values are always quoted).
      if (
        v.length >= 2 &&
        ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* no cos.env / not readable / odd contents ⇒ {} (callers fall back to defaults) */
  }
  return out;
}

// Expand a leading "~" / "~/" to $HOME (cos.env values may use ~). Other paths pass through.
function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

const cosEnv = parseCosEnv(REPO_ROOT);

// The standard value chain for a machine setting: env > cos.env > fallback.
// Callers keep any post-processing (slug validation, sanitizing) local.
const envOrCosEnv = (name, fallback) =>
  (process.env[name] && process.env[name].trim()) || (nonEmpty(cosEnv[name]) ? cosEnv[name].trim() : fallback);

// The EXPECTED backup repo — the SINGLE source of truth is config/cos.env BACKUP_REPO,
// falling back to the ~/.cos-backups default when it is absent. This is what the
// run-gate (assertDefaultRepoOrRefuse) refuses to deviate from, and what the board's
// readiness probe treats as the canonical repo location.
export const EXPECTED_BACKUP_REPO = nonEmpty(cosEnv.BACKUP_REPO)
  ? expandTilde(cosEnv.BACKUP_REPO.trim())
  : path.join(os.homedir(), ".cos-backups");

// Where this process reads/writes — the COS_BACKUP_REPO env override (tests/sandboxes)
// wins; otherwise the cos.env-configured EXPECTED path. restore.mjs imports this.
export const BACKUP_REPO =
  process.env.COS_BACKUP_REPO && process.env.COS_BACKUP_REPO.trim()
    ? process.env.COS_BACKUP_REPO.trim()
    : EXPECTED_BACKUP_REPO;

// Provenance of the effective repo path (surfaced by the board's diagnostics UI).
export const repoSource = process.env.COS_BACKUP_REPO?.trim()
  ? "env"
  : nonEmpty(cosEnv.BACKUP_REPO)
    ? "cos.env"
    : "default";

// macOS Keychain item holding the AES-256 recovery passphrase (the "recovery key").
export const KEYCHAIN_SERVICE =
  process.env.COS_BACKUP_KEYCHAIN_SERVICE || "cos-backup-key";
export const KEYCHAIN_ACCOUNT =
  process.env.COS_BACKUP_KEYCHAIN_ACCOUNT || os.userInfo().username;

// The ACTIVE vault to back up — named by config/cos.env VAULT_NAME (what setup-vault
// records + the loader exports), NOT a hardcoded name, so a renamed/relocated vault is
// always captured instead of silently falling out of scope. Precedence env > cos.env >
// the historical default. VAULT_NAME is a slug (setup-vault validates it); we reject any
// value with a path separator / traversal so a malformed name can't widen the tar scope.
const rawVaultName = envOrCosEnv("VAULT_NAME", "my-personal-thoughts-vault");
const vaultName = /^[A-Za-z0-9._-]+$/.test(rawVaultName) ? rawVaultName : "my-personal-thoughts-vault";
export const VAULT_SCOPE_PATH = `vault/${vaultName}`;
// Whether a vault name is actually CONFIGURED on this machine (env or cos.env),
// vs merely defaulted. restore.mjs maps a snapshot's vault onto the local name
// ONLY when configured — on a fresh DR machine with no cos.env yet, mapping onto
// the legacy default would misfile a correctly-named snapshot vault.
export const VAULT_NAME_CONFIGURED = Boolean(
  (process.env.VAULT_NAME && process.env.VAULT_NAME.trim()) || nonEmpty(cosEnv.VAULT_NAME),
);

// The stable per-machine identity that keys this producer's manifests/<id>.json.
// Precedence env > cos.env > a sanitized hostname fallback. The fallback exists
// only until the device-role work (multi-device PR 3) mints a real COS_DEVICE_ID
// at setup time — a hostname keeps two machines' manifests apart in the common
// case, but it is NOT unique by construction (a replacement Mac often inherits
// its predecessor's computer name), which is exactly why producer admission in
// backup.mjs keys on a MACHINE-LOCAL marker + key fingerprint, never on this id.
// Sanitized to a filename-safe slug so a hostname can never traverse out of
// manifests/. MIRRORED (not imported) by board/lib/backup-status.ts.
const rawDeviceId = envOrCosEnv("COS_DEVICE_ID", os.hostname());
export const DEVICE_ID = rawDeviceId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "unknown-device";

// The local board's base URL — restore.mjs probes it before --apply (restoring
// over a RUNNING board lets an in-flight mutate serialize its stale in-memory
// state right back over the freshly-restored file). cos.env stores BOARD_PORT
// (BOARD_URL is a value the shell loader DERIVES from it — mirror that here);
// an explicit BOARD_URL in env/cos.env still wins for exotic setups.
export const BOARD_URL = envOrCosEnv(
  "BOARD_URL",
  `http://localhost:${/^\d+$/.test(envOrCosEnv("BOARD_PORT", "3000")) ? envOrCosEnv("BOARD_PORT", "3000") : "3000"}`,
).replace(/\/$/, "");

// What gets backed up — repo-root-relative files or directories.
// (All real, live runtime stores that currently have NO off-site backup.)
export const SCOPE = [
  "board/data/cases.json", // the board: cases, messages, reminders, events, labels
  "board/data/prefs.json", // per-user board view state
  "guard/data/trusted-senders.json", // sender trust graph
  "guard/data/quarantine.json", // quarantine records
  "config/settings.json", // principal email, toggles
  "config/auto-sync.json", // router auto-sync switch (if present)
  VAULT_SCOPE_PATH, // the ACTIVE vault (config/cos.env VAULT_NAME) — not a hardcoded name
];
