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
