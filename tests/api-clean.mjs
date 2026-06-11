#!/usr/bin/env node
// api-clean.mjs — end-to-end test of the "Clean Done" HTTP verb (POST /api/cases/clean).
//
// Plain Node (ESM), zero deps. Drives the storage-reclaiming purge against a RUNNING
// board and asserts the contract end-to-end:
//   • clean PERMANENTLY removes the given DONE cases AND deletes their linked emails
//     (vs the per-case DELETE ?hard=1, which keeps messages) — the JSON shrinks;
//   • an email ALSO linked to a reminder is KEPT + unlinked (not deleted), so the
//     reminder's linked-email view survives the purge;
//   • the route is DONE-ONLY: a non-done id in the list is skipped (its case + emails
//     survive), so a stale/wrong client list can never delete an in-flight case;
//   • the response carries { ok, removed, messagesDeleted, version } and bumps version;
//   • an unknown id is ignored (idempotent, zero counts); a non-array `ids` → 400.
//
// Snapshots board/data/cases.json first and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero) — cases, messages AND reminders all live
// in cases.json. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-clean.mjs         # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

// --- tiny check harness ------------------------------------------------------
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- fetch helpers -----------------------------------------------------------
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
const POST = (p, b, h) => api("POST", p, b, h);
const PATCH = (p, b, h) => api("PATCH", p, b, h);

const enc = encodeURIComponent;

