#!/usr/bin/env node
// api-vault.mjs — stdio JSON-RPC contract test for the vault MCP server
// (mcp/vault-server/server.mjs — registry name "vault").
//
// Plain Node (ESM), zero deps. UNLIKE the board's HTTP api-* tests, the vault server is a stdio MCP
// that EMBEDS the Claude Agent SDK. We assert the parts that never reach the agent — and that now
// includes the ASYNC ingest contract, because `ingest` only ENQUEUES a job (a detached runner does the
// agent work), so the whole submit→status→cancel surface short-circuits BEFORE any query() call. So
// the test needs NO ANTHROPIC_API_KEY and makes NO LLM calls:
//   • initialize                     → serverInfo.name === "vault"
//   • tools/list                     → EXACTLY four tools (ingest, ingest_status, ingest_cancel,
//                                      query) with the expected required fields
//   • tools/call ingest {content:""} → isError ("provide content or files" validation), NOT a crash
//   • tools/call ingest {files:["/etc/passwd"]} → isError NAMING the path (arbitrary-file-read guard)
//   • tools/call ingest {content:"…"} → NON-error, returns a job_id; an identical re-submit DEDUPS to
//                                      the same id; ingest_status reports `working`; an unknown
//                                      job_id is an isError; ingest_cancel acks — all WITHOUT the agent
//
// We boot the server with COS_VAULT_DIR set to a THROWAWAY temp dir (so requireVaultDir passes and the
// job store lands in temp/.cos/) and WITHOUT an ANTHROPIC_API_KEY — none of the assertions reach the
// SDK (the runner, not the server, runs the agent), so no key is needed and nothing is spent.
//
// PREREQUISITE: the server's deps must be installed (@anthropic-ai/claude-agent-sdk +
// @modelcontextprotocol/sdk) — the server hard-imports the Agent SDK at module top, so
// it cannot boot without it. If the deps are missing (fresh checkout, `npm install` not
// yet run), this test SKIPs gracefully (exit 0) rather than failing — mirroring the
// Node>=22 / uv / board-up SKIP gates in run.sh. Install with:
//   cd mcp/vault-server && npm install   # (or `npm install` at the repo root workspace)
//
//   node tests/api-vault.mjs
//
// Env: VAULT_SERVER (path to server.mjs; default mcp/vault-server/server.mjs).
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER =
  process.env.VAULT_SERVER || path.join(HERE, "..", "mcp", "vault-server", "server.mjs");

// --- tiny check harness ------------------------------------------------------
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- stdio JSON-RPC client ---------------------------------------------------
// Speaks newline-delimited JSON-RPC over the child's stdin/stdout. The MCP SDK's
// StdioServerTransport frames messages as one JSON object per line on stdout; the
// server's ready banner + any logs go to stderr, so stdout is a clean JSON-RPC channel.
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON line on stdout
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(payload);
      // Per-request guard so a hung server can't wedge the suite.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timed out waiting for response to ${method}`));
        }
      }, 15000);
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

