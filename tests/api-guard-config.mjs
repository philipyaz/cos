#!/usr/bin/env node
// api-guard-config.mjs — end-to-end test of the guard "Security" MASTER TOGGLE
// (the enabled flag) as exposed by the BOARD's thin PROXY route (board/app/api/
// guard/config/route.ts).
//
// Plain Node (ESM), zero deps. Drives a RUNNING board (which in turn proxies a live
// guard SIDECAR on 127.0.0.1:8009 — env COS_GUARD_URL) and asserts the contract the
// Settings > Security UI (GuardControl) consumes:
//   • GET  /api/guard/config        → ALWAYS 200 { online, enabled, classifier, model,
//                                      preset, threshold, degraded, ready, deps, active,
//                                      activeModelId, models, guardUrl }.
//                                      online:false ⇒ the sidecar is down → SKIP the rest
//                                      gracefully (CI may have no guard sidecar; this is
//                                      NOT a failure). online:true ⇒ run the lifecycle.
//   • POST /api/guard/config {enabled:true}  → 200 { … enabled:true … } (the fresh full
//                                      config, so the client can reseed deps+models).
//   • GET  /api/guard/config        → now reports enabled:true (persisted in the sidecar).
//   • POST /api/guard/config {enabled:false} → 200 { … enabled:false … }; GET → enabled:false.
//   • POST {releasedTtlDays:N}      → 200; the released-record retention window persists AND
//                                      the toggle is NOT clobbered (read-modify-write); 0 is
//                                      valid (auto-purge off); a negative / non-number → 400.
//   • POST { } / { enabled:"x" }    → 400 (an empty body changes nothing; enabled must be a
//                                      boolean — the route rejects the bad body before the sidecar).
//
// THE TOGGLE IS A SECURITY CONTROL — flipping it changes whether inbound mail is screened.
// DEFAULT is OFF; turning it ON makes the guard scan, turning it OFF makes scans a
// passthrough. We must NOT leave the live machine in a different state than we found it.
//
// NET-ZERO: the enabled flag lives in the SIDECAR (guard/data/guard-config.json), NOT in
// board/data/cases.json — so there is no cases.json to snapshot here. Instead we CAPTURE
// the original enabled value from the very first GET and RESTORE it in a `finally`, so the
// live guard is left EXACTLY as found (whatever the user had configured), even if an
// assertion throws mid-flight.
//
// Requires a running board AND a live guard sidecar:
//   cd guard && uv run uvicorn sidecar:app --port 8009   # the guard sidecar
//   cd board && npm run dev                              # or npm run start
//   node tests/api-guard-config.mjs                      # CRM_BASE_URL defaults to http://localhost:3000
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

// The toggle is keyed by nothing — it is a single boolean. Helper: read the live enabled.
const readEnabled = async () => (await GET("/api/guard/config")).body.enabled;

