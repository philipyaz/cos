#!/usr/bin/env node
// api-labels.mjs — lifecycle test for the board's LABEL taxonomy API
// (board/app/api/labels/*, plus label validation on the case-write paths).
//
// Plain Node (ESM), zero deps. Drives a RUNNING board and asserts the contract:
//   • GET  /api/labels                  → { labels } (array)
//   • GET  /api/labels/bundles          → { bundles } (built-in packs, each with
//                                          a labels[] + installedCount)
//   • POST /api/labels/bundles {id}     → installs the bundle's labels (idempotent);
//                                          they then appear in GET /api/labels
//   • POST /api/labels {title,...}      → mints a unique-id custom label
//   • PATCH /api/labels/:id             → edits title/description/color
//   • POST /api/cases {labels:[valid]}  → 201, the case carries the label
//   • POST /api/cases {labels:[bogus]}  → 400 (unknown id rejected, valid set named)
//   • PATCH /api/cases/:id {labels:bad} → 400 (same guard on update)
//   • DELETE /api/labels/:id?scrub=1    → removes from catalog AND from the case
//
// Snapshots board/data/cases.json (the catalog lives there too) and restores it in
// a `finally`, so the live board is left EXACTLY as found (net-zero). Requires a
// running board:
//   cd board && npm run dev
//   node tests/api-labels.mjs            # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};
const api = (method, p, body) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(json);

async function main() {
  console.log(`api-labels · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // 1. Catalog + bundles are readable.
    const cat0 = await api("GET", "/api/labels");
    check(cat0.status === 200 && Array.isArray(cat0.body.labels), "GET /api/labels → { labels: [] }");

    const bundles = await api("GET", "/api/labels/bundles");
    check(
      bundles.status === 200 && Array.isArray(bundles.body.bundles) && bundles.body.bundles.length > 0,
      `GET /api/labels/bundles → ${bundles.body.bundles?.length ?? 0} bundle(s)`,
    );
    const universal = bundles.body.bundles.find((b) => b.id === "universal") ?? bundles.body.bundles[0];
    check(!!universal && Array.isArray(universal.labels) && universal.labels.length > 0, `bundle '${universal?.id}' has labels`);
    const sampleId = universal.labels[0].id;

    // 2. Install the bundle → its labels land in the catalog.
    const install = await api("POST", "/api/labels/bundles", { bundleId: universal.id });
    check(install.status === 200 && Array.isArray(install.body.labels), `install '${universal.id}' → 200`);
    check(install.body.labels.some((l) => l.id === sampleId), `catalog now contains '${sampleId}'`);
    check(Array.isArray(install.body.conflicts), "install response includes a conflicts[] array");

    // Idempotent: re-installing adds nothing new.
    const install2 = await api("POST", "/api/labels/bundles", { bundleId: universal.id });
    check(
      install2.status === 200 && Array.isArray(install2.body.installed) && install2.body.installed.length === 0,
      "re-install is idempotent (installed: [])",
    );

    // Unknown bundle → 404.
    const badBundle = await api("POST", "/api/labels/bundles", { bundleId: "__nope__" });
    check(badBundle.status === 404, `install unknown bundle → 404 (got ${badBundle.status})`);

    // 2c. Install a distinct bundle, then UNINSTALL it → its labels are gone.
    const freshBundle = bundles.body.bundles.find((b) => b.id === "it-support") ?? bundles.body.bundles[0];
    const freshIds = (freshBundle.labels || []).map((l) => l.id);
    await api("POST", "/api/labels/bundles", { bundleId: freshBundle.id });
    const afterInstall = await api("GET", "/api/labels");
    check(
      freshIds.length > 0 && freshIds.every((id) => afterInstall.body.labels.some((l) => l.id === id)),
      `'${freshBundle.id}' labels present after install`,
    );
    const uninstall = await api("DELETE", `/api/labels/bundles/${encodeURIComponent(freshBundle.id)}`);
    check(uninstall.status === 200 && Array.isArray(uninstall.body.removed), `uninstall '${freshBundle.id}' → 200`);
    const afterUninstall = await api("GET", "/api/labels");
    check(
      freshIds.every((id) => !afterUninstall.body.labels.some((l) => l.id === id)),
      `'${freshBundle.id}' owned labels removed after uninstall`,
    );
    const reUninstall = await api("DELETE", `/api/labels/bundles/${encodeURIComponent(freshBundle.id)}`);
    check(
      reUninstall.status === 200 && reUninstall.body.removed.length === 0,
      "re-uninstall removes nothing (idempotent)",
    );
    const badUninstall = await api("DELETE", "/api/labels/bundles/__nope__");
    check(badUninstall.status === 404, `uninstall unknown bundle → 404 (got ${badUninstall.status})`);

    // 3. Custom label: minted id, then editable.
    const created = await api("POST", "/api/labels", {
      title: "QA Test Label",
      description: "temporary label for the api-labels test",
      color: "teal",
    });
    check(created.status === 201 && created.body.label?.id, `POST /api/labels → 201, id '${created.body.label?.id}'`);
    const customId = created.body.label.id;

    const edited = await api("PATCH", `/api/labels/${encodeURIComponent(customId)}`, { title: "QA Edited" });
    check(edited.status === 200 && edited.body.label?.title === "QA Edited", "PATCH /api/labels/:id edits title");

    const badColor = await api("PATCH", `/api/labels/${encodeURIComponent(customId)}`, { color: "chartreuse" });
    check(badColor.status === 400, `PATCH with invalid color → 400 (got ${badColor.status})`);

    // 4. Case write with a VALID label id → 201 and carried on the case.
    const okCase = await api("POST", "/api/cases", {
      title: "api-labels test case",
      labels: [sampleId, customId],
    });
    check(okCase.status === 201, `create case with valid labels → 201 (got ${okCase.status})`);
    check(
      Array.isArray(okCase.body.case?.labels) &&
        okCase.body.case.labels.includes(sampleId) &&
        okCase.body.case.labels.includes(customId),
      "created case carries the assigned labels",
    );
    const caseId = okCase.body.case.id;

    // 5. Case write with an UNKNOWN label id → 400, naming the bad id.
    const badCreate = await api("POST", "/api/cases", { title: "bad", labels: ["__not_a_label__"] });
    check(badCreate.status === 400, `create case with unknown label → 400 (got ${badCreate.status})`);
    check(
      typeof badCreate.body.error === "string" && badCreate.body.error.includes("__not_a_label__"),
      "the 400 names the unknown label id",
    );

    const badPatch = await api("PATCH", `/api/cases/${encodeURIComponent(caseId)}`, {
      labels: [sampleId, "__still_bad__"],
    });
    check(badPatch.status === 400, `update case with an unknown label → 400 (got ${badPatch.status})`);

    // 6. Delete the custom label WITH scrub → gone from catalog AND from the case.
    const del = await api("DELETE", `/api/labels/${encodeURIComponent(customId)}?scrub=1`);
    check(del.status === 200 && del.body.scrubbed === true, "DELETE /api/labels/:id?scrub=1 → 200");
    check(!del.body.labels.some((l) => l.id === customId), "label removed from the catalog");

    const after = await api("GET", `/api/cases/${encodeURIComponent(caseId)}`);
    check(
      !(after.body.case?.labels ?? []).includes(customId) && (after.body.case?.labels ?? []).includes(sampleId),
      "scrub removed the deleted id from the case but kept the others",
    );
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} label-api check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — label API holds (catalog, bundles, install, custom CRUD, case validation, scrub).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
