#!/usr/bin/env node
// api-search.mjs — lifecycle test for the board's SEARCH API
// (board/app/api/search: the back-compat keyword GET + the fail-safe semantic POST).
//
// Plain Node (ESM), zero deps. Drives a RUNNING board and asserts the contract:
//   • GET  /api/search?q=               → { cases:[], tasks:[], messages:[] } (back-compat)
//   • GET  /api/search?q=<marker>       → 200, finds the seeded case (shape preserved)
//   • POST /api/search { queries, k }   → batch envelope { engine, results[], merged }
//   • POST /api/search (no queries/q)   → 400
//   • Graceful degradation as a PROPERTY: GET and POST are ALWAYS 2xx (never 5xx)
//     and still find the known marker — holds whether the sidecar is UP (engine
//     "semantic") or DOWN (engine "keyword"), so the test passes in BOTH modes
//     (CI default = sidecar down). It does NOT assert the sidecar is up/down.
//
// Snapshots board/data/cases.json and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero). Requires a running board:
//   cd board && npm run dev
//   node tests/api-search.mjs            # CRM_BASE_URL defaults to http://localhost:3000
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

const is2xx = (status) => status >= 200 && status < 300;

async function main() {
  console.log(`api-search · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // Seed a marker case with a unique token so the search is unambiguous.
    const marker = `zqx-search-${Date.now()}`;
    const seed = await api("POST", "/api/cases", {
      title: `api-search test ${marker}`,
      summary: `marker token ${marker} for the api-search test`,
    });
    check(seed.status === 201 && seed.body.case?.id, `seed marker case → 201, id '${seed.body.case?.id}'`);
    const idA = seed.body.case.id;

    // 1. GET ?q= back-compat — the HARD { cases, tasks, messages } shape.
    const empty = await api("GET", "/api/search?q=");
    check(
      empty.status === 200 &&
        Array.isArray(empty.body.cases) &&
        Array.isArray(empty.body.tasks) &&
        Array.isArray(empty.body.messages) &&
        empty.body.cases.length === 0 &&
        empty.body.tasks.length === 0 &&
        empty.body.messages.length === 0,
      "GET /api/search?q= → { cases:[], tasks:[], messages:[] }",
    );

    const got = await api("GET", `/api/search?q=${encodeURIComponent(marker)}`);
    check(got.status === 200, `GET /api/search?q=<marker> → 200 (got ${got.status})`);
    check(
      Array.isArray(got.body.cases) && Array.isArray(got.body.tasks) && Array.isArray(got.body.messages),
      "GET response preserves the { cases, tasks, messages } shape",
    );
    check(got.body.cases.some((c) => c.id === idA), "GET finds the seeded case by its unique marker");

    // 1b. Soft-delete (Trash) dedup guarantee — a deleted case is HIDDEN by default
    //     but SURFACED with includeArchived, so re-seen mail can re-link (not dup).
    const soft = await api("DELETE", `/api/cases/${encodeURIComponent(idA)}`);
    check(soft.status === 200, `soft-delete marker case → 200 (got ${soft.status})`);
    const defaultAfter = await api("GET", `/api/search?q=${encodeURIComponent(marker)}`);
    check(
      !defaultAfter.body.cases.some((c) => c.id === idA),
      "soft-deleted case is EXCLUDED from search by default",
    );
    const archAfter = await api("GET", `/api/search?q=${encodeURIComponent(marker)}&includeArchived=1`);
    check(
      archAfter.body.cases.some((c) => c.id === idA),
      "soft-deleted case is RETURNED with includeArchived=1 (dedup tombstone)",
    );
    // restore so the rest of the suite sees the marker case on the default board
    await api("PATCH", `/api/cases/${encodeURIComponent(idA)}`, { archivedAt: null });

    // 2. Batch POST — the semantic/keyword envelope. results echo each query in
    //    order; hits respect k; merged.cases is rebuilt from the in-hand db.
    const batch = await api("POST", "/api/search", { queries: [marker, "nonsense-xyzzy"], k: 3 });
    check(batch.status === 200, `POST batch → 200 (got ${batch.status})`);
    check(Array.isArray(batch.body.results) && batch.body.results.length === 2, "batch returns 2 per-query results");
    check(batch.body.results?.[0]?.query === marker, "results[0].query echoes the first query");
    check((batch.body.results?.[0]?.hits?.length ?? 0) <= 3, "results[0].hits respects k=3");
    check(
      (batch.body.results?.[0]?.hits ?? []).some((h) => (h.caseId ?? h.id) === idA),
      "the marker query hits the seeded case",
    );
    check(Array.isArray(batch.body.merged?.cases), "batch carries merged.cases[]");
    // v6 — search now includes reminders; merged gains a reminders bucket (additive,
    // alongside cases/tasks/messages). Assert it's an array regardless of content.
    check(Array.isArray(batch.body.merged?.reminders), "batch carries merged.reminders[] (v6 additive)");
    check(["semantic", "keyword"].includes(batch.body.engine), `engine is semantic|keyword (got '${batch.body.engine}')`);

    // 3. No queries / no q → 400 (the only POST error path).
    const bad = await api("POST", "/api/search", { k: 5 });
    check(bad.status === 400, `POST with no queries/q → 400 (got ${bad.status})`);

    // 4. Graceful degradation as a PROPERTY — holds with OR without the sidecar:
    //    GET and POST are ALWAYS 2xx (never 5xx) AND still find the known marker
    //    (no silent empty on sidecar-down). This is the fail-safe assertion; it
    //    does NOT assert the sidecar is up/down, so it passes in both modes.
    check(is2xx(got.status), "GET is 2xx (never 5xx) — fail-safe");
    check(is2xx(batch.status), "POST is 2xx (never 5xx) — fail-safe");
    check(got.body.cases.length > 0, "marker is found via GET (no silent empty on sidecar-down)");
    check(
      batch.body.merged.cases.some((c) => c.id === idA),
      "marker is found in batch merged.cases (no silent empty on sidecar-down)",
    );
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} search-api check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — search API holds (GET back-compat, batch envelope, 400 guard, fail-safe property).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
