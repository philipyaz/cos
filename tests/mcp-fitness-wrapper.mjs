#!/usr/bin/env node
// mcp-fitness-wrapper.mjs — pins the fold of fitness's hand-rolled healthApi onto
// mcp-kit's shared makeBoardApi() (cos-ops#138). healthApi (mcp/fitness-server/server.mjs,
// born b2b7f5e 2026-07-12) was correct the day it was written and has silently diverged
// from the shared wrapper ever since: it renders `data.error` only (mcp-kit :164 renders
// `data.detail ?? data.error`, so the schema-guard 503's git-pull remediation never
// reaches the agent through fitness) and it never sends x-device/x-device-role (mcp-kit
// :141-144, live the moment cos-ops#137's wrapper descriptors land).
//
// Four arms:
//   Arm 1 (AC 3)  — spawn fitness against a stub board that returns the EXACT
//                   route-helpers.ts:83 SchemaAheadError body; assert the tool's isError
//                   text CONTAINS the `detail` remediation text, not just the bare slug.
//   Arm 2 (AC 4)  — same spawn, with COS_DEVICE_ID/COS_DEVICE_ROLE set; assert the stub
//                   actually RECEIVED x-device/x-device-role (device keys scrubbed from
//                   the inherited env in both arms, so a machine with cos-ops#137's loader
//                   default already exported doesn't blur arm 1's baseline).
//   Arm 3 (AC 6)  — tools/list returns EXACTLY the 20 fixed tool-name literals below,
//                   compared as SORTED SETS (tools/list renders TOOLS-array order; the
//                   literals here are source name:-declaration order — different
//                   orderings that happen to coincide today). Fixed literals, never
//                   derived from the server (ADR 0038). GREEN on main already — a forward
//                   pin, not one of the ADR-0014 reds below.
//   Arm 4 (ACs 1/2/5, source pins) — read server.mjs as text: no `async function
//                   healthApi`, no `fetch(`, no `res.status === 401`, `makeBoardApi(`
//                   present.
//
// Board-free, root-install-only: SKIPs gracefully (exit 0) if the fitness server's deps
// aren't installed (fresh checkout), mirroring [13b2]/[13b3]. Run UNCONDITIONALLY.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FITNESS_SERVER =
  process.env.FITNESS_SERVER || path.join(REPO_ROOT, "mcp", "fitness-server", "server.mjs");

// Fixed literal set, source name:-declaration order — deliberately never derived from the
// server (ADR 0038: a bug that emptied TOOLS would otherwise pass this gate vacuously).
const EXPECTED_TOOLS = [
  "push_health_data",
  "list_health_data",
  "get_health_summary",
  "delete_health_data",
  "get_health_trends",
  "get_daily_summary",
  "get_athlete_profile",
  "set_athlete_profile",
  "get_form_score",
  "get_correlations",
  "ingest_health_to_vault",
  "save_training_plan",
  "save_weekly_review",
  "save_pre_workout_brief",
  "save_correlation_report",
  "list_coaching_artifacts",
  "get_coaching_artifact",
  "delete_coaching_artifact",
  "push_plan_to_calendar",
  "set_plan_day_outcome",
];

// The exact route-helpers.ts:83 SchemaAheadError body shape, with a distinctive detail
// string so "the tool's error text contains it" is unambiguous.
const DETAIL_TEXT = "store on disk is schemaVersion 99, this build knows 12 — git pull and rebuild";
const SCHEMA_AHEAD_BODY = {
  error: "store-newer-than-code",
  detail: DETAIL_TEXT,
  disk: 99,
  code: 12,
  fix: "git pull",
};

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// newline-delimited JSON-RPC client over the child's stdio (same framing as
// api-vault.mjs / mcp-kit-idle.mjs / mcp-device-headers.mjs).
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