async function main() {
  console.log(`api-vault · server=${SERVER}`);

  // Throwaway vault dir so requireVaultDir() passes and the validation paths are reached.
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "cos-vault-test-"));

  // Boot the server WITHOUT an ANTHROPIC_API_KEY — we only touch pre-agent paths.
  // Strip any inherited key so a stray env can't let an assertion silently spend tokens.
  const env = { ...process.env, COS_VAULT_DIR: vaultDir };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  // If the server can't even boot (its deps aren't installed — it hard-imports the
  // Agent SDK at module top), SKIP gracefully (exit 0) instead of failing the suite.
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const earlyExit = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r(null), 2500)),
  ]);
  if (earlyExit !== null) {
    if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(stderr)) {
      console.log(
        "\nSKIP — vault server deps not installed (cd mcp/vault-server && npm install).",
      );
      await fs.rm(vaultDir, { recursive: true, force: true });
      process.exit(0);
    }
    console.error(`\nERROR — vault server exited early (code ${earlyExit}):\n${stderr}`);
    await fs.rm(vaultDir, { recursive: true, force: true });
    process.exit(1);
  }

  const client = makeClient(child);

  try {
    // ----------------------------------------------------------------------
    // initialize → serverInfo.name === "vault"
    // ----------------------------------------------------------------------
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "api-vault-test", version: "1.0.0" },
    });
    check(init?.serverInfo?.name === "vault", `initialize → serverInfo.name === "vault" (got '${init?.serverInfo?.name}')`);
    // The handshake completes with the standard `notifications/initialized`.
    client.notify("notifications/initialized", {});

    // ----------------------------------------------------------------------
    // tools/list → EXACTLY ingest + query, with the expected required fields
    // ----------------------------------------------------------------------
    const list = await client.request("tools/list", {});
    const tools = list?.tools || [];
    const names = tools.map((t) => t.name).sort();
    check(
      tools.length === 4 && names.join(",") === "ingest,ingest_cancel,ingest_status,query",
      `tools/list returns EXACTLY [ingest, ingest_status, ingest_cancel, query] (got [${tools.map((t) => t.name).join(", ")}])`,
    );
    const ingestTool = tools.find((t) => t.name === "ingest");
    const queryTool = tools.find((t) => t.name === "query");
    const statusTool = tools.find((t) => t.name === "ingest_status");
    const cancelTool = tools.find((t) => t.name === "ingest_cancel");
    check(
      statusTool?.inputSchema?.required?.includes("job_id") &&
        cancelTool?.inputSchema?.required?.includes("job_id"),
      "ingest_status + ingest_cancel each declare required: ['job_id']",
    );
    check(
      Array.isArray(ingestTool?.inputSchema?.required) &&
        ingestTool.inputSchema.required.includes("content"),
      "ingest declares required: ['content']",
    );
    check(
      !!ingestTool?.inputSchema?.properties?.files &&
        !!ingestTool?.inputSchema?.properties?.domain &&
        !!ingestTool?.inputSchema?.properties?.cases,
      "ingest exposes the optional files / domain / cases properties",
    );
    check(
      Array.isArray(queryTool?.inputSchema?.required) &&
        queryTool.inputSchema.required.includes("question"),
      "query declares required: ['question']",
    );

    // ----------------------------------------------------------------------
    // tools/call ingest { content:"" } (no files) → isError validation result
    //   — this short-circuits in handleIngest BEFORE the agent is invoked, so no
    //   ANTHROPIC_API_KEY / LLM call is needed.
    // ----------------------------------------------------------------------
    const emptyIngest = await client.request("tools/call", {
      name: "ingest",
      arguments: { content: "" },
    });
    check(emptyIngest?.isError === true, "ingest { content:'' } returns an isError result (validation, not a crash)");
    check(
      /provide content or files/i.test(resultText(emptyIngest)),
      `the empty-ingest error explains the validation ("${resultText(emptyIngest)}")`,
    );

    // ----------------------------------------------------------------------
    // tools/call ingest { content:"x", files:["/etc/passwd"] } → isError naming the
    //   path (the arbitrary-file-read guard). validateFiles runs BEFORE the agent, so
    //   no LLM call is made. /etc/passwd is outside the throwaway vault and not in
    //   COS_VAULT_ATTACH_DIRS (we never set it), so it must be refused.
    // ----------------------------------------------------------------------
    const badFile = await client.request("tools/call", {
      name: "ingest",
      arguments: { content: "some inline material", files: ["/etc/passwd"] },
    });
    check(badFile?.isError === true, "ingest { files:['/etc/passwd'] } returns an isError result (the read guard)");
    const guardText = resultText(badFile);
    check(
      /\/etc\/passwd/.test(guardText),
      `the read-guard error NAMES the offending path ("${guardText}")`,
    );
    check(
      /outside the vault|refusing to read/i.test(guardText),
      "the read-guard error explains it is outside the vault / allowlist",
    );

    // ----------------------------------------------------------------------
    // ASYNC CONTRACT: a VALID ingest ENQUEUES a job and returns a job_id — NO agent runs in
    //   this process (the detached runner does), so this still needs no key and spends nothing.
    //   Then: dedup (identical re-submit → same id), status, unknown-id error, and cancel.
    // ----------------------------------------------------------------------
    const submit = await client.request("tools/call", {
      name: "ingest",
      arguments: { content: "api-vault async contract note", domain: "life" },
    });
    check(submit?.isError !== true, "a valid ingest returns a NON-error result (it enqueued a job)");
    const jobId = submit?.structuredContent?.job_id;
    check(
      typeof jobId === "string" && /^J-/.test(jobId),
      `ingest returns a job_id in structuredContent ("${jobId}")`,
    );
    check(submit?.structuredContent?.status === "working", "the new job's status is 'working'");

    const resubmit = await client.request("tools/call", {
      name: "ingest",
      arguments: { content: "api-vault async contract note", domain: "life" },
    });
    check(
      resubmit?.structuredContent?.job_id === jobId && resubmit?.structuredContent?.dedup === true,
      "an identical re-submit dedups to the SAME job_id (anti-fan-out)",
    );

    const status = await client.request("tools/call", {
      name: "ingest_status",
      arguments: { job_id: jobId },
    });
    check(
      status?.isError !== true && status?.structuredContent?.status === "working",
      "ingest_status returns the job lifecycle (working)",
    );

    const missing = await client.request("tools/call", {
      name: "ingest_status",
      arguments: { job_id: "J-doesnotexist000" },
    });
    check(
      missing?.isError === true && /unknown or expired/i.test(resultText(missing)),
      "ingest_status on an unknown job_id is an isError",
    );

    const cancel = await client.request("tools/call", {
      name: "ingest_cancel",
      arguments: { job_id: jobId },
    });
    check(cancel?.isError !== true, "ingest_cancel acks an in-flight job (cooperative)");

    // ----------------------------------------------------------------------
    // RESULT-CAP HONESTY: an oversized completed result is truncated AND the
    // truncation is SURFACED to the caller (structuredContent.result_truncated),
    // so a clipped receipt is never reported as the whole summary. The runner
    // isn't running here, so we seed a completed job straight into the shared
    // store (jobs.mjs has no import side effects), then poll through the server.
    // ----------------------------------------------------------------------
    const { makeJobStore } = await import("../mcp/vault-server/jobs.mjs");
    const seedStore = makeJobStore(path.join(vaultDir, ".cos", "jobs.json"));
    const seeded = await seedStore.enqueue({ content: "cap-surfacing probe", domain: "work" });
    await seedStore.setStatus(seeded.job.id, "completed", { result: "R".repeat(20000) });
    const capStatus = await client.request("tools/call", {
      name: "ingest_status",
      arguments: { job_id: seeded.job.id },
    });
    const capSC = capStatus?.structuredContent || {};
    check(capSC.status === "completed", "seeded job reports completed");
    check(
      typeof capSC.result === "string" && capSC.result.length === 16000,
      `an oversized result is capped to 16000 chars (got ${capSC.result?.length})`,
    );
    check(
      capSC.result_truncated === true,
      "ingest_status SURFACES result_truncated so the caller knows the receipt was clipped",
    );

    // Sanity: the server is still alive (the validation + async paths can't crash-loop it).
    const listAgain = await client.request("tools/list", {});
    check((listAgain?.tools || []).length === 4, "the server is still responsive after the calls");
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(vaultDir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} vault MCP check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — vault MCP holds (initialize name, 4-tool list, ingest empty + read-guard validation, async enqueue + dedup + ingest_status + ingest_cancel; no LLM call, no key).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
