#!/usr/bin/env node
// api-vault.mjs — stdio JSON-RPC contract test for the vault MCP server
// (mcp/vault-server/server.mjs — registry name "vault").
//
// Plain Node (ESM), zero deps. UNLIKE the board's HTTP api-* tests, the vault server
// is a stdio MCP that EMBEDS the Claude Agent SDK and spawns a headless Claude session
// per tool call. We deliberately assert ONLY the pre-agent contract — the paths that
// short-circuit BEFORE query() is ever called — so the test needs NO ANTHROPIC_API_KEY
// and makes NO LLM calls:
//   • initialize                     → serverInfo.name === "vault"
//   • tools/list                     → EXACTLY two tools (ingest, query) with the
//                                      expected required fields (ingest→content,
//                                      query→question)
//   • tools/call ingest {content:""} → isError result (the "provide content or files"
//                                      validation), NOT a crash
//   • tools/call ingest {files:["/etc/passwd"]} → isError result NAMING the path
//                                      (the arbitrary-file-read guard), WITHOUT
//                                      invoking the agent
//
// We boot the server with COS_VAULT_DIR set to a THROWAWAY temp dir (so requireVaultDir
// passes and the validation paths are reached) and WITHOUT an ANTHROPIC_API_KEY — the
// four assertions above never reach the SDK, so no key is needed and nothing is spent.
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
      tools.length === 2 && names.join(",") === "ingest,query",
      `tools/list returns EXACTLY [ingest, query] (got [${tools.map((t) => t.name).join(", ")}])`,
    );
    const ingestTool = tools.find((t) => t.name === "ingest");
    const queryTool = tools.find((t) => t.name === "query");
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

    // Sanity: the server is still alive (the validation paths can't crash-loop it).
    const listAgain = await client.request("tools/list", {});
    check((listAgain?.tools || []).length === 2, "the server is still responsive after the validation calls");
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
    "\nPASS — vault MCP holds (initialize name, exact tool list, ingest empty + read-guard validation; no LLM call, no key).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
