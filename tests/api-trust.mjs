#!/usr/bin/env node
// api-trust.mjs — end-to-end lifecycle test of the guard sender-trust WHITELIST
// HTTP API as exposed by the BOARD's thin PROXY routes (board/app/api/trust/**).
//
// Plain Node (ESM), zero deps. Drives a RUNNING board (which in turn proxies a live
// guard SIDECAR on 127.0.0.1:8009 — env COS_GUARD_URL) and asserts the contract the
// Settings > Whitelist UI consumes:
//   • GET  /api/trust            → ALWAYS 200 { online, senders, count, guardUrl }.
//                                  online:false ⇒ the sidecar is down → SKIP the rest
//                                  gracefully (CI may have no guard sidecar; this is
//                                  NOT a failure). online:true ⇒ run the lifecycle.
//   • POST /api/trust { email }  → 200 { record }, record.trust == "trusted" (default
//                                  tier); the upsert appends a provenance audit line.
//   • GET  /api/trust            → now lists the sender (keyed by lowercased email).
//   • POST again { trust:"blocked" } → flips the tier in place (record.trust=="blocked").
//   • DELETE /api/trust/{email}  → 200 { email, removed:true, trust:"unknown" }.
//   • GET  /api/trust            → the sender is gone (cleared to the implicit "unknown").
//   • POST { } / { email:"garbage" } → 400 (email required + a basic shape; the route
//                                  rejects before it ever reaches the sidecar).
//   • POST { email, trust:"unknown" } → 400 (you DELETE to clear a sender; "unknown" is
//                                  the implicit absent tier, never a persisted write).
//
// NET-ZERO: the whitelist lives in the SIDECAR (guard/data/trusted-senders.json), NOT
// in board/data/cases.json — so there is no cases.json to snapshot here. Instead we use
// a UNIQUE throwaway test email (cos-trust-test+<pid>-<ts>@example.test) and DELETE it in
// a `finally`, so the live whitelist is left EXACTLY as found. The suffix is generated
// INSIDE this file (process.pid + Date.now()) — this is a plain Node script run directly,
// not a workflow step, so normal PID/timing APIs are fine here.
//
// Requires a running board AND a live guard sidecar:
//   cd guard && uv run uvicorn sidecar:app --port 8009   # the guard trust sidecar
//   cd board && npm run dev                              # or npm run start
//   node tests/api-trust.mjs                             # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_GUARD_URL (read only for the SKIP message; the
// board owns the actual proxy hop).

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

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

const api = (method, p, body) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const DELETE = (p) => api("DELETE", p);

// The whitelist is keyed by the LOWERCASED email; the GET returns a senders MAP.
// Helper: does the current whitelist list this email?
const listSenders = async () => (await GET("/api/trust")).body.senders || {};

