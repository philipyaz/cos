#!/usr/bin/env node
// Recover stores from the encrypted backup repo. SAFE BY DEFAULT:
//   - verifies the GCM auth tag (tamper/wrong-key detection) AND the sha256 vs the
//     MANIFEST AND that every restored *.json parses, BEFORE touching anything;
//   - dry-run unless you pass --apply;
//   - on --apply, snapshots the CURRENT live state to ~/cos-recovery/pre-restore-*
//     before overwriting, so a restore is itself reversible.
//
// Usage:
//   node backup/restore.mjs                 # verify the LATEST backup (dry run)
//   node backup/restore.mjs --date 2026-06-06
//   node backup/restore.mjs --apply         # actually restore the latest
//   node backup/restore.mjs --list          # list available backups
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, BACKUP_REPO } from "./config.mjs";
import { decrypt } from "./lib/crypto.mjs";
import { resolveKey } from "./lib/key.mjs";

const log = (...a) => console.log(...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

function loadManifest() {
  if (!fs.existsSync(path.join(BACKUP_REPO, ".git"))) throw new Error(`Backup repo missing at ${BACKUP_REPO}.`);
  try {
    sh("git", ["-C", BACKUP_REPO, "pull", "--ff-only"]);
  } catch (e) {
    log("WARN pull:", String(e.message).split("\n")[0]);
  }
  return JSON.parse(fs.readFileSync(path.join(BACKUP_REPO, "MANIFEST.json"), "utf8"));
}

function main() {
  const man = loadManifest();
  if (flag("--list")) {
    log("available backups (newest first):");
    man.backups.forEach((b) => log(`  ${b.date}  ${b.file}  ${(b.encBytes / 1024).toFixed(0)}KB  ${b.host}`));
    return;
  }

  const key = resolveKey();
  const dateArg = opt("--date");
  const entry = !dateArg ? man.backups[0] : man.backups.find((b) => b.file.includes(dateArg) || b.date === dateArg);
  if (!entry) throw new Error(`No backup matching ${dateArg || "(latest)"}. Try --list.`);
  log(`selected: ${entry.file}  (${entry.date}, ${entry.scope.length} stores)`);

  // verify: auth tag → sha256 → JSON parse, all before touching live data
  const blob = fs.readFileSync(path.join(BACKUP_REPO, entry.file));
  const tarball = decrypt(blob, key); // THROWS on wrong key / tamper
  const sha = crypto.createHash("sha256").update(tarball).digest("hex");
  if (sha !== entry.plaintextSha256) {
    throw new Error(`Integrity FAIL: sha256 ${sha.slice(0, 12)} != manifest ${entry.plaintextSha256.slice(0, 12)}`);
  }
  log("auth tag OK ✓   sha256 OK ✓");

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cos-restore-"));
  const tmpTar = path.join(stage, "b.tgz");
  fs.writeFileSync(tmpTar, tarball);
  sh("/usr/bin/tar", ["xzf", tmpTar, "-C", stage]);
  fs.rmSync(tmpTar, { force: true });
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        try {
          JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
          bad.push(p);
        }
      }
    }
  })(stage);
  if (bad.length) throw new Error("restored JSON invalid: " + bad.join(", "));
  log(`JSON-verified ✓   extracted to ${stage}`);

  if (!flag("--apply")) {
    log("\nDRY RUN — verified only, nothing written. Re-run with --apply to restore over live data.");
    log("(A pre-restore snapshot of your current live state is taken automatically on --apply.)");
    return;
  }

  // snapshot CURRENT live state first (restore is reversible)
  const safe = path.join(os.homedir(), "cos-recovery", "pre-restore-" + new Date().toISOString().replace(/[:.]/g, "-"));
  for (const rel of entry.scope) {
    const live = path.join(REPO_ROOT, rel);
    if (fs.existsSync(live)) {
      const dst = path.join(safe, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      sh("/bin/cp", ["-R", live, dst]);
    }
  }
  log("current live state snapshotted → " + safe);

  for (const rel of entry.scope) {
    const src = path.join(stage, rel);
    const dst = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    sh("/bin/cp", ["-R", src, dst]);
    log("restored " + rel);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  log("\n✅ restore complete. Restart services: launchctl kickstart -k gui/$(id -u)/com.chiefofstaff.mcp-* and your board dev server.");
}

main();