// Pull the flat text out of an MCP tool result's content array.
const resultText = (r) =>
  (r?.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");

async function initialize(client) {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-fitness-wrapper-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
}

// Spawn the fitness server against `stubUrl`, with device keys scrubbed from the
// inherited env and `extraEnv` layered on top (arm 2 adds COS_DEVICE_ID/ROLE here).
function spawnFitness(stubUrl, extraEnv = {}) {
  const env = { ...process.env, CRM_BASE_URL: stubUrl };
  delete env.COS_DEVICE_ID;
  delete env.COS_DEVICE_ROLE;
  Object.assign(env, extraEnv);
  return spawn(process.execPath, [FITNESS_SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
}

async function main() {
  console.log(`mcp-fitness-wrapper · server=${FITNESS_SERVER}`);

  // --- SKIP probe: root workspace deps must be installed ---------------------------------
  {
    const probe = spawn(process.execPath, [FITNESS_SERVER], {
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

  // --- stub board: every request gets the SchemaAheadError body, and every request's
  // headers are captured for arm 2's assertion ---------------------------------------------
  let capturedHeaders;
  const stub = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(SCHEMA_AHEAD_BODY));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  try {
    // --- Arm 1 (AC 3): the 503's `detail` remediation reaches the agent, not the bare slug -
    {
      const child = spawnFitness(stubUrl);
      try {
        const client = makeClient(child);
        await initialize(client);
        const result = await client.request("tools/call", { name: "list_health_data", arguments: {} });
        const t = resultText(result);
        check(result?.isError === true, "list_health_data against a 503 stub returns an isError result");
        check(
          t.includes(DETAIL_TEXT),
          `the isError text CONTAINS the schema-guard's detail remediation (got ${JSON.stringify(t)})`,
        );
      } finally {
        child.kill();
      }
    }

    // --- Arm 2 (AC 4): a spawned fitness server sends x-device/x-device-role ---------------
    {
      capturedHeaders = undefined;
      const child = spawnFitness(stubUrl, { COS_DEVICE_ID: "probe-device", COS_DEVICE_ROLE: "spoke" });
      try {
        const client = makeClient(child);
        await initialize(client);
        await client.request("tools/call", { name: "list_health_data", arguments: {} });
        check(
          capturedHeaders?.["x-device"] === "probe-device",
          `a spawned fitness wrapper's request carries x-device: probe-device (got ${JSON.stringify(capturedHeaders?.["x-device"])})`,
        );
        check(
          capturedHeaders?.["x-device-role"] === "spoke",
          `a spawned fitness wrapper's request carries x-device-role: spoke (got ${JSON.stringify(capturedHeaders?.["x-device-role"])})`,
        );
      } finally {
        child.kill();
      }
    }

    // --- Arm 3 (AC 6): tools/list is EXACTLY the 20 fixed names, compared as sorted sets ---
    // GREEN on main already — a forward pin, not one of the ADR-0014 reds above.
    {
      const child = spawnFitness(stubUrl);
      try {
        const client = makeClient(child);
        await initialize(client);
        const result = await client.request("tools/list", {});
        const names = (result?.tools || []).map((t) => t.name).sort();
        const expected = [...EXPECTED_TOOLS].sort();
        check(
          names.join(",") === expected.join(","),
          `tools/list returns exactly the 20 fixed tool names, compared as sorted sets (got ${names.length}: ${names.join(", ")})`,
        );
      } finally {
        child.kill();
      }
    }
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }

  // --- Arm 4 (ACs 1/2/5, source pins) -------------------------------------------------------
  const src = await fs.readFile(FITNESS_SERVER, "utf8");
  check(!/async function healthApi/.test(src), "no `async function healthApi` remains in server.mjs (AC 2)");
  check(!/fetch\(/.test(src), "no `fetch(` remains in server.mjs — the shared kit owns the HTTP path (AC 1)");
  check(!/res\.status === 401/.test(src), "no 401 branch remains in server.mjs (AC 5)");
  check(/makeBoardApi\(/.test(src), "server.mjs imports/calls makeBoardApi( (the fold landed)");

  if (failures) {
    console.error(`\nFAIL — ${failures} mcp-fitness-wrapper check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — fitness's board wrapper renders the 503 detail remediation, sends x-device/x-device-role, keeps its 20 tools, and its source shows the healthApi→makeBoardApi fold (no fetch(, no 401 branch).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
