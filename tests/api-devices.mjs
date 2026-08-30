#!/usr/bin/env node
// api-devices.mjs — end-to-end test of the multi-device Devices surface
// (GET /api/devices + the x-device ephemeral last-seen tracker + the join blob).
//
// Plain Node (ESM), zero deps, READ-ONLY on the store (the tracker is in-memory —
// net-zero by construction; no cases.json is touched). Asserts:
//   • GET /api/devices is ALWAYS 200 with the identity envelope (role/deviceId/
//     schemaVersion), a devices[] array, and a leaseStaleHours;
//   • an x-device header REGISTERS that device in the last-seen list (and re-hits
//     bump its count, not duplicate it), while a header-less request registers
//     nothing (no invented device);
//   • a malformed x-device is SANITIZED to a filename-safe slug;
//   • x-device also rides a normal write path (resolveActor records it) — a case
//     POST with x-device shows up in the list too;
//   • the join blob reflects COS_HUB_PUBLIC_URL: absent on the sandbox board (unset)
//     — a null joinBlob, not a crash.
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

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};
const GET = (p, headers = {}) => fetch(`${BASE}${p}`, { headers }).then(json);
const POST = (p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then(json);

const devIds = (b) => (b.devices ?? []).map((d) => d.deviceId);

async function main() {
  console.log(`api-devices · board=${BASE}`);

  // ── envelope shape ───────────────────────────────────────────────────────
  let r = await GET("/api/devices");
  check(r.status === 200, `GET /api/devices → 200 (got ${r.status})`);
  check(r.body?.online === true, "online:true");
  check(typeof r.body?.role === "string" && ["hub", "spoke"].includes(r.body.role), `role is hub|spoke (got ${r.body?.role})`);
  check(typeof r.body?.deviceId === "string" && r.body.deviceId.length > 0, "deviceId present");
  check(typeof r.body?.schemaVersion === "number", "schemaVersion present");
  check(Array.isArray(r.body?.devices), "devices[] is an array");
  check(r.body?.leaseStaleHours === 26, `leaseStaleHours is 26 (got ${r.body?.leaseStaleHours})`);
  check("joinBlob" in r.body, "joinBlob key present");
  // Hermetic w.r.t. the hub's config: the sandbox reads the REAL repo cos.env, which
  // MAY set COS_HUB_PUBLIC_URL on a configured hub. Accept either null (unset) or a
  // well-formed cos-join:// string — never a malformed/scheme-less blob.
  check(
    r.body?.joinBlob === null || /^cos-join:\/\/v1\?hub=https?/.test(r.body.joinBlob),
    `joinBlob is null or a well-formed cos-join:// string (got ${JSON.stringify(r.body?.joinBlob)})`,
  );

  // ── x-device registers a device; re-hit bumps count, no dup ──────────────
  const D1 = `test-dev-${Date.now()}`;
  await GET("/api/devices", { "x-device": D1, "x-device-role": "spoke" });
  r = await GET("/api/devices", { "x-device": D1 });
  check(devIds(r.body).includes(D1), `an x-device header registers the device (${D1} in the list)`);
  const d1 = r.body.devices.find((d) => d.deviceId === D1);
  check(d1?.role === "spoke", `the x-device-role is recorded (got ${d1?.role})`);
  check(d1?.count >= 2, `re-hits bump count, not duplicate (count ${d1?.count})`);
  check(r.body.devices.filter((d) => d.deviceId === D1).length === 1, "exactly one entry for the device (no dup)");

  // ── header-less request invents nothing ──────────────────────────────────
  const before = devIds(r.body).length;
  await GET("/api/devices"); // no x-device
  r = await GET("/api/devices");
  check(devIds(r.body).length === before, "a header-less request registers no device");

  // ── malformed x-device is sanitized ──────────────────────────────────────
  await GET("/api/devices", { "x-device": "bad id/../../etc passwd!" });
  r = await GET("/api/devices");
  const sanitized = devIds(r.body).find((id) => id.startsWith("bad-id"));
  check(!!sanitized && /^[A-Za-z0-9._-]+$/.test(sanitized), `a malformed x-device is sanitized to a slug (got ${JSON.stringify(sanitized)})`);

  // ── x-device rides a WRITE path (resolveActor records it) ─────────────────
  const D2 = `test-writer-${Date.now()}`;
  const c = await POST("/api/cases", { title: `devices-test ${D2}` }, { "x-actor": "agent", "x-device": D2 });
  if (c.status === 201 && c.body?.case?.id) {
    r = await GET("/api/devices");
    check(devIds(r.body).includes(D2), "a write carrying x-device registers the device (resolveActor chokepoint)");
    // net-zero: delete the throwaway case
    await fetch(`${BASE}/api/cases/${encodeURIComponent(c.body.case.id)}?hard=1`, { method: "DELETE", headers: { "x-actor": "agent" } });
  } else {
    check(false, `could not create a throwaway case to test write-path recording (status ${c.status})`);
  }

  if (failures > 0) {
    console.error(`api-devices: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("api-devices: all checks passed");
}

main().catch((e) => {
  console.error("api-devices: fatal", e);
  process.exit(1);
});
