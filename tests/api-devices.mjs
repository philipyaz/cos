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
//   • (cos-ops#137, AC 4) the MCP round trip: a REAL spawn of the board MCP server, its env
//     taken from mcp/service-manifest.mjs's resolved 'board' entry and pointed at THIS
//     sandbox board, calling get_device_status (the ONE tool that both registers the caller
//     AND renders it — a plain read tool records nothing) actually registers a device here.
//     getManifest() runs INSIDE this section's own guarded branch: a mid-edit config/cos.env
//     degrades it to a self-scoped NOT RUN line instead of reddening this whole file — a
//     broken manifest is [13b3]'s subject, not this one's.
//
// Env: CRM_BASE_URL (board url).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_SERVER = path.join(HERE, "..", "mcp", "board-server", "server.mjs");
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

// newline-delimited JSON-RPC client over a spawned MCP server's stdio (same framing as
// api-vault.mjs / mcp-kit-idle.mjs / mcp-device-headers.mjs).
function makeMcpClient(child) {
  let nextId = 1;
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 5000);
    });
  };
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { request, notify };
}

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
  // COWORK_SKILLS_DIR is this machine's local source for Cowork-installed-skill drift
  // (board/lib/cowork-skills.ts, ops#117) — shape-only, same as joinBlob above: on the hub
  // the sandbox board reads the REAL cache read-only; on CI the path is absent and every
  // row reads unknown, staleCount 0. Both are accepted modes; no value assertion either way.
  check(
    Array.isArray(r.body?.coworkSkills) &&
      r.body.coworkSkills.every((row) => ["current", "stale", "not-installed", "unknown"].includes(row?.state)),
    "coworkSkills[] is an array with every state in the four-value set",
  );
  check(
    typeof r.body?.coworkSkillsStaleCount === "number" && r.body.coworkSkillsStaleCount >= 0,
    `coworkSkillsStaleCount is a number >= 0 (got ${r.body?.coworkSkillsStaleCount})`,
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

  // ── AC 4 (cos-ops#137): the MCP round trip actually registers a device ────
  // A REAL spawn of the board MCP server, its env taken from the manifest's resolved
  // 'board' entry (only CRM_BASE_URL is overridden, to THIS sandbox board) — proving
  // get_device_status reaches a running board through a real wrapper, not just that the
  // HTTP route works when a header is hand-set (the sections above). getManifest() is
  // called INSIDE this guarded branch: a mid-edit config/cos.env can make it throw for a
  // config reason that is [13b3]'s subject, not this file's — that degrades to a
  // self-scoped NOT RUN line rather than reddening this file's overall verdict.
  try {
    const { getManifest } = await import("../mcp/service-manifest.mjs");
    const entry = getManifest().find((e) => e.name === "board");
    if (!entry) {
      console.log("  NOT RUN (manifest has no 'board' entry): MCP round-trip");
    } else {
      const env = { ...process.env };
      delete env.COS_DEVICE_ID;
      delete env.COS_DEVICE_ROLE;
      Object.assign(env, entry.env, { CRM_BASE_URL: BASE });

      const child = spawn(process.execPath, [BOARD_SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      try {
        const early = await Promise.race([
          new Promise((res) => child.on("exit", () => res("exit"))),
          new Promise((res) => setTimeout(() => res("up"), 2500)),
        ]);
        if (early === "exit") {
          if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(stderr)) {
            console.log("  NOT RUN (board server deps not installed): MCP round-trip");
          } else {
            check(false, `MCP round-trip: the board server exited early — ${(stderr.split("\n")[0] || "no stderr").trim()}`);
          }
        } else {
          const client = makeMcpClient(child);
          await client.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "api-devices-test", version: "1.0.0" },
          });
          client.notify("notifications/initialized", {});
          await client.request("tools/call", { name: "get_device_status", arguments: {} });

          // The expectation comes from entry.env, NEVER r.body.deviceId: run.sh:415 gives
          // this sandbox board its own COS_DEVICE_ID="test-board" as a spawn prefix, so the
          // envelope's own identity is not the wrapper's — the wrapper is a separate caller
          // registering itself, exactly like the hand-set-header sections above.
          const expectedId = String(entry.env.COS_DEVICE_ID).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
          r = await GET("/api/devices");
          check(
            devIds(r.body).includes(expectedId),
            `MCP round-trip: get_device_status through a REAL spawned board wrapper registers ${expectedId} (got [${devIds(r.body).join(", ")}])`,
          );
        }
      } finally {
        child.kill();
      }
    }
  } catch (e) {
    console.log(`  NOT RUN (${String(e?.message || e).split("\n")[0]}): MCP round-trip`);
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
