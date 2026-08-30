#!/usr/bin/env node
// api-vault-coverage.mjs — the v15 vault-ingest RECEIPT + coverage-read contract.
//
// Plain Node (ESM), zero deps. Proves GET /api/cases/vault-coverage and
// POST /api/cases/vault-receipt end-to-end against a RUNNING board:
//   (a) a case with vaultLinks and no receipt is a gap, reason "never";
//   (d) a case with NO vaultLinks is never a gap — receipted or not, before or after
//       an update;
//   (b) POST vault-receipt stamps the receipt and the case drops out of coverage;
//       the receipt is server-stamped and lands EQUAL to updatedAt (the equal-stamp
//       invariant — a client-supplied time would read as instantly stale);
//   (c) updating the case after its receipt makes it a gap again, reason "stale";
//   • a receipt POST with a mix of known + unknown ids marks the known one and
//     reports the unknown one back rather than failing the whole batch; an empty
//     `ids` array is a 400 (a caller bug, not a no-op);
//   • an archived gap is hidden by default and shown under ?includeArchived=1.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero —
// see api-clean.mjs/api-lifecycle.mjs for the same idiom). Both fixture cases are
// created `status: "done"` so cleanup is one POST /api/cases/clean, mirroring
// api-clean.mjs. Requires a running board:
//   cd board && npm run dev
//   node tests/api-vault-coverage.mjs    # CRM_BASE_URL defaults to http://localhost:3000
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

const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const coverage = async (qs = "") => GET(`/api/cases/vault-coverage${qs}`);
const gapFor = (body, id) => (body.gaps ?? []).find((g) => g.id === id);

