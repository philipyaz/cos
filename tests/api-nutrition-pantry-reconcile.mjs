#!/usr/bin/env node
// api-nutrition-pantry-reconcile.mjs — the v14 bulk pantry reconcile write.
//
// Plain Node (ESM), zero deps. Proves POST /api/nutrition/pantry/reconcile end-to-end against a
// RUNNING board: a fresh name ADDS a row; a resubmit of a normalised variant (case/whitespace/
// plural/accent) UPDATES that same row instead of minting a duplicate; a batch of N new items
// bumps db.version exactly ONCE with N distinct minted ids; an in-batch duplicate (two submitted
// names sharing a normalised key) is reported SKIPPED, not double-added; a malformed item rejects
// the WHOLE batch with nothing written (fail-closed, incl. an empty `items`); the pantry item
// count never reduces; and the route mirrors the v9 Add-ons GATE contract (a disabled add-on
// 404s the write while GET stays 200). Synthetic fixture data only — no name from a real pantry
// appears here.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero — pantryItems +
// settings.addons live in cases.json). Requires a running board:
//   cd board && npm run dev
//   node tests/api-nutrition-pantry-reconcile.mjs    # CRM_BASE_URL defaults to http://localhost:3000
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
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

const pantryCount = async () => {
  const r = await GET("/api/nutrition/pantry");
  return (r.body.items ?? []).length;
};

