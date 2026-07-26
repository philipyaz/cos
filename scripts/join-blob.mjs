#!/usr/bin/env node
// scripts/join-blob.mjs — print the cos-join:// blob a NEW spoke pastes into spoke-setup.
// The blob carries ADDRESSES + EXPECTATIONS only (hub URL, this hub's schemaVersion, an
// optional backup-repo ref) — never a secret — so it neither expires nor needs protecting.
//
// GRAMMAR MIRROR: board/lib/devices.ts buildJoinBlob() emits the SAME `cos-join://v1?
// hub=&schema=&backup=` shape for the board's "Add a device" button — keep the two in
// lockstep (this .mjs is outside the Next root and cannot import the board module).
//
//   node scripts/join-blob.mjs                       # from COS_HUB_PUBLIC_URL (cos.env)
//   node scripts/join-blob.mjs https://mini.ts.net   # explicit hub URL (overrides)
//
// The hub URL is the `tailscale serve` MagicDNS name (BOARD_URL on a hub is localhost, so
// the reachable URL must be supplied). Precedence: CLI arg > COS_HUB_PUBLIC_URL > auto-
// detect via `tailscale serve status`. Prints ONE line (the blob) to stdout, or a helpful
// error to stderr and exit 1.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cosEnv() {
  const out = {};
  try {
    for (const raw of fs.readFileSync(path.join(REPO_ROOT, "config", "cos.env"), "utf8").split(/\r?\n/)) {
      const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no cos.env */
  }
  return out;
}

function codeSchemaVersion() {
  try {
    const m = fs
      .readFileSync(path.join(REPO_ROOT, "board", "lib", "types.ts"), "utf8")
      .match(/export const SCHEMA_VERSION\s*(?::\s*number\s*)?=\s*(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Best-effort: read the hub's HTTPS serve URL from `tailscale serve status`.
function detectTailscaleUrl() {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    try {
      const out = execFileSync(bin, ["serve", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/https:\/\/[A-Za-z0-9.-]+\.ts\.net\S*/);
      if (m) return m[0].replace(/\/$/, "");
    } catch {
      /* not installed / not serving — try the next */
    }
  }
  return null;
}

const env = cosEnv();
const argUrl = process.argv[2] && process.argv[2].trim();
// Precedence matches the board (env > cos.env), with the CLI arg first and a
// tailscale auto-detect last: CLI arg > process.env > cos.env > tailscale.
const hubUrl = (argUrl || process.env.COS_HUB_PUBLIC_URL || env.COS_HUB_PUBLIC_URL || detectTailscaleUrl() || "")
  .trim()
  .replace(/\/$/, "");
const backupRef = (process.env.BACKUP_REPO_REF || env.BACKUP_REPO_REF || "").trim();

if (!hubUrl) {
  process.stderr.write(
    "No hub URL. Provide one, or set COS_HUB_PUBLIC_URL in config/cos.env, or run `tailscale serve` first:\n" +
      "  node scripts/join-blob.mjs https://<hub>.<tailnet>.ts.net\n",
  );
  process.exit(1);
}
if (!/^https?:\/\//.test(hubUrl)) {
  process.stderr.write(`hub URL must be http(s): got "${hubUrl}"\n`);
  process.exit(1);
}

const params = new URLSearchParams({ hub: hubUrl });
const schema = codeSchemaVersion();
if (schema) params.set("schema", schema);
if (backupRef) params.set("backup", backupRef);

process.stdout.write(`cos-join://v1?${params.toString()}\n`);
