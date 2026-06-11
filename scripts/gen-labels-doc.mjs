#!/usr/bin/env node
// Generate docs/reference/labels.md — the human-readable taxonomy + design doc — from the single
// source of truth (board/lib/label-bundles.ts). Re-run after regenerating bundles.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = readFileSync(path.join(REPO, "board", "lib", "label-bundles.ts"), "utf8");
const match = SRC.match(/= (\[[\s\S]*\]);/);
if (!match) {
  console.error(
    "Could not find the LABEL_BUNDLES array literal in board/lib/label-bundles.ts — " +
      "regenerate it with `node scripts/gen-label-bundles.mjs <workflow-output.json>` first.",
  );
  process.exit(1);
}
const BUNDLES = JSON.parse(match[1]);

const esc = (s) => String(s).replace(/\|/g, "\\|");
const totalLabels = BUNDLES.reduce((n, b) => n + b.labels.length, 0);
const distinct = new Set(BUNDLES.flatMap((b) => b.labels.map((l) => l.id))).size;
const counts = {
  role: BUNDLES.filter((b) => b.category === "role").length,
  life: BUNDLES.filter((b) => b.category === "life").length,
  universal: BUNDLES.filter((b) => b.category === "universal").length,
};

function section(title, cat) {
  const list = BUNDLES.filter((b) => b.category === cat);
  if (!list.length) return "";
  let out = `\n## ${title}\n`;
  for (const b of list) {
    out += `\n### ${b.name} \`${b.id}\`\n\n${b.description}\n\n`;
    out += `| id | label | when to apply | color |\n|---|---|---|---|\n`;
    for (const l of b.labels) {
      out += `| \`${esc(l.id)}\` | ${esc(l.title)} | ${esc(l.description)} | ${esc(l.color ?? "gray")} |\n`;
    }
  }
  return out;
}

const doc = `# Labels — the configurable taxonomy

> Generated from \`board/lib/label-bundles.ts\` by \`scripts/gen-labels-doc.mjs\`.
> Edit the bundle data there (or re-run the design workflow) and regenerate; do not hand-edit this file.

A **label** is a structured, catalog-backed category that organizes the demands flowing
onto the board — richer than the freeform \`tags\` string. It is the layer that cuts
through the noise: a manager filters to \`approval-needed\`, a release manager to \`doc-chase\`,
anyone to the universal \`waiting-on\`. Each label is:

\`\`\`ts
{ id, title, description, color?, bundle?, domain? }
\`\`\`

The **\`description\` is first-class** — it states *when the label applies*, so an AI agent
(or a human) can pick the right one. Labels are **personalizable**: you install only the
bundles that fit your role and life, add your own, and edit any of them — entirely from the
board UI. The active set lives in the store (\`db.labels\`) and is fetched over the API so
the agent skills assign valid labels and the filter reflects exactly what you use.

## Catalog at a glance

- **${BUNDLES.length} bundles** — ${counts.role} role, ${counts.life} life, ${counts.universal} universal.
- **${totalLabels} labels** (${distinct} distinct ids; shared concepts reuse one id across bundles).
- Install a bundle and its labels union into your catalog (idempotent). Remove or rename any.
- Some labels are **shared across bundles by design** (one concept = one id, e.g. \`onboarding\`). When two
  bundles define the same id with a *different* meaning, the first install wins and the install **surfaces a
  conflict notice** — the existing definition is kept, not silently overwritten — so you can rename or edit it.

## How it works

**Data model** (\`board/lib/types.ts\`)
- \`LabelDef\` — a catalog entry. \`db.labels: LabelDef[]\` is the active catalog (versioned, backed up, lint-checked).
- \`CaseRecord.labels: string[]\` — the label ids assigned to a case.
- \`LabelColor\` — a fixed 12-colour palette so chips always render (Tailwind-safe map in \`lib/format.ts\`).
- **Bundles** (\`board/lib/label-bundles.ts\`) are static installable packs — \`LABEL_BUNDLES\`.

**API**
- \`GET  /api/labels\` — the active catalog. *This is what skills/agents fetch before a case write.*
- \`POST /api/labels\` — add a custom label (id minted from the title, de-duplicated).
- \`PATCH/DELETE /api/labels/:id\` — edit / remove a label (\`?scrub=1\` also strips it from every case).
- \`GET  /api/labels/bundles\` — the installable bundles (per-bundle \`installedCount\` + \`ownedCount\`).
- \`POST /api/labels/bundles\` — install a bundle's labels (idempotent; reports conflicts).
- \`DELETE /api/labels/bundles/:id\` — uninstall a bundle (remove the labels it owns; \`?scrub=0\` keeps case refs).
- **Case writes validate labels**: \`POST/PATCH /api/cases\` reject any label id not in the catalog with a
  \`400\` that names the unknown id(s) **and the valid set** — the anti-failure contract, so a skill that
  fetched the catalog first never silently drops a category.

**MCP (agent surface, \`mcp/board-server\`)**
- \`list_labels\` — fetch the catalog (id + title + description) before assigning.
- \`list_label_bundles\` / \`install_label_bundle\` / \`uninstall_label_bundle\` — discover, install, remove packs.
- \`create_case\` / \`update_case\` / \`update_cases\` take a \`labels\` array of catalog ids.

**UI (\`board/components/board\`)**
- **Card chips** — each case shows its labels (colour + title, description on hover); click a chip to filter.
- **Drawer picker** — assign/remove labels from a checklist that shows each label's description.
- **Filter dropdown** — a "Labels" dropdown with a precise **category selector** (your installed bundles,
  grouped) + search. Bundles are collapsible groups with a **tri-state select-all**, so you can filter by a
  whole bundle — or a *scope of several bundles* — in one click, or drill in to pick individual labels. Drives
  an OR facet; the active selection shows as removable chips. Plus *group by Label*.
- **Labels manager** — install bundles, add custom labels, edit titles/descriptions/colours, delete — all in-UI.

**Skills** — \`second-brain-ingest\` and the developer-platform skill call \`list_labels\` first, then assign
only returned ids (see each SKILL.md).

## Regenerate

\`\`\`bash
# 1. (re)design the taxonomy — multi-agent workflow → JSON
#    (Workflow: design-label-taxonomy)
# 2. write it into board/lib/label-bundles.ts
node scripts/gen-label-bundles.mjs <workflow-output.json>
# 3. regenerate this doc
node scripts/gen-labels-doc.mjs
\`\`\`

---

## The bundles
${section("Role bundles", "role")}${section("Life bundles", "life")}${section("Universal", "universal")}`;

writeFileSync(path.join(REPO, "docs", "reference", "labels.md"), doc, "utf8");
console.log(`Wrote docs/reference/labels.md — ${BUNDLES.length} bundles, ${totalLabels} labels.`);
