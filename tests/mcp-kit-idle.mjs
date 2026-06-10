#!/usr/bin/env node
// mcp-kit-idle.mjs — regression test for the shared child-lifecycle contract in
// packages/mcp-kit/index.mjs `start()`. Guards the fix for the Cowork "board MCP not
// responding" bug: the idle-exit timer must be OFF BY DEFAULT (so a long-lived DIRECT
// stdio client — Cowork, run-by-hand, future clients — never has its server self-terminate
// while idle), while the supergateway bridge plists OPT IN via COS_MCP_IDLE_EXIT_MS to reap
// supergateway's leaked stateless children.
//
// Target: the BOARD server (mcp/board-server/server.mjs). It uses mcp-kit's start() and
// imports ONLY @modelcontextprotocol/sdk — no Agent SDK, no ANTHROPIC_API_KEY, and the
// idle/lifecycle paths run pre-tool, so no live board HTTP is needed.
//
// Assertions:
//   0. STATIC GUARD   — the start() source defaults idleMs to 0/disabled when the env is
//                       unset (catches a revert to the old `=== undefined ? 300000` default
//                       without waiting 5 minutes).
//   A. DEFAULT OFF    — spawn with COS_MCP_IDLE_EXIT_MS UNSET, initialize, stay idle past a
//                       multi-second window → the child is STILL ALIVE (no idle timer armed).
//   B. BACKSTOP #1    — then close the child's stdin → it exits code 0 within ~2s (a real
//                       client disconnect/quit is reaped without the idle timer).
//   C. OPT-IN REAPER  — spawn with COS_MCP_IDLE_EXIT_MS=1000, initialize, send nothing more →
//                       the child SELF-EXITS code 0 within ~4s (the bridge opt-in works).
//   D. IN-FLIGHT DISARM — with COS_MCP_IDLE_EXIT_MS=1000, keep sending requests closer
//                       together than the timeout → the child survives past a single window
//                       (the timer is disarmed while requests flow / are in flight).
//
// SKIPs gracefully (exit 0) if the board server's deps aren't installed (fresh checkout),
// mirroring api-vault.mjs.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER =
  process.env.BOARD_SERVER || path.join(HERE, "..", "mcp", "board-server", "server.mjs");
const KIT = path.join(HERE, "..", "packages", "mcp-kit", "index.mjs");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// newline-delimited JSON-RPC client over the child's stdio (same framing as api-vault.mjs).
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

// Spawn the board server with a controlled idle env. Returns the child + an exit tracker.
// crmUrl points the board's outbound API at a chosen upstream (default a dead port; case E
// uses a hanging server so a tool call stays in-flight long enough to be cancelled).
function spawnServer(idleEnv, crmUrl = "http://127.0.0.1:3999") {
  const env = { ...process.env, CRM_BASE_URL: crmUrl };
  if (idleEnv === null) delete env.COS_MCP_IDLE_EXIT_MS;
  else env.COS_MCP_IDLE_EXIT_MS = idleEnv;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  const tracker = { exitedCode: undefined, exitedAtMs: null, stderr: "" };
  const t0 = Date.now();
  child.on("exit", (code) => { tracker.exitedCode = code; tracker.exitedAtMs = Date.now() - t0; });
  child.stderr.on("data", (d) => (tracker.stderr += d.toString("utf8")));
  tracker.alive = () => tracker.exitedCode === undefined;
  return { child, tracker };
}

async function initialize(client) {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-kit-idle-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
}