async function main() {
  console.log(`api-clean · board=${BASE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    const marker = `apiclean-${Date.now()}`;

    // ── Seed: two DONE cases (one with a reminder-linked email), one TODO case ──
    // C1 (done): its email M1 is ALSO linked to reminder R1 → must SURVIVE the purge.
    const c1 = await POST("/api/cases", { title: `clean C1 ${marker}`, status: "done", domain: "work" });
    check(c1.status === 201, `create done case C1 → 201 (got ${c1.status})`);
    const C1 = c1.body.case?.id;

    const m1 = await POST(`/api/cases/${enc(C1)}/messages`, {
      source: "gmail",
      from: `alice-${marker}@example.com`,
      subject: `C1 mail ${marker}`,
      body: "x".repeat(400),
    });
    check(m1.status === 201, `link email M1 to C1 → 201 (got ${m1.status})`);
    const M1 = m1.body.message?.id;
    check(m1.body.message?.caseId === C1, "M1 is linked to C1");

    const r1 = await POST("/api/reminders", { title: `clean R1 ${marker}` });
    check(r1.status === 201, `create reminder R1 → 201 (got ${r1.status})`);
    const R1 = r1.body.reminder?.id;

    const relinkM1 = await PATCH(`/api/messages/${enc(M1)}`, { reminderId: R1 });
    check(relinkM1.status === 200, `link M1 to reminder R1 (PATCH reminderId) → 200 (got ${relinkM1.status})`);

    // C2 (done): its email M2 is case-only → must be DELETED by the purge.
    const c2 = await POST("/api/cases", { title: `clean C2 ${marker}`, status: "done", domain: "work" });
    const C2 = c2.body.case?.id;
    const m2 = await POST(`/api/cases/${enc(C2)}/messages`, {
      source: "gmail",
      from: `bob-${marker}@example.com`,
      subject: `C2 mail ${marker}`,
      body: "y".repeat(400),
    });
    check(m2.status === 201, `link email M2 to C2 → 201 (got ${m2.status})`);
    const M2 = m2.body.message?.id;

    // C3 (TODO): in the clean list but NOT done → the done-guard must SKIP it.
    const c3 = await POST("/api/cases", { title: `clean C3 ${marker}`, status: "todo", domain: "work" });
    const C3 = c3.body.case?.id;
    const m3 = await POST(`/api/cases/${enc(C3)}/messages`, {
      source: "gmail",
      from: `carol-${marker}@example.com`,
      subject: `C3 mail ${marker}`,
    });
    check(m3.status === 201, `link email M3 to C3 → 201 (got ${m3.status})`);
    const M3 = m3.body.message?.id;

    // Pre-clean sanity: all three cases exist; R1 lists M1.
    check((await GET(`/api/cases/${enc(C1)}`)).status === 200, "C1 exists before clean");
    check((await GET(`/api/cases/${enc(C3)}`)).status === 200, "C3 exists before clean");
    const r1Before = (await GET(`/api/reminders/${enc(R1)}`)).body;
    check(
      Array.isArray(r1Before.messages) && r1Before.messages.some((m) => m.id === M1),
      "R1 lists its linked email M1 before clean",
    );

    const vBefore = (await GET("/api/cases")).body.version;

    // ── Clean: purge [C1, C2, C3]. Expect: C1+C2 removed (done), C3 skipped (todo);
    //    M2 deleted; M1 kept (reminder-linked). ─────────────────────────────────
    const cleaned = await POST("/api/cases/clean", { ids: [C1, C2, C3] });
    check(cleaned.status === 200, `POST /api/cases/clean → 200 (got ${cleaned.status})`);
    check(cleaned.body.ok === true, "clean response is ok:true");
    check(cleaned.body.removed === 2, `removed === 2 (the two DONE cases; got ${cleaned.body.removed})`);
    check(
      cleaned.body.messagesDeleted === 1,
      `messagesDeleted === 1 (M2 only; M1 kept via reminder; got ${cleaned.body.messagesDeleted})`,
    );
    check(
      typeof cleaned.body.version === "number" && cleaned.body.version > vBefore,
      `clean bumps the version (${vBefore} → ${cleaned.body.version})`,
    );

    // ── Post-clean assertions ──────────────────────────────────────────────────
    check((await GET(`/api/cases/${enc(C1)}`)).status === 404, "C1 is gone (GET → 404)");
    check((await GET(`/api/cases/${enc(C2)}`)).status === 404, "C2 is gone (GET → 404)");

    // C3 (todo) survived — the done-only guard skipped it; M3 survives with it.
    const c3After = await GET(`/api/cases/${enc(C3)}`);
    check(c3After.status === 200, "C3 (todo) SURVIVED the clean (done-only guard)");
    check(
      Array.isArray(c3After.body.messages) && c3After.body.messages.some((m) => m.id === M3),
      "C3 still lists its email M3 (the non-done case's mail is untouched)",
    );

    // M2 was DELETED — a PATCH to it now 404s (the message is gone).
    const m2After = await PATCH(`/api/messages/${enc(M2)}`, { read: true });
    check(m2After.status === 404, `M2 was deleted (PATCH → 404; got ${m2After.status})`);

    // M1 SURVIVED (reminder-linked) — it's still patchable, still listed under R1,
    // and its dangling case link was cleared.
    const m1After = await PATCH(`/api/messages/${enc(M1)}`, { read: true });
    check(m1After.status === 200, `M1 survived (PATCH → 200; got ${m1After.status})`);
    const r1After = (await GET(`/api/reminders/${enc(R1)}`)).body;
    const m1Row = (r1After.messages || []).find((m) => m.id === M1);
    check(!!m1Row, "R1 STILL lists M1 after the clean (reminder link preserved)");
    check(m1Row && (m1Row.caseId === undefined || m1Row.caseId === null), "M1's dangling caseId was cleared");

    // ── Validation / idempotency ───────────────────────────────────────────────
    const noIds = await POST("/api/cases/clean", { not: "ids" });
    check(noIds.status === 400, `POST clean with no ids → 400 (got ${noIds.status})`);
    const badIds = await POST("/api/cases/clean", { ids: "CASE-1" });
    check(badIds.status === 400, `POST clean with non-array ids → 400 (got ${badIds.status})`);
    const unknown = await POST("/api/cases/clean", { ids: ["CASE-99999", "nope"] });
    check(unknown.status === 200, `POST clean with unknown ids → 200 (got ${unknown.status})`);
    check(
      unknown.body.removed === 0 && unknown.body.messagesDeleted === 0,
      "unknown ids are a no-op (removed:0, messagesDeleted:0)",
    );
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} clean check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — Clean-Done API holds (purge done cases + emails / keep reminder-linked / done-only guard / version bump / validation).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
