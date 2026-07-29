#!/usr/bin/env node
// api-needs-attention.mjs — the cos-ops#20 board-attention read contract:
// GET /api/cases/needs-attention.
//
// Plain Node (ESM), zero deps. Proves the route end-to-end against a RUNNING board:
//   (a) the response shape — four bucket arrays + counts (each equal to its array's
//       length; counts.total the sum of the four) + version;
//   (b) an overdue fixture (todo, past dueAt) appears in `overdue` with the documented
//       projection (id/title/domain/status/updatedAt present, dueAt echoed); a
//       future-due fixture does not;
//   (c) a bare todo fixture (no tasks, no priority) appears in `untriaged`; giving it a
//       priority removes it on the next GET (also proves the route is force-dynamic —
//       no stale cache);
//   (d) a fixture with no vaultLinks appears in `unlinked`; adding a vaultLinks entry
//       removes it;
//   (e) `agingWaiting` — key presence + array shape ONLY. `updatedAt` is server-stamped
//       on every write, so no HTTP sequence here can make a case idle past
//       STALE_AFTER_DAYS; that membership math is owned by tests/unit/selectors.test.ts
//       (the same unit-owns-logic / api-owns-wiring split api-vault-coverage.mjs uses).
//
// This is the test that would fail WITHOUT this change: on the pre-change tree the
// route 404s (there was no GET /api/cases/needs-attention).
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero — see
// api-vault-coverage.mjs for the same idiom). Fixtures are created NON-done — the
// OPPOSITE of api-vault-coverage's all-done fixtures, since a done case can never enter
// any bucket — so cleanup PATCHes each to `done` before the single POST /api/cases/clean.
// Requires a running board:
//   cd board && npm run dev
//   node tests/api-needs-attention.mjs    # CRM_BASE_URL defaults to http://localhost:3000
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

const needsAttention = async () => GET("/api/cases/needs-attention");
const inBucket = (body, bucket, id) => (body[bucket] ?? []).some((c) => c.id === id);

