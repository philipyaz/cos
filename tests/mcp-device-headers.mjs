#!/usr/bin/env node
// mcp-device-headers.mjs — the multi-device `x-device`/`x-device-role` PRODUCER contract
// (cos-ops#137). packages/mcp-kit/index.mjs's makeBoardApi() has sent these headers since
// ca095a4 (2026-07-26), but no board-facing wrapper descriptor ever carried the env keys
// that would feed it — so `GET /api/devices` read `devices: []` forever. This gate pins the
// fix from BOTH ends: the five descriptors on disk, and a REAL spawned wrapper's outbound
// request — not just that the three slug implementations agree on a value the test supplied
// itself (tests/unit/device-mirrors.test.ts mirror #3 does that, with a hand-set env).
//
// Three sections:
//   (a) Descriptor census (raw)   — each of the five board-facing descriptors' `env` carries
//                                   COS_DEVICE_ID/COS_DEVICE_ROLE as the LITERAL ${VAR} ref
//                                   string (refs, never literals — mcp/CLAUDE.md's golden rule).
//   (b) Census (resolved)         — mcp/service-manifest.mjs's getManifest() resolves the
//       + population                refs; the set of entries carrying CRM_BASE_URL (the
//                                   board-facing wrappers) is EXACTLY the fixed literal set
//                                   below — a sixth board-facing wrapper must extend this list
//                                   deliberately, or this gate reds on purpose — and each
//                                   carrier's resolved env has both keys PRESENT. This is a
//                                   PRESENCE pin, not a value pin: mcp/service-manifest.mjs's
//                                   interpolate() throws on an unresolved (undefined-or-empty)
//                                   ${VAR}, and config/load-config.sh refuses an invalid role,
//                                   so "non-empty id" / "valid role" cannot fail here once
//                                   getManifest() has returned at all — a broken manifest is
//                                   THIS gate's subject and fails loudly on its own, not via a
//                                   value assertion. The one direction a presence check CAN
//                                   catch is a descriptor that drops the ${VAR} ref entirely.
//   (c) Spawned-wrapper header    — spawn the BOARD server (one wrapper suffices: all five
//       (AC 1 + 3)                  share mcp-kit's producer and the byte-uniform descriptor
//                                   edit, and (b) already pins the other four) with its
//                                   MANIFEST-RESOLVED env pointed at a loopback stub instead of
//                                   the real board, drive one real tool call, and assert the
//                                   stub actually RECEIVED x-device/x-device-role. This is the
//                                   one section that proves a header is PRODUCED by a spawned
//                                   wrapper, not merely that the test supplied it by hand.
//
// Board-free, root-install-only: section (c) spawns mcp/board-server/server.mjs, which
// hard-imports @modelcontextprotocol/sdk, so on a fresh checkout with no `npm install` yet
// this SKIPs gracefully (exit 0) rather than failing — mirroring mcp-kit-idle.mjs / api-vault.mjs.
// Run UNCONDITIONALLY in tests/run.sh (it self-skips).
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BOARD_SERVER =
  process.env.BOARD_SERVER || path.join(REPO_ROOT, "mcp", "board-server", "server.mjs");