async function main() {
  console.log(`api-guard-config · board=${BASE}`);

  // ----------------------------------------------------------------------
  // GET /api/guard/config → ALWAYS 200 with the render-ready shape. online:false
  // means the guard sidecar is down → SKIP the lifecycle gracefully (a clear
  // message, exit 0), since the sidecar may legitimately be absent in CI.
  // ----------------------------------------------------------------------
  const initial = await GET("/api/guard/config");
  check(initial.status === 200, `GET /api/guard/config → 200 (got ${initial.status})`);
  check(typeof initial.body.online === "boolean", `GET response carries a boolean online flag (${initial.body.online})`);
  check(typeof initial.body.guardUrl === "string", `GET response carries the guardUrl (${initial.body.guardUrl})`);

  if (initial.body.online !== true) {
    console.log(
      `\nSKIP — guard sidecar offline (GET /api/guard/config returned online:false${initial.body.error ? `: ${initial.body.error}` : ""}).` +
        `\n       The enabled flag lives in the guard sidecar (${initial.body.guardUrl || process.env.COS_GUARD_URL || "http://127.0.0.1:8009"});` +
        `\n       start it to run the toggle lifecycle: cd guard && uv run uvicorn sidecar:app --port 8009`,
    );
    // online:false is a healthy, expected state (sidecar down) — NOT a test failure.
    // We still report any failed shape checks above; otherwise exit 0 (skipped).
    if (failures) {
      console.error(`\nFAIL — ${failures} guard-config-api shape check(s) failed (offline path).`);
      process.exit(1);
    }
    console.log("\nPASS (skipped lifecycle) — GET /api/guard/config holds the always-200 offline shape.");
    return;
  }

  // online — capture the ORIGINAL enabled so we can restore it (the toggle is a live
  // security control; we must leave it exactly as found). The full-config shape is
  // already covered by the dedicated python suite; here we assert the proxy contract.
  check(typeof initial.body.enabled === "boolean", `GET response carries a boolean enabled flag (${initial.body.enabled})`);
  check(initial.body.deps && typeof initial.body.deps === "object", "GET response carries a deps object");
  check(Array.isArray(initial.body.models), "GET response carries a models array");
  check(typeof initial.body.releasedTtlDays === "number", `GET response carries a numeric releasedTtlDays (${initial.body.releasedTtlDays})`);
  const original = initial.body.enabled;
  const originalTtl = initial.body.releasedTtlDays;

  // Run the full lifecycle. RESTORE the original enabled in a `finally` so the live
  // guard is left EXACTLY as found (net-zero), even if an assertion throws.
  try {
    // ------------------------------------------------------------------
    // POST { enabled:true } → 200 with the fresh full config, enabled:true.
    // (The route re-fetches the merged /config + /models so the client reseeds.)
    // ------------------------------------------------------------------
    const turnedOn = await POST("/api/guard/config", { enabled: true });
    check(turnedOn.status === 200, `POST { enabled:true } → 200 (got ${turnedOn.status})`);
    check(turnedOn.body.enabled === true, `POST { enabled:true } echoes enabled:true (got ${turnedOn.body.enabled})`);
    check(turnedOn.body.online === true, "POST { enabled:true } returns the fresh online config");
    check(Array.isArray(turnedOn.body.models), "POST { enabled:true } reseeds the models catalog");

    // GET → the enabled flag is now persisted true in the sidecar.
    const afterOn = await readEnabled();
    check(afterOn === true, `a re-GET shows the persisted enabled:true (got ${afterOn})`);

    // ------------------------------------------------------------------
    // POST { enabled:false } → 200, enabled:false; GET → enabled:false.
    // ------------------------------------------------------------------
    const turnedOff = await POST("/api/guard/config", { enabled: false });
    check(turnedOff.status === 200, `POST { enabled:false } → 200 (got ${turnedOff.status})`);
    check(turnedOff.body.enabled === false, `POST { enabled:false } echoes enabled:false (got ${turnedOff.body.enabled})`);
    const afterOff = await readEnabled();
    check(afterOff === false, `a re-GET shows the persisted enabled:false (got ${afterOff})`);

    // ------------------------------------------------------------------
    // POST { releasedTtlDays:N } → 200, the window updates + PERSISTS, and the toggle is
    // NOT clobbered (the sidecar's set is read-modify-write). 0 is a valid value (auto-purge
    // off); a negative / non-number is rejected at the proxy with 400.
    // ------------------------------------------------------------------
    // Set a known enabled baseline first, so we can PROVE the TTL write preserves it.
    await POST("/api/guard/config", { enabled: true });
    const ttlSet = await POST("/api/guard/config", { releasedTtlDays: 11 });
    check(ttlSet.status === 200, `POST { releasedTtlDays:11 } → 200 (got ${ttlSet.status})`);
    check(ttlSet.body.releasedTtlDays === 11, `POST echoes releasedTtlDays:11 (got ${ttlSet.body.releasedTtlDays})`);
    check(ttlSet.body.enabled === true, `setting the window PRESERVED enabled:true (got ${ttlSet.body.enabled}) — no clobber`);
    const afterTtl = (await GET("/api/guard/config")).body.releasedTtlDays;
    check(afterTtl === 11, `a re-GET shows the persisted releasedTtlDays:11 (got ${afterTtl})`);

    // 0 disables auto-purge — a VALID value, not a rejection.
    const ttlZero = await POST("/api/guard/config", { releasedTtlDays: 0 });
    check(ttlZero.status === 200 && ttlZero.body.releasedTtlDays === 0, `POST { releasedTtlDays:0 } → 200 with 0 (auto-purge off, got ${ttlZero.body.releasedTtlDays})`);

    // invalid windows → 400 (rejected at the proxy): a negative and a non-number.
    const ttlNeg = await POST("/api/guard/config", { releasedTtlDays: -1 });
    check(ttlNeg.status === 400, `POST { releasedTtlDays:-1 } → 400 (got ${ttlNeg.status})`);
    const ttlStr = await POST("/api/guard/config", { releasedTtlDays: "soon" });
    check(ttlStr.status === 400, `POST { releasedTtlDays:"soon" } → 400 (got ${ttlStr.status})`);

    // ------------------------------------------------------------------
    // POST validation → a non-boolean / missing enabled → 400 (rejected before the
    // sidecar). enabled MUST be a boolean; the proxy is the gate for the bad body.
    // ------------------------------------------------------------------
    const badType = await POST("/api/guard/config", { enabled: "x" });
    check(badType.status === 400, `POST { enabled:"x" } → 400 (got ${badType.status})`);
    check(typeof badType.body.error === "string", "the bad-type 400 carries an { error } message");

    const missing = await POST("/api/guard/config", {});
    check(missing.status === 400, `POST { } (no fields) → 400 (got ${missing.status})`);
    check(/enabled/i.test(missing.body.error || ""), `the empty-body 400 names the fields ("${missing.body.error}")`);
  } finally {
    // Belt-and-suspenders cleanup: even if an assertion above threw mid-flight, restore the
    // toggle AND the retention window to the ORIGINAL state so the live security control is
    // net-zero. Idempotent — POSTing the same values the user already had is a clean no-op.
    // (Restoring the window restores its EFFECTIVE value; if it was using the env default it
    // becomes an explicit stored value of the same number — behaviorally identical.)
    try {
      await POST("/api/guard/config", { enabled: original });
      if (typeof originalTtl === "number") await POST("/api/guard/config", { releasedTtlDays: originalTtl });
      console.log(`  ↩ restored the guard toggle + retention window to original (enabled:${original}, releasedTtlDays:${originalTtl})`);
    } catch {
      /* best effort — the sidecar may have gone down mid-run; nothing else to do */
    }
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} guard-config-api check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — guard config API holds (GET online shape, enable→disable round-trip + persistence, releasedTtlDays set/persist/no-clobber + 0/invalid handling, bad-body 400, net-zero).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running AND the guard sidecar up? start them: cd guard && uv run uvicorn sidecar:app --port 8009 ; cd board && npm run dev)");
  process.exit(1);
});
