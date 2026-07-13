#!/usr/bin/env node
// api-healthz.mjs — the machine-identity handshake endpoint (GET /api/healthz).
//
// Plain Node (ESM), zero deps, READ-ONLY (net-zero by construction). Asserts the
// contract spoke wrappers + the Devices UI rely on:
//   • 200 with { ok:true } — it must answer even when sub-reads degrade;
//   • role is "hub" on a role-unset machine (the default; the test board never
//     configures a role) and deviceId is a non-empty filename-safe slug;
//   • schemaVersion is the CODE's constant and diskSchemaVersion the RAW on-disk
//     value, with degradedRead === (disk > code) — the skew handshake;
//   • appVersion is the root package.json version (or null when unreadable);
//   • lease is null (no backup repo on the sandbox) or a well-formed object.
//
// Env: CRM_BASE_URL (board url).
const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

async function main() {
  console.log(`api-healthz · board=${BASE}`);
  const res = await fetch(`${BASE}/api/healthz`);
  check(res.status === 200, `GET /api/healthz → 200 (got ${res.status})`);
  const b = await res.json();

  check(b.ok === true, "ok:true");
  check(b.role === "hub", `role defaults to hub (got ${JSON.stringify(b.role)})`);
  check(
    typeof b.deviceId === "string" && b.deviceId.length > 0 && /^[A-Za-z0-9._-]+$/.test(b.deviceId),
    `deviceId is a non-empty slug (got ${JSON.stringify(b.deviceId)})`,
  );
  check(typeof b.schemaVersion === "number" && b.schemaVersion >= 14, `schemaVersion is the code's constant (got ${b.schemaVersion})`);
  check(typeof b.diskSchemaVersion === "number", `diskSchemaVersion is the raw on-disk value (got ${b.diskSchemaVersion})`);
  check(
    b.degradedRead === (b.diskSchemaVersion > b.schemaVersion),
    `degradedRead === disk>code (${b.diskSchemaVersion} vs ${b.schemaVersion} → ${b.degradedRead})`,
  );
  check(b.appVersion === null || typeof b.appVersion === "string", `appVersion is a version string or null (got ${JSON.stringify(b.appVersion)})`);
  check(
    b.lease === null || (typeof b.lease === "object" && typeof b.lease.deviceId === "string" && typeof b.lease.stale === "boolean"),
    `lease is null or a well-formed lease view (got ${JSON.stringify(b.lease)})`,
  );

  if (failures > 0) {
    console.error(`api-healthz: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("api-healthz: all checks passed");
}

main().catch((e) => {
  console.error("api-healthz: fatal", e);
  process.exit(1);
});
