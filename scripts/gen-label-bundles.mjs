#!/usr/bin/env node
// One-shot generator: read the design workflow's output JSON, clean + validate the
// bundle catalog, and splice it into board/lib/label-bundles.ts (LABEL_BUNDLES).
// Kept in scripts/ so the taxonomy is regenerable: re-run the workflow, then this.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node scripts/gen-label-bundles.mjs <workflow-output.json>");
  process.exit(2);
}
const TARGET = path.join(REPO, "board", "lib", "label-bundles.ts");

const PALETTE = new Set([
  "gray", "red", "orange", "amber", "green", "teal",
  "sky", "blue", "indigo", "violet", "fuchsia", "pink",
]);
const CATEGORY = new Set(["role", "life", "universal"]);
const DOMAIN = new Set(["work", "life"]);

const unescape = (s) =>
  typeof s !== "string"
    ? s
    : s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const kebab = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const raw = JSON.parse(readFileSync(OUT, "utf8"));
const inBundles = raw?.result?.bundles ?? raw?.bundles;
if (!Array.isArray(inBundles)) {
  console.error("No result.bundles array in the output file.");
  process.exit(1);
}

const warnings = [];
const seenBundleIds = new Set();
const out = [];

for (const b of inBundles) {
  if (!b || typeof b !== "object") continue;
  const id = kebab(b.id || b.name || "");
  if (!id) { warnings.push(`bundle with no id/name skipped`); continue; }
  if (seenBundleIds.has(id)) { warnings.push(`duplicate bundle id '${id}' skipped`); continue; }
  const category = CATEGORY.has(b.category) ? b.category : "role";
  const domain = DOMAIN.has(b.domain) ? b.domain : (category === "life" ? "life" : "work");

  const labels = [];
  const seenLabelIds = new Set();
  for (const l of Array.isArray(b.labels) ? b.labels : []) {
    if (!l || typeof l !== "object") continue;
    const lid = kebab(l.id || l.title || "");
    const title = unescape(l.title);
    const description = unescape(l.description) || "";
    if (!lid || !title) { warnings.push(`${id}: label missing id/title skipped`); continue; }
    if (seenLabelIds.has(lid)) { warnings.push(`${id}: duplicate label id '${lid}' skipped`); continue; }
    seenLabelIds.add(lid);
    let color = typeof l.color === "string" ? l.color.toLowerCase() : "gray";
    if (!PALETTE.has(color)) { warnings.push(`${id}/${lid}: bad color '${l.color}' -> gray`); color = "gray"; }
    const label = { id: lid, title, description, color };
    if (DOMAIN.has(l.domain)) label.domain = l.domain;
    labels.push(label);
  }
  if (labels.length === 0) { warnings.push(`bundle '${id}' has no valid labels, skipped`); continue; }
  seenBundleIds.add(id);
  out.push({ id, name: unescape(b.name) || id, description: unescape(b.description) || "", category, domain, labels });
}

// Order: role bundles, then life, then universal — matches the contract.
const rank = { role: 0, life: 1, universal: 2 };
out.sort((a, b) => rank[a.category] - rank[b.category]);

// Cross-bundle audit: same label id with different titles (informational).
const titleById = new Map();
for (const b of out) for (const l of b.labels) {
  if (titleById.has(l.id) && titleById.get(l.id) !== l.title) {
    warnings.push(`label id '${l.id}' has differing titles: "${titleById.get(l.id)}" vs "${l.title}"`);
  } else titleById.set(l.id, l.title);
}

const literal = JSON.stringify(out, null, 2);
const src = readFileSync(TARGET, "utf8");
const re = /export const LABEL_BUNDLES: LabelBundle\[\] = [\s\S]*?\];/;
if (!re.test(src)) {
  console.error("Could not find LABEL_BUNDLES declaration to replace in", TARGET);
  process.exit(1);
}
const next = src.replace(re, `export const LABEL_BUNDLES: LabelBundle[] = ${literal};`);
writeFileSync(TARGET, next, "utf8");

const totalLabels = out.reduce((n, b) => n + b.labels.length, 0);
const distinct = new Set(out.flatMap((b) => b.labels.map((l) => l.id))).size;
console.log(`Wrote ${out.length} bundles, ${totalLabels} labels (${distinct} distinct ids) -> ${path.relative(REPO, TARGET)}`);
console.log(`  role: ${out.filter((b) => b.category === "role").length}, life: ${out.filter((b) => b.category === "life").length}, universal: ${out.filter((b) => b.category === "universal").length}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 40)) console.log("  - " + w);
}
