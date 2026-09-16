#!/usr/bin/env node
// api-prefs.mjs — lifecycle test for the board's persisted view-state API
// (board/app/api/prefs/route.ts → board/data/prefs.json).
//
// Plain Node (ESM), zero deps. Drives a RUNNING board and asserts the prefs
// contract holds end-to-end:
//   • GET  /api/prefs                 → { prefs } (object)
//   • PATCH boardQuery (with junk)    → canonicalised through the selectors
//                                       round-trip (unknown keys + invalid values
//                                       dropped); collapsedLanes filtered to real
//                                       lane keys and de-duplicated
//   • GET                              → the PATCH round-trips (persisted)
//   • PATCH collapsedLanes only        → boardQuery is preserved (partial merge)
//   • PATCH {}                         → 400 (nothing to update)
//
// Snapshots the prefs.json beside COS_BOARD_DATA's store first (or notes its absence) and
// restores it in a `finally`, so the live board is left EXACTLY as found (net-zero) — but ONLY
// when COS_BOARD_DATA is set: unset means no file operation at all (a printed warning, not a
// guessed path) rather than a silent live-store default. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   COS_BOARD_DATA=<that board's cases.json> node tests/api-prefs.mjs         # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (the RUNNING board's cases.json — the prefs.json
// beside it is what gets snapshotted; skipped if unset).
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
// Under run.sh, COS_BOARD_DATA names the sandbox store; the sandbox board keeps its prefs.json
// in the same directory (run.sh seeds `{}` there — run.sh:400, prefs.ts:21 resolves it from
// COS_DATA_DIR), so the derived path is the file the PATCHes below actually change. No env
// path → no file operation at all (ADR 0029's host rule).
const DATA_FILE = process.env.COS_BOARD_DATA || "";
const PREFS_FILE = DATA_FILE ? path.join(path.dirname(DATA_FILE), "prefs.json") : "";

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
const GET = () => fetch(`${BASE}/api/prefs`).then(json);
const PATCH = (b) =>
  fetch(`${BASE}/api/prefs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  }).then(json);

async function main() {
  console.log(`api-prefs · board=${BASE}`);

  // Snapshot the live prefs file so the run is net-zero. It may not exist yet
  // (a fresh board has no prefs) — remember that so we can delete it on restore. Only when
  // PREFS_FILE is set (COS_BOARD_DATA names a store).
  let snapshot = null;
  if (PREFS_FILE) {
    try {
      snapshot = await fs.readFile(PREFS_FILE, "utf8");
    } catch {
      snapshot = null; // no file yet
    }
  }

  try {
    const initial = await GET();
    check(initial.status === 200, `GET /api/prefs → 200 (got ${initial.status})`);
    check(initial.body && typeof initial.body.prefs === "object", "GET returns a prefs object");

    // PATCH a query carrying an unknown key (bogus) and an invalid status (nope),
    // plus collapsedLanes with an invalid lane and a duplicate.
    const patched = await PATCH({
      boardQuery: "status=urgent,nope&sort=priority&dir=asc&bogus=1",
      collapsedLanes: ["done", "nope", "done"],
    });
    check(patched.status === 200, `PATCH → 200 (got ${patched.status})`);
    check(
      patched.body.prefs?.boardQuery === "status=urgent&sort=priority&dir=asc",
      `boardQuery canonicalised (junk + invalid status dropped): ${patched.body.prefs?.boardQuery}`,
    );
    check(
      JSON.stringify(patched.body.prefs?.collapsedLanes) === JSON.stringify(["done"]),
      `collapsedLanes filtered to valid lanes + de-duped: ${JSON.stringify(patched.body.prefs?.collapsedLanes)}`,
    );

    const after = await GET();
    check(
      after.body.prefs?.boardQuery === "status=urgent&sort=priority&dir=asc",
      "boardQuery persisted (round-trips through a fresh GET)",
    );

    // Partial merge: a collapsedLanes-only PATCH must not wipe the saved boardQuery.
    const merged = await PATCH({ collapsedLanes: ["done", "waiting_for_input"] });
    check(merged.status === 200, `partial PATCH → 200 (got ${merged.status})`);
    check(
      merged.body.prefs?.boardQuery === "status=urgent&sort=priority&dir=asc",
      "partial PATCH (collapsedLanes only) preserves the existing boardQuery",
    );
    check(
      JSON.stringify(merged.body.prefs?.collapsedLanes) ===
        JSON.stringify(["done", "waiting_for_input"]),
      "collapsedLanes updated by the partial PATCH",
    );

    const empty = await PATCH({});
    check(empty.status === 400, `empty PATCH (nothing to update) → 400 (got ${empty.status})`);
  } finally {
    // Restore — leave the live prefs file exactly as found (net-zero), only when there is one.
    if (!PREFS_FILE) {
      console.log("  SKIP: COS_BOARD_DATA not set — no prefs snapshot/restore (writes made during this run are NOT reverted).");
    } else if (snapshot === null) {
      await fs.rm(PREFS_FILE, { force: true });
      console.log("  ↩ removed test prefs.json (board had none before the run)");
    } else {
      await fs.writeFile(PREFS_FILE, snapshot, "utf8");
      console.log("  ↩ restored the prefs file to its pre-test state");
    }
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} prefs check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — prefs API holds (round-trip, canonicalisation, lane filtering, partial merge, 400).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
