// SERVER-ONLY reader for config/cos.env — the repo's machine-config file.
//
// config/cos.env is a SHELL env file of QUOTED KEY="value" lines, written by
// cos-setup / setup-vault. The setup-skills loader (config/load-config.sh) is NOT
// wired into the board process (board/package.json runs `next dev`/`next start`
// with no env injection), so any board code that needs a cos.env value PARSES the
// file itself. backup/config.mjs re-implements the same parser independently — it
// is a sibling .mjs OUTSIDE the Next root, so it genuinely cannot import this module
// (board/tsconfig's include scope + allowJs:false forbid it). Inside the Next root,
// share this one copy: backup-status.ts and vault-config.ts both import it.
//
// Every read is fail-safe: a missing / unreadable / garbage file degrades to {} (the
// caller falls back to its defaults). Nothing here throws.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Parse config/cos.env (under `repoRoot`) into a flat KEY→value map. Strips ONE layer
// of surrounding single OR double quotes (cos.env values are always quoted). A missing
// or unreadable or odd file yields {}.
export function parseCosEnv(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(repoRoot, "config", "cos.env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2]!;
      if (
        v.length >= 2 &&
        ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]!] = v;
    }
  } catch {
    /* no cos.env / not readable / odd contents ⇒ {} (caller falls back to defaults) */
  }
  return out;
}

// Expand a leading "~" / "~/" to $HOME (cos.env values may use ~). Other paths pass through.
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

// ── Device identity + role (multi-device) ─────────────────────────────────────
// MIRRORS backup/config.mjs's DEVICE_ID/DEVICE_ROLE chains (env > cos.env >
// default — that .mjs is outside the Next root and cannot be imported). The
// cos.env parse is cached (static per process); the ENV override is read per
// call so tests can flip roles without a module reload. Consumers: the store's
// spoke write guard, /api/healthz, and backup-status's device-scoped freshness.
let _cosEnvCache: Record<string, string> | null = null;
function machineEnv(): Record<string, string> {
  if (!_cosEnvCache) _cosEnvCache = parseCosEnv(path.resolve(process.cwd(), ".."));
  return _cosEnvCache;
}

// The standard machine-setting lookup for the board side: process.env > cos.env >
// fallback. The ENV read is per-call (tests flip it); the cos.env parse is cached
// (config is static per process — the boardapp restarts on redeploy). The device
// getters + the Devices join-blob builder ALL resolve through this, so precedence
// never drifts between them.
export function machineValue(name: string, fallback: string): string {
  const env = process.env[name];
  if (env && env.trim()) return env;
  const fromFile = machineEnv()[name];
  return fromFile && fromFile.trim() ? fromFile : fallback;
}

// The canonical device-id slug shape (filename-safe; keys manifests, the lease, the
// last-seen map). One owner inside the Next root — getDeviceId AND devices.ts's
// header-input sanitizer both use it, so the shape can't diverge. (backup/config.mjs
// + mcp-kit hold their own copies: they are .mjs OUTSIDE the Next root and cannot
// import this — the shape is documented as MIRRORED there.)
export function slugifyDeviceId(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

// "hub" runs the state machine; "spoke" is a stateless client of the hub. Any
// value other than the two known roles degrades to hub (the loader validates
// loudly at setup time — this read-side is deliberately tolerant).
export function getDeviceRole(): "hub" | "spoke" {
  return machineValue("COS_DEVICE_ROLE", "hub").trim() === "spoke" ? "spoke" : "hub";
}

// The stable per-machine id (sanitized to a filename-safe slug; hostname fallback
// until setup mints a real COS_DEVICE_ID). Memoized on the raw input so the
// sanitize regex doesn't re-run on every manifest row (isLocalEntry is a hot
// predicate) — keyed on the raw value so a test-time env override stays live.
let _idCache: { raw: string; id: string } | null = null;
export function getDeviceId(): string {
  const raw = machineValue("COS_DEVICE_ID", os.hostname()).trim();
  if (_idCache && _idCache.raw === raw) return _idCache.id;
  const id = slugifyDeviceId(raw) || "unknown-device";
  _idCache = { raw, id };
  return id;
}