async function main() {
  console.log(`api-needs-attention · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  // Declared outside the try so `finally` can clean up even if an assertion throws
  // partway through (the snapshot restore below is the real safety net either way).
  let overdueId, futureId, untriagedId, unlinkedId;

  try {
    const marker = `apineedsattn-${Date.now()}`;

    // ── 1. (a) Baseline shape: four bucket arrays + counts + version. ─────────────
    const base = await needsAttention();
    check(base.status === 200, `GET needs-attention → 200 (got ${base.status})`);
    for (const bucket of ["overdue", "agingWaiting", "untriaged", "unlinked"]) {
      check(Array.isArray(base.body[bucket]), `(a) "${bucket}" is an array`);
      check(
        base.body.counts?.[bucket] === base.body[bucket].length,
        `(a) counts.${bucket} === ${bucket}.length`,
      );
    }
    const summed =
      base.body.overdue.length +
      base.body.agingWaiting.length +
      base.body.untriaged.length +
      base.body.unlinked.length;
    check(base.body.counts?.total === summed, "(a) counts.total is the sum of the four bucket sizes");
    check(typeof base.body.version === "number", "(a) version is a number");

    // ── 2. (b) Overdue fixture appears with the full projection; a future-due one
    // does not. Both carry a priority + a vaultLinks entry so they can't ALSO land in
    // untriaged/unlinked and muddy this check (buckets overlap by design elsewhere). ──
    const pastDue = "2020-01-02T00:00:00.000Z";
    const co = await POST("/api/cases", {
      title: `needs-attention overdue ${marker}`,
      domain: "work",
      status: "todo",
      dueAt: pastDue,
      priority: "P1",
      vaultLinks: ["Somewhere"],
    });
    check(co.status === 201, `create overdue fixture → 201 (got ${co.status})`);
    overdueId = co.body.case?.id;

    const farFuture = "2099-01-01T00:00:00.000Z";
    const cf = await POST("/api/cases", {
      title: `needs-attention future-due ${marker}`,
      domain: "work",
      status: "todo",
      dueAt: farFuture,
      priority: "P1",
      vaultLinks: ["Somewhere"],
    });
    check(cf.status === 201, `create future-due fixture → 201 (got ${cf.status})`);
    futureId = cf.body.case?.id;

    const na1 = await needsAttention();
    check(inBucket(na1.body, "overdue", overdueId), "(b) overdue fixture appears in `overdue`");
    const overdueEntry = na1.body.overdue.find((c) => c.id === overdueId);
    check(
      !!overdueEntry &&
        typeof overdueEntry.title === "string" &&
        typeof overdueEntry.domain === "string" &&
        typeof overdueEntry.status === "string" &&
        typeof overdueEntry.updatedAt === "string",
      "(b) the overdue projection carries id/title/domain/status/updatedAt",
    );
    check(
      overdueEntry?.dueAt === pastDue,
      `(b) the overdue projection echoes dueAt (got ${overdueEntry?.dueAt})`,
    );
    check(!inBucket(na1.body, "overdue", futureId), "(b) the future-due fixture does NOT appear in `overdue`");

    // ── 3. (c) Bare todo fixture (no tasks, no priority) is untriaged; giving it a
    // priority removes it — also proves the route is force-dynamic (no stale cache). ──
    const cu = await POST("/api/cases", {
      title: `needs-attention untriaged ${marker}`,
      domain: "work",
      status: "todo",
      vaultLinks: ["Somewhere"], // keep it OUT of unlinked so this check is unambiguous
    });
    check(cu.status === 201, `create untriaged fixture → 201 (got ${cu.status})`);
    untriagedId = cu.body.case?.id;

    const na2 = await needsAttention();
    check(inBucket(na2.body, "untriaged", untriagedId), "(c) bare todo fixture appears in `untriaged`");

    const patchU = await PATCH(`/api/cases/${encodeURIComponent(untriagedId)}`, { priority: "P2" });
    check(patchU.status === 200, `PATCH untriaged fixture priority → 200 (got ${patchU.status})`);
    const na3 = await needsAttention();
    check(!inBucket(na3.body, "untriaged", untriagedId), "(c) it leaves `untriaged` once it carries a priority");

    // ── 4. (d) Fixture with no vaultLinks is unlinked; adding a vaultLinks entry
    // removes it. ──────────────────────────────────────────────────────────────────
    const cl = await POST("/api/cases", {
      title: `needs-attention unlinked ${marker}`,
      domain: "work",
      status: "todo",
      priority: "P2", // keep it OUT of untriaged so this check is unambiguous
    });
    check(cl.status === 201, `create unlinked fixture → 201 (got ${cl.status})`);
    unlinkedId = cl.body.case?.id;

    const na4 = await needsAttention();
    check(inBucket(na4.body, "unlinked", unlinkedId), "(d) fixture with no vaultLinks appears in `unlinked`");

    const patchL = await PATCH(`/api/cases/${encodeURIComponent(unlinkedId)}`, { vaultLinks: ["X"] });
    check(patchL.status === 200, `PATCH unlinked fixture vaultLinks → 200 (got ${patchL.status})`);
    const na5 = await needsAttention();
    check(!inBucket(na5.body, "unlinked", unlinkedId), "(d) it leaves `unlinked` once it carries a vaultLinks entry");

    // ── 5. (e) agingWaiting: key presence + shape only — see header comment above. ──
    check(Array.isArray(na5.body.agingWaiting), "(e) `agingWaiting` is present and an array");
  } finally {
    // Cleanup: fixtures were created non-done (the opposite of api-vault-coverage's
    // all-done fixtures — a done case never enters any bucket) — PATCH each to done,
    // then one clean call, mirroring api-vault-coverage.mjs.
    const ids = [overdueId, futureId, untriagedId, unlinkedId].filter(Boolean);
    for (const id of ids) {
      await PATCH(`/api/cases/${encodeURIComponent(id)}`, { status: "done" });
    }
    if (ids.length) await POST("/api/cases/clean", { ids });

    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — needs-attention read holds (shape, overdue/untriaged/unlinked membership + transitions, agingWaiting shape).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
