#!/usr/bin/env node
// scripts/mark-skill-uploaded.mjs — record which operator-skill bundles THIS machine's Cowork
// has been given, so the next upgrade can compute bundle drift instead of guessing from a git
// range. Cowork's installed state cannot be read back (ADR 0020); this is the honest substitute:
// a receipt YOU write right after uploading, holding the sha256 of the exact .zip you uploaded.
//
//   node scripts/mark-skill-uploaded.mjs nutrition-chef mail-to-board   # after uploading those two
//   node scripts/mark-skill-uploaded.mjs --all                           # after a first-run upload of every bundle
//   node scripts/mark-skill-uploaded.mjs --list                          # what the receipt says vs the committed zips
//
// The receipt lives at mcp/logs/.cowork-skills-uploaded.json (mcp/logs/ is gitignored — it is
// per-machine state, like the launchd plists). `scripts/upgrade-check.mjs` reads it: with a
// receipt, the "upload these bundles" step lists every zip whose bytes differ from what was last
// marked here — however many pulls ago it changed — instead of only the zips in the pulled range.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = path.join(REPO_ROOT, "board", ".claude", "skill-bundles");
const RECEIPT = path.join(REPO_ROOT, "mcp", "logs", ".cowork-skills-uploaded.json");

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const zips = () => fs.readdirSync(BUNDLES).filter((f) => f.endsWith(".zip")).sort();
const readReceipt = () => {
  try {
    return JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  } catch {
    return { skills: {} };
  }
};

const args = process.argv.slice(2);
if (!args.length || args.includes("-h") || args.includes("--help")) {
  console.log("usage: node scripts/mark-skill-uploaded.mjs <skill>... | --all | --list");
  process.exit(args.length ? 0 : 1);
}

if (args.includes("--list")) {
  const r = readReceipt();
  for (const z of zips()) {
    const skill = z.replace(/\.zip$/, "");
    const current = sha(path.join(BUNDLES, z));
    const rec = r.skills?.[skill];
    const state = !rec ? "never marked" : rec.sha256 === current ? `up to date (marked ${rec.at})` : `STALE — changed since marked ${rec.at}`;
    console.log(`${skill.padEnd(28)} ${state}`);
  }
  process.exit(0);
}

const wanted = args.includes("--all") ? zips().map((z) => z.replace(/\.zip$/, "")) : args;
const r = readReceipt();
r.skills ||= {};
const at = new Date().toISOString();
for (const skill of wanted) {
  const zip = path.join(BUNDLES, `${skill}.zip`);
  if (!fs.existsSync(zip)) {
    console.error(`[mark-skill-uploaded] no bundle for "${skill}" at ${path.relative(REPO_ROOT, zip)} — run node scripts/pack-skills.mjs first, or check the name.`);
    process.exit(1);
  }
  r.skills[skill] = { sha256: sha(zip), zip: path.relative(REPO_ROOT, zip), at };
}
fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
fs.writeFileSync(RECEIPT, JSON.stringify(r, null, 2) + "\n");
console.log(`[mark-skill-uploaded] recorded ${wanted.length} bundle(s) in ${path.relative(REPO_ROOT, RECEIPT)}: ${wanted.join(", ")}`);