async function main() {
  console.log(`mcp-kit-idle · server=${SERVER}`);

  // --- 0. STATIC GUARD on the source (fast; catches a revert to a positive default) -----
  // Behavioral, not form-specific: assert no dangerous "unset → positive default" pattern,
  // so a benign refactor of the safe `?? 0` form doesn't false-fail. The real behavior is
  // covered by the DEFAULT-OFF (A) and OPT-IN (C) cases below.
  const src = await fs.readFile(KIT, "utf8");
  const hasOldDefault = /===\s*undefined\s*\?\s*\d|\?\?\s*[1-9]\d*|\|\|\s*[1-9]\d*/.test(src);
  check(!hasOldDefault,
    "start() does not default idleMs to a positive value when COS_MCP_IDLE_EXIT_MS is unset (off-by-default preserved)");

  // --- boot a server to confirm deps are present; SKIP if not (fresh checkout) ----------
  {
    const probe = spawnServer(null);
    const early = await Promise.race([
      new Promise((r) => probe.child.on("exit", () => r("exit"))),
      sleep(2500).then(() => "up"),
    ]);
    if (early === "exit" && /Cannot find package|ERR_MODULE_NOT_FOUND/.test(probe.tracker.stderr)) {
      console.log("\nSKIP — board server deps not installed (cd mcp/board-server && npm install).");
      process.exit(0);
    }
    // Reuse this probe as the subject of A + B.
    const client = makeClient(probe.child);
    await initialize(client);

    // A. DEFAULT OFF — idle past a multi-second window with NO request → still alive.
    await sleep(3000);
    check(probe.tracker.alive(), "DEFAULT OFF: child with COS_MCP_IDLE_EXIT_MS unset is still alive after 3s idle");

    // B. BACKSTOP #1 — closing stdin (a real client disconnect) reaps it.
    probe.child.stdin.end();
    await sleep(2000);
    check(!probe.tracker.alive() && probe.tracker.exitedCode === 0,
      `BACKSTOP: closing stdin exits the child code 0 within ~2s of close (code=${probe.tracker.exitedCode}, at=${probe.tracker.exitedAtMs}ms incl. the 3s idle wait)`);
    if (probe.tracker.alive()) probe.child.kill();
  }

  // --- C. OPT-IN REAPER — a positive value makes an idle child self-exit ----------------
  {
    const s = spawnServer("1000");
    const client = makeClient(s.child);
    await initialize(client);
    await sleep(3500); // > 1000ms idle; generous margin for spawn/connect jitter
    check(!s.tracker.alive() && s.tracker.exitedCode === 0,
      `OPT-IN: COS_MCP_IDLE_EXIT_MS=1000 self-exits an idle child code 0 within ~3.5s (code=${s.tracker.exitedCode}, at=${s.tracker.exitedAtMs}ms)`);
    if (s.tracker.alive()) s.child.kill();
  }

  // --- D. IN-FLIGHT DISARM — steady traffic keeps the child alive past one window -------
  {
    const s = spawnServer("1000");
    const client = makeClient(s.child);
    await initialize(client);
    // Send a request every ~500ms for ~2.5s (each < the 1000ms timeout → timer keeps
    // disarming/re-arming). The child must survive the whole window despite idleMs=1000.
    for (let i = 0; i < 5; i++) {
      await client.request("tools/list", {});
      await sleep(500);
    }
    check(s.tracker.alive(),
      "DISARM: steady requests (<1s apart) keep the child alive past the 1s idle window");
    // And after traffic stops, it eventually self-exits (the reaper re-arms).
    await sleep(3000);
    check(!s.tracker.alive() && s.tracker.exitedCode === 0,
      `DISARM: after traffic stops the child self-exits code 0 (code=${s.tracker.exitedCode})`);
    if (s.tracker.alive()) s.child.kill();
  }

  // --- E. CANCELLED REQUEST DOES NOT LEAK — the regression guard for the inflight-Set fix.
  // A counter that only decrements on an outgoing response leaks forever on a CANCELLED
  // request (the SDK aborts it and sends NO response), so the timer never re-arms and the
  // child never idle-exits. To force a request to be genuinely IN-FLIGHT, point the board's
  // outbound API at a HANGING upstream, fire a tool call (it blocks on the upstream), then
  // send notifications/cancelled for it. The child must still self-exit (Set deletes the id
  // on cancel → re-arm). Pre-fix this hangs alive forever and the case FAILS.
  {
    const http = await import("node:http");
    const hang = http.createServer(() => { /* accept, never respond */ });
    await new Promise((r) => hang.listen(0, "127.0.0.1", r));
    const hangUrl = `http://127.0.0.1:${hang.address().port}`;
    const s = spawnServer("1000", hangUrl);
    const client = makeClient(s.child);
    await initialize(client);
    // Fire an in-flight tool call RAW (don't await — it blocks on the hanging upstream).
    const reqId = 987654;
    s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "tools/call", params: { name: "get_tree", arguments: {} } }) + "\n");
    await sleep(500); // let it register in-flight (timer disarmed)
    check(s.tracker.alive(), "CANCEL: child stays alive while a tool call is genuinely in-flight (timer disarmed)");
    // Cancel it → no response will ever be sent for reqId.
    client.notify("notifications/cancelled", { requestId: reqId, reason: "test" });
    await sleep(3500); // > 1000ms idle after the cancel re-arms the reaper
    check(!s.tracker.alive() && s.tracker.exitedCode === 0,
      `CANCEL: a cancelled in-flight request still lets the child idle-exit code 0 — no inflight leak (code=${s.tracker.exitedCode}, at=${s.tracker.exitedAtMs}ms)`);
    if (s.tracker.alive()) s.child.kill();
    hang.close();
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} mcp-kit idle-lifecycle check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — idle-exit is off by default (direct clients stable), stdin-close reaps, and the opt-in reaper + in-flight disarm work.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