async function main() {
  console.log(`api-trust · board=${BASE}`);

  // A UNIQUE throwaway email so the run can't collide with a real sender and is trivial
  // to clean up. Lowercased to match the sidecar's normalization (the GET key).
  const suffix = `${process.pid}-${Date.now()}`;
  const TEST_EMAIL = `cos-trust-test+${suffix}@example.test`.toLowerCase();

  // ----------------------------------------------------------------------
  // GET /api/trust → ALWAYS 200 with the render-ready shape. online:false means
  // the guard sidecar is down → SKIP the lifecycle gracefully (a clear message,
  // exit 0), since the sidecar may legitimately be absent in CI.
  // ----------------------------------------------------------------------
  const initial = await GET("/api/trust");
  check(initial.status === 200, `GET /api/trust → 200 (got ${initial.status})`);
  check(typeof initial.body.online === "boolean", `GET response carries a boolean online flag (${initial.body.online})`);
  check(
    initial.body.senders && typeof initial.body.senders === "object",
    "GET response carries a senders map",
  );
  check(typeof initial.body.guardUrl === "string", `GET response carries the guardUrl (${initial.body.guardUrl})`);

  if (initial.body.online !== true) {
    console.log(
      `\nSKIP — guard sidecar offline (GET /api/trust returned online:false${initial.body.error ? `: ${initial.body.error}` : ""}).` +
        `\n       The whitelist lives in the guard sidecar (${initial.body.guardUrl || process.env.COS_GUARD_URL || "http://127.0.0.1:8009"});` +
        `\n       start it to run the trust lifecycle: cd guard && uv run uvicorn sidecar:app --port 8009`,
    );
    // online:false is a healthy, expected state (sidecar down) — NOT a test failure.
    // We still report any failed shape checks above; otherwise exit 0 (skipped).
    if (failures) {
      console.error(`\nFAIL — ${failures} trust-api shape check(s) failed (offline path).`);
      process.exit(1);
    }
    console.log("\nPASS (skipped lifecycle) — GET /api/trust holds the always-200 offline shape.");
    return;
  }

  // online — run the full lifecycle. Clean up the test email in a `finally` so the
  // live whitelist is left EXACTLY as found (net-zero), even if an assertion throws.
  try {
    // Sanity: our unique email is not somehow already present (it never should be).
    check(!(TEST_EMAIL in (initial.body.senders || {})), `the unique test email is absent before the test (${TEST_EMAIL})`);

    // ------------------------------------------------------------------
    // POST /api/trust { email } → 200 { record }, default tier "trusted".
    // The provenance audit line is appended by the sidecar (route defaults the note).
    // ------------------------------------------------------------------
    const added = await POST("/api/trust", { email: TEST_EMAIL, reason: "api-trust test seed" });
    check(added.status === 200, `POST /api/trust → 200 (got ${added.status})`);
    const rec = added.body.record;
    check(!!rec, "POST returned a { record }");
    check(rec?.email === TEST_EMAIL, `the record email matches the lowercased input (${rec?.email})`);
    check(rec?.trust === "trusted", `POST with no trust defaults the tier to "trusted" (got ${rec?.trust})`);
    check(
      Array.isArray(rec?.provenance) && rec.provenance.length > 0,
      "the upsert stamped a provenance audit trail",
    );

    // ------------------------------------------------------------------
    // GET /api/trust → the whitelist now lists the sender (keyed by email).
    // ------------------------------------------------------------------
    const afterAdd = await GET("/api/trust");
    check(afterAdd.status === 200, `GET /api/trust after add → 200 (got ${afterAdd.status})`);
    check(afterAdd.body.online === true, "GET still reports online:true after the add");
    const listedRec = afterAdd.body.senders?.[TEST_EMAIL];
    check(!!listedRec, "the added sender appears in the senders map");
    check(listedRec?.trust === "trusted", `the listed sender is "trusted" (got ${listedRec?.trust})`);
    check(
      typeof afterAdd.body.count === "number" && afterAdd.body.count >= 1,
      `the count reflects at least one sender (${afterAdd.body.count})`,
    );

    // ------------------------------------------------------------------
    // POST again { trust:"blocked" } → flips the tier IN PLACE (same email).
    // ------------------------------------------------------------------
    const flipped = await POST("/api/trust", { email: TEST_EMAIL, trust: "blocked" });
    check(flipped.status === 200, `POST { trust:"blocked" } → 200 (got ${flipped.status})`);
    check(flipped.body.record?.trust === "blocked", `the tier flipped to "blocked" (got ${flipped.body.record?.trust})`);
    const afterFlip = await listSenders();
    check(afterFlip[TEST_EMAIL]?.trust === "blocked", "a re-GET shows the persisted blocked tier");

    // ------------------------------------------------------------------
    // POST { trust:"unknown" } → 400. "unknown" is the implicit ABSENT tier; you
    // DELETE to clear a sender, never POST trust:"unknown".
    // ------------------------------------------------------------------
    const badTier = await POST("/api/trust", { email: TEST_EMAIL, trust: "unknown" });
    check(badTier.status === 400, `POST { trust:"unknown" } → 400 (got ${badTier.status})`);
    check(typeof badTier.body.error === "string", "the bad-tier 400 carries an { error } message");

    // ------------------------------------------------------------------
    // POST validation → bad / missing email → 400 (rejected before the sidecar).
    // ------------------------------------------------------------------
    const garbage = await POST("/api/trust", { email: "not-an-email" });
    check(garbage.status === 400, `POST { email:"not-an-email" } → 400 (got ${garbage.status})`);
    check(/email/i.test(garbage.body.error || ""), `the garbage-email 400 mentions the email ("${garbage.body.error}")`);

    const missing = await POST("/api/trust", { reason: "no email here" });
    check(missing.status === 400, `POST with no email → 400 (got ${missing.status})`);

    // ------------------------------------------------------------------
    // DELETE /api/trust/{email} → 200 { email, removed:true, trust:"unknown" }.
    // (encodeURIComponent the email: it contains a '+', a special URL char.)
    // ------------------------------------------------------------------
    const removed = await DELETE(`/api/trust/${encodeURIComponent(TEST_EMAIL)}`);
    check(removed.status === 200, `DELETE /api/trust/{email} → 200 (got ${removed.status})`);
    check(removed.body.removed === true, `DELETE reports removed:true (got ${removed.body.removed})`);
    check(removed.body.trust === "unknown", `DELETE reports the resulting tier "unknown" (got ${removed.body.trust})`);

    // ------------------------------------------------------------------
    // GET /api/trust → the sender is gone (cleared to the implicit "unknown").
    // ------------------------------------------------------------------
    const afterDelete = await listSenders();
    check(!(TEST_EMAIL in afterDelete), "the deleted sender no longer appears in the whitelist");
  } finally {
    // Belt-and-suspenders cleanup: even if an assertion above threw mid-flight, make
    // sure the throwaway test email is removed so the live whitelist is net-zero.
    // (Idempotent — DELETE on an already-absent sender is a clean removed:false/200.)
    try {
      await DELETE(`/api/trust/${encodeURIComponent(TEST_EMAIL)}`);
      console.log("  ↩ cleaned up the test sender (whitelist left as found)");
    } catch {
      /* best effort — the sidecar may have gone down mid-run; nothing else to do */
    }
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} trust-api check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — trust whitelist API holds (GET online shape, add/list/tier-flip/delete lifecycle, unknown-tier + bad-email 400s, net-zero).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running AND the guard sidecar up? start them: cd guard && uv run uvicorn sidecar:app --port 8009 ; cd board && npm run dev)");
  process.exit(1);
});