async function main() {
  console.log(`api-vault-coverage · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  // Declared outside the try so `finally` can clean them up even if an assertion
  // throws partway through (the snapshot restore below is the real safety net either way).
  let A, B;

  try {
    const marker = `apivaultcov-${Date.now()}`;

    // ── 1. Seed: A carries vaultLinks, B carries none. Both `done` so cleanup is a
    // single POST /api/cases/clean at the end (the api-clean.mjs idiom). ──────────
    const ca = await POST("/api/cases", {
      title: `vault-coverage A ${marker}`,
      domain: "work",
      status: "done",
      vaultLinks: ["Acme Corp"],
    });
    check(ca.status === 201, `create case A (vaultLinks) → 201 (got ${ca.status})`);
    A = ca.body.case?.id;

    const cb = await POST("/api/cases", {
      title: `vault-coverage B ${marker}`,
      domain: "work",
      status: "done",
    });
    check(cb.status === 201, `create case B (no vaultLinks) → 201 (got ${cb.status})`);
    B = cb.body.case?.id;

    // ── 2. (a) A is a gap, reason "never"; (d) B never appears. ────────────────────
    const cov0 = await coverage();
    check(cov0.status === 200, `GET vault-coverage → 200 (got ${cov0.status})`);
    check(cov0.body.count === (cov0.body.gaps ?? []).length, "count === gaps.length");

    const gapA0 = gapFor(cov0.body, A);
    check(!!gapA0, "(a) case A appears in the gap set before any receipt");
    check(gapA0?.reason === "never", `(a) A's reason is "never" (got ${gapA0?.reason})`);
    check(gapA0?.vaultIngestedAt === undefined, "(a) A's gap carries no vaultIngestedAt yet");
    check(
      gapA0?.title === ca.body.case.title &&
        gapA0?.domain === "work" &&
        gapA0?.status === "done" &&
        Array.isArray(gapA0?.vaultLinks) &&
        typeof gapA0?.updatedAt === "string",
      "(a) the gap projection carries title/domain/status/vaultLinks/updatedAt",
    );
    check(!gapFor(cov0.body, B), "(d) case B (no vaultLinks) is never a gap");

    // ── 3. (b) Receipt the case → drops out of coverage; equal-stamp invariant. ────
    const receiptA = await POST("/api/cases/vault-receipt", { ids: [A] });
    check(receiptA.status === 200, `POST vault-receipt [A] → 200 (got ${receiptA.status})`);
    check(
      Array.isArray(receiptA.body.marked) && receiptA.body.marked.includes(A),
      `receipt response marks A (got ${JSON.stringify(receiptA.body.marked)})`,
    );

    const cov1 = await coverage();
    check(!gapFor(cov1.body, A), "(b) A no longer appears in coverage right after its receipt");

    const aAfterReceipt = await GET(`/api/cases/${encodeURIComponent(A)}`);
    check(aAfterReceipt.status === 200, `GET case A → 200 (got ${aAfterReceipt.status})`);
    check(
      typeof aAfterReceipt.body.case?.vaultIngestedAt === "string",
      "A carries a vaultIngestedAt after the receipt",
    );
    check(
      aAfterReceipt.body.case?.vaultIngestedAt === aAfterReceipt.body.case?.updatedAt,
      "(equal-stamp invariant) vaultIngestedAt === updatedAt on the receipted case",
    );

    // ── 4. (c) Update A after its receipt → gap again, reason "stale". The sleep
    // kills the same-millisecond flake (both stamps are nowISO(); strict `<` ties). ──
    await sleep(30);
    const patchA = await PATCH(`/api/cases/${encodeURIComponent(A)}`, { summary: "touched after receipt" });
    check(patchA.status === 200, `PATCH A (touch) → 200 (got ${patchA.status})`);

    const cov2 = await coverage();
    const gapA2 = gapFor(cov2.body, A);
    check(!!gapA2, "(c) A is a gap again after being updated past its receipt");
    check(gapA2?.reason === "stale", `(c) A's reason is now "stale" (got ${gapA2?.reason})`);

    // ── 5. (d again) B updated stays out of coverage — no vaultLinks, ever. ────────
    const patchB = await PATCH(`/api/cases/${encodeURIComponent(B)}`, { summary: "touched, still unlinked" });
    check(patchB.status === 200, `PATCH B (touch) → 200 (got ${patchB.status})`);
    const cov3 = await coverage();
    check(!gapFor(cov3.body, B), "(d again) B still never appears after being updated");

    // ── 6. Mixed known/unknown receipt ids; empty ids → 400. Uses B (harmless — it
    // has no vaultLinks) so A's freshly-established "stale" state survives for step 7. ──
    const mixed = await POST("/api/cases/vault-receipt", { ids: [B, "CASE-9999999"] });
    check(mixed.status === 200, `POST vault-receipt [B, unknown] → 200 (got ${mixed.status})`);
    check(
      Array.isArray(mixed.body.marked) && mixed.body.marked.includes(B),
      `mixed receipt marks the known id B (got ${JSON.stringify(mixed.body.marked)})`,
    );
    check(
      Array.isArray(mixed.body.unknown) && mixed.body.unknown.includes("CASE-9999999"),
      `mixed receipt reports the unknown id back (got ${JSON.stringify(mixed.body.unknown)})`,
    );

    const empty = await POST("/api/cases/vault-receipt", { ids: [] });
    check(empty.status === 400, `POST vault-receipt with empty ids → 400 (got ${empty.status})`);

    // ── 7. Archive A → hidden by default, shown under includeArchived=1. ──────────
    const archiveA = await PATCH(`/api/cases/${encodeURIComponent(A)}`, { archivedAt: new Date().toISOString() });
    check(archiveA.status === 200, `PATCH A archivedAt → 200 (got ${archiveA.status})`);

    const cov4 = await coverage();
    check(!gapFor(cov4.body, A), "archived A is hidden from the default coverage view");
    const cov4all = await coverage("?includeArchived=1");
    check(!!gapFor(cov4all.body, A), "archived A reappears under ?includeArchived=1");
  } finally {
    // Cleanup: A and B are both `done` (created that way) → one clean call.
    const ids = [A, B].filter(Boolean);
    if (ids.length) await POST("/api/cases/clean", { ids });

    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — vault-ingest receipt + coverage read hold (never/stale/covered, equal-stamp, mixed ids, archive visibility).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