// Fixed literal set — deliberately never derived from the manifest itself (a sixth
// board-facing wrapper must extend this list by hand, which is the whole point: it turns
// "wrapper #6 forgot the device keys" from a silent gap back into this gate reddening).
const CARRIERS = ["board", "body", "calendar", "fitness", "nutrition"];

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// newline-delimited JSON-RPC client over the child's stdio (same framing as
// api-vault.mjs / mcp-kit-idle.mjs).
function makeClient(child) {
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

async function initialize(client) {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-device-headers-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
}

async function main() {
  console.log(`mcp-device-headers · board server=${BOARD_SERVER}`);

  // --- SKIP probe: root workspace deps must be installed for arm (c)'s spawn -------------
  {
    const probe = spawn(process.execPath, [BOARD_SERVER], {
      env: { ...process.env, CRM_BASE_URL: "http://127.0.0.1:3999" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    probe.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    const early = await Promise.race([
      new Promise((r) => probe.on("exit", () => r("exit"))),
      new Promise((r) => setTimeout(() => r("up"), 2500)),
    ]);
    if (early === "exit" && /Cannot find package|ERR_MODULE_NOT_FOUND/.test(stderr)) {
      console.log("\nSKIP — root workspace deps not installed (npm install at the repo root).");
      process.exit(0);
    }
    probe.kill();
  }

  // --- (a) Descriptor census (raw): the literal ${VAR} ref strings, never resolved values -
  for (const name of CARRIERS) {
    const descPath = path.join(REPO_ROOT, "mcp", `${name}-server`, `${name}.service.json`);
    const raw = JSON.parse(await fs.readFile(descPath, "utf8"));
    check(
      raw.env?.COS_DEVICE_ID === "${COS_DEVICE_ID}",
      `${name}.service.json: env.COS_DEVICE_ID is the literal \${COS_DEVICE_ID} ref (got ${JSON.stringify(raw.env?.COS_DEVICE_ID)})`,
    );
    check(
      raw.env?.COS_DEVICE_ROLE === "${COS_DEVICE_ROLE}",
      `${name}.service.json: env.COS_DEVICE_ROLE is the literal \${COS_DEVICE_ROLE} ref (got ${JSON.stringify(raw.env?.COS_DEVICE_ROLE)})`,
    );
  }

  // --- (b) Census (resolved) + population: the fixed-set carrier pin + key presence ------
  // This section does NOT guard getManifest() itself — a broken manifest (an unresolved
  // ${VAR}, a bad role) is THIS gate's subject and fails loudly here, on purpose.
  const { getManifest } = await import(path.join(REPO_ROOT, "mcp", "service-manifest.mjs"));
  const manifest = getManifest();
  const carriers = manifest.filter((e) => e.env && Object.prototype.hasOwnProperty.call(e.env, "CRM_BASE_URL"));
  const carrierNames = carriers.map((e) => e.name).sort();
  const expectedNames = [...CARRIERS].sort();
  check(
    carrierNames.join(",") === expectedNames.join(","),
    `entries whose env carries CRM_BASE_URL are EXACTLY [${expectedNames.join(", ")}] (got [${carrierNames.join(", ")}]) — a 6th board-facing wrapper must extend this fixed list deliberately`,
  );
  for (const e of carriers) {
    check(Object.prototype.hasOwnProperty.call(e.env, "COS_DEVICE_ID"), `${e.name}'s resolved env carries the COS_DEVICE_ID key`);
    check(Object.prototype.hasOwnProperty.call(e.env, "COS_DEVICE_ROLE"), `${e.name}'s resolved env carries the COS_DEVICE_ROLE key`);
  }

  // --- (c) Spawned-wrapper header (AC 1 + 3): a REAL spawn, a REAL outbound header --------
  const boardEntry = manifest.find((e) => e.name === "board");
  check(!!boardEntry, "the manifest resolves a 'board' entry (needed for arm (c))");
  if (boardEntry) {
    let capturedHeaders;
    const stub = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      res.end("{}");
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;

    // The device pair comes ONLY from the manifest-resolved descriptor env; only the
    // target URL is overridden to aim at the stub instead of a real board.
    const env = { ...process.env };
    delete env.COS_DEVICE_ID;
    delete env.COS_DEVICE_ROLE;
    Object.assign(env, boardEntry.env, { CRM_BASE_URL: stubUrl });

    const child = spawn(process.execPath, [BOARD_SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const client = makeClient(child);
      await initialize(client);
      await client.request("tools/call", { name: "list_labels", arguments: {} });

      // Test-local expectation (mirrors mcp-kit's own slug transform, like device-mirrors.test.ts
      // mirror #3's fixture table) — not a fourth production copy.
      const expectedId = String(boardEntry.env.COS_DEVICE_ID).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
      check(
        capturedHeaders?.["x-device"] === expectedId,
        `a spawned board wrapper's request carries x-device: ${expectedId} (got ${JSON.stringify(capturedHeaders?.["x-device"])})`,
      );
      check(
        capturedHeaders?.["x-device-role"] === boardEntry.env.COS_DEVICE_ROLE,
        `a spawned board wrapper's request carries x-device-role: ${boardEntry.env.COS_DEVICE_ROLE} (got ${JSON.stringify(capturedHeaders?.["x-device-role"])})`,
      );
    } finally {
      child.kill();
      await new Promise((resolve) => stub.close(resolve));
    }
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} mcp-device-headers check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — the five board-facing descriptors carry ${COS_DEVICE_ID}/${COS_DEVICE_ROLE} refs, the resolved manifest's carrier set is exactly [board, body, calendar, fitness, nutrition] with both keys present, and a spawned board wrapper's outbound request actually carries x-device/x-device-role.",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