async function main() {
  console.log(`api-nutrition-pantry-reconcile · board=${BASE}`);

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // 1. Enable the add-on; record the baseline count.
    // ----------------------------------------------------------------------
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH enable → 200 (got ${enable.status})`);

    let prevCount = await pantryCount();

    // ----------------------------------------------------------------------
    // 2. A fresh name ADDS exactly one row. (Before the route exists this is a 404 — the
    // "must fail before the route exists" requirement.)
    // ----------------------------------------------------------------------
    const first = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture Chickpeas", quantity: 2, unit: "cans", category: "pantry" }],
    });
    check(first.status === 200, `first reconcile (new item) → 200 (got ${first.status})`);
    check(first.body.added?.length === 1, `added.length === 1 (got ${first.body.added?.length})`);
    check(first.body.updated?.length === 0, "updated.length === 0 on a pure add");
    const chickpeaId = first.body.added?.[0]?.id;

    let count = await pantryCount();
    check(count === prevCount + 1, `pantry count +1 (was ${prevCount}, now ${count})`);
    check(count >= prevCount, "never reduces (post-add)");
    prevCount = count;

    // ----------------------------------------------------------------------
    // 3. A normalised-variant resubmit (case + whitespace + plural) UPDATES, not adds.
    // ----------------------------------------------------------------------
    const resubmit = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "  fixture chickpea ", quantity: 5 }],
    });
    check(resubmit.status === 200, `resubmit (variant name) → 200 (got ${resubmit.status})`);
    check(resubmit.body.updated?.length === 1, `updated.length === 1 (got ${resubmit.body.updated?.length})`);
    check(resubmit.body.added?.length === 0, "added.length === 0 on a pure update");
    check(resubmit.body.updated?.[0]?.id === chickpeaId, "the updated row is the SAME id (no duplicate minted)");
    check(resubmit.body.updated?.[0]?.quantity === 5, "the row's quantity is now 5");

    count = await pantryCount();
    check(count === prevCount, `pantry count UNCHANGED on an update-only batch (${count})`);
    check(count >= prevCount, "never reduces (post-update)");
    prevCount = count;

    // Accent variant pair: seed with an accent, resubmit without one → update, not add.
    const seedAccent = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture Tomätoes" }],
    });
    check(seedAccent.status === 200 && seedAccent.body.added?.length === 1, "seed the accented name → added");
    const tomatoId = seedAccent.body.added?.[0]?.id;
    prevCount = await pantryCount();

    const resubmitAccent = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "fixture tomatoes" }],
    });
    check(resubmitAccent.status === 200, `accent-stripped resubmit → 200 (got ${resubmitAccent.status})`);
    check(resubmitAccent.body.updated?.length === 1, "accent-stripped resubmit UPDATES");
    check(resubmitAccent.body.updated?.[0]?.id === tomatoId, "same id — no duplicate for the accent variant");

    count = await pantryCount();
    check(count === prevCount, `pantry count unchanged after the accent-variant update (${count})`);
    check(count >= prevCount, "never reduces (post-accent-update)");
    prevCount = count;

    // ----------------------------------------------------------------------
    // 4. A batch of 3 NEW items bumps db.version exactly ONCE, with 3 distinct ids.
    // ----------------------------------------------------------------------
    const vBefore = (await GET("/api/nutrition/pantry")).body.version;
    const batch3 = await POST("/api/nutrition/pantry/reconcile", {
      items: [
        { name: "Fixture Batch Alpha" },
        { name: "Fixture Batch Beta" },
        { name: "Fixture Batch Gamma" },
      ],
    });
    check(batch3.status === 200, `batch of 3 → 200 (got ${batch3.status})`);
    check(batch3.body.added?.length === 3, `added.length === 3 (got ${batch3.body.added?.length})`);
    const ids3 = (batch3.body.added ?? []).map((x) => x.id);
    check(new Set(ids3).size === 3, `3 DISTINCT minted ids (got ${JSON.stringify(ids3)})`);
    check(
      batch3.body.version === vBefore + 1,
      `exactly ONE version bump for the whole batch (${vBefore} → ${batch3.body.version})`,
    );

    count = await pantryCount();
    check(count === prevCount + 3, `pantry count +3 (was ${prevCount}, now ${count})`);
    check(count >= prevCount, "never reduces (post-batch3)");
    prevCount = count;

    // ----------------------------------------------------------------------
    // 5. An in-batch duplicate (two submitted names sharing a normalised key) is SKIPPED,
    // not double-added.
    // ----------------------------------------------------------------------
    const dupBatch = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture Batch Item" }, { name: "fixture batch items" }],
    });
    check(dupBatch.status === 200, `in-batch-duplicate batch → 200 (got ${dupBatch.status})`);
    check(dupBatch.body.added?.length === 1, `added.length === 1 (got ${dupBatch.body.added?.length})`);
    check(dupBatch.body.skipped?.length === 1, `skipped.length === 1 (got ${dupBatch.body.skipped?.length})`);
    check(!!dupBatch.body.skipped?.[0]?.reason, "the skipped entry carries a reason");

    count = await pantryCount();
    check(count === prevCount + 1, `pantry count +1 (only the non-duplicate landed) (${count})`);
    check(count >= prevCount, "never reduces (post-dup-batch)");
    prevCount = count;

    // ----------------------------------------------------------------------
    // 6. Fail closed: a malformed item rejects the WHOLE batch, writing nothing.
    // ----------------------------------------------------------------------
    const vBeforeBad = (await GET("/api/nutrition/pantry")).body.version;
    const badBatch = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture Good" }, { name: "" }],
    });
    check(badBatch.status === 400, `a batch with one malformed item → 400 (got ${badBatch.status})`);

    count = await pantryCount();
    check(count === prevCount, `pantry count UNCHANGED after the rejected batch (${count})`);
    const vAfterBad = (await GET("/api/nutrition/pantry")).body.version;
    check(vAfterBad === vBeforeBad, `version UNCHANGED after the rejected batch (${vBeforeBad} → ${vAfterBad})`);

    const reGet = await GET("/api/nutrition/pantry");
    check(
      !(reGet.body.items ?? []).some((x) => x.name === "Fixture Good"),
      "'Fixture Good' is absent from a re-GET — nothing from the rejected batch landed",
    );

    const emptyBatch = await POST("/api/nutrition/pantry/reconcile", { items: [] });
    check(emptyBatch.status === 400, `{ items: [] } → 400 (got ${emptyBatch.status})`);

    // ----------------------------------------------------------------------
    // 7. (checked throughout) the pantry item count never reduces — see the "never reduces"
    // assertion after every successful call above.
    // ----------------------------------------------------------------------

    // ----------------------------------------------------------------------
    // 8. Gate mirror (mirrors api-nutrition-gate.mjs) — a DISABLED add-on 404s the write;
    // GET stays 200.
    // ----------------------------------------------------------------------
    const disable = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disable.status === 200, `PATCH disable → 200 (got ${disable.status})`);

    const blockedReconcile = await POST("/api/nutrition/pantry/reconcile", {
      items: [{ name: "Fixture Should Not Land" }],
    });
    check(blockedReconcile.status === 404, `reconcile while disabled → 404 (got ${blockedReconcile.status})`);

    const readWhileDisabled = await GET("/api/nutrition/pantry");
    check(readWhileDisabled.status === 200, "GET /api/nutrition/pantry while disabled → 200 (ungated read)");

    const reEnable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(reEnable.status === 200, `PATCH re-enable → 200 (got ${reEnable.status})`);
  } finally {
    // 9. Restore the snapshot regardless of outcome.
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — /api/nutrition/pantry/reconcile upserts by normalised name, bumps version once per batch, " +
      "fails closed, and never reduces the pantry.",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
