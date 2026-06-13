// vault-options.test.ts — the vault MCP's nesting/scoping safeguards + async tool surface.
//
// The vault MCP embeds the Claude Agent SDK and spawns a headless session per tool call. Because the
// server is itself bridged at vault:8005 in the repo's .mcp.json, a naïvely-configured inner session
// could re-mount THIS server and recurse into ingest/query — fanning out claude subprocesses. The
// safeguards that make that impossible now live in agent.mjs (the shared run path, imported by both
// server.mjs and the jobs-runner); the MCP wiring + the async tool surface live in server.mjs. This
// test pins both as a STRUCTURAL lint of the source (a real import is unsafe: agent.mjs hard-imports
// the Agent SDK, which may be absent in CI). If agent.mjs later exports baseOptions, tighten the agent
// assertions to a real import.
//
// Run via the repo's unit harness: `node --test tests/unit/vault-options.test.ts` (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(HERE, "..", "..", "mcp", "vault-server");
const AGT = readFileSync(path.join(VAULT, "agent.mjs"), "utf8");
const SRV = readFileSync(path.join(VAULT, "server.mjs"), "utf8");
// Collapse whitespace so assertions tolerate formatting — we care the safeguard is PRESENT.
const flat = (s: string) => s.replace(/\s+/g, " ");
const FAGT = flat(AGT);
const FSRV = flat(SRV);
const has = (flatSrc: string, re: RegExp) => re.test(flatSrc);

// ── agent.mjs — the scoping / nesting safeguards (the anti-recursion firewall) ──────
test("[agent] inner agent mounts NO MCP servers (mcpServers:{} + strictMcpConfig:true)", () => {
  assert.ok(has(FAGT, /mcpServers:\s*\{\s*\}/), "expected `mcpServers: {}` in agent.mjs baseOptions");
  assert.ok(has(FAGT, /strictMcpConfig:\s*true/), "expected `strictMcpConfig: true`");
});

test("[agent] settingSources is pinned to [\"project\"]", () => {
  assert.ok(has(FAGT, /settingSources:\s*\[\s*"project"\s*\]/), "expected `settingSources: [\"project\"]`");
});

test("[agent] the session runs fully non-interactive (bypassPermissions)", () => {
  assert.ok(has(FAGT, /permissionMode:\s*"bypassPermissions"/), "expected `permissionMode: \"bypassPermissions\"`");
  assert.ok(has(FAGT, /allowDangerouslySkipPermissions:\s*true/), "expected `allowDangerouslySkipPermissions: true`");
});

test("[agent] cwd is anchored to COS_VAULT_DIR (the scoped vault)", () => {
  assert.ok(has(FAGT, /cwd:\s*COS_VAULT_DIR/), "expected `cwd: COS_VAULT_DIR` in baseOptions");
});

test("[agent] the re-entrant vault tools + web tools are hard-denied", () => {
  assert.ok(has(FAGT, /disallowedTools:\s*\[[^\]]*"mcp__vault__ingest"[^\]]*\]/), "deny mcp__vault__ingest");
  assert.ok(has(FAGT, /disallowedTools:\s*\[[^\]]*"mcp__vault__query"[^\]]*\]/), "deny mcp__vault__query");
  assert.ok(has(FAGT, /"WebFetch"/) && has(FAGT, /"WebSearch"/), "deny WebFetch + WebSearch");
});

test("[agent] the query path is READ-ONLY (disallows Write+Edit; allows only Skill/Read/Glob/Grep)", () => {
  const q = /disallowedTools:\s*\[[^\]]*"Write"[^\]]*"Edit"[^\]]*\]/;
  assert.ok(has(FAGT, q), "expected the query session to disallow Write and Edit");
  assert.ok(
    has(FAGT, /allowedTools:\s*\[\s*"Skill",\s*"Read",\s*"Glob",\s*"Grep"\s*\]/),
    "expected the query session's allowedTools to be exactly [Skill, Read, Glob, Grep]",
  );
});

test("[agent] per-tool models: query→Haiku, ingest→Sonnet (COS_VAULT_MODEL overrides both)", () => {
  assert.ok(has(FAGT, /COS_VAULT_QUERY_MODEL\s*=[^;]*"claude-haiku-4-5"/), "query defaults to Haiku");
  assert.ok(has(FAGT, /COS_VAULT_INGEST_MODEL\s*=[^;]*"claude-sonnet-4-6"/), "ingest defaults to Sonnet");
  assert.ok(
    has(FAGT, /COS_VAULT_INGEST_MODEL\s*=\s*process\.env\.COS_VAULT_MODEL\s*\|\|/),
    "COS_VAULT_MODEL stays a back-compat override",
  );
});

test("[agent] per-tool session timeouts: ingest 600000, query 90000", () => {
  assert.ok(has(FAGT, /COS_VAULT_INGEST_TIMEOUT_MS\s*=[^;]*600000/), "ingest timeout 600000");
  assert.ok(has(FAGT, /COS_VAULT_QUERY_TIMEOUT_MS\s*=[^;]*90000/), "query timeout 90000");
});

test("[agent] the caller's cancellation is wired into the agent abort", () => {
  assert.ok(has(FAGT, /clientSignal/), "run() takes a clientSignal");
  assert.ok(has(FAGT, /addEventListener\(\s*"abort"\s*,/), "clientSignal abort aborts the session");
});

test("[agent] the arbitrary-file-read guard (validateFiles) is defined here", () => {
  assert.ok(has(FAGT, /export function validateFiles\(/), "expected an exported validateFiles() guard");
});

// ── server.mjs — registry name, async tool surface, dedup-before-dispatch ───────────
test("[server] registers itself under the name \"vault\"", () => {
  assert.ok(has(FSRV, /name:\s*"vault"/), "expected `new Server({ name: \"vault\", ... })`");
});

test("[server] exposes exactly the four tools ingest / ingest_status / ingest_cancel / query", () => {
  for (const name of ["ingest", "ingest_status", "ingest_cancel", "query"]) {
    assert.ok(has(FSRV, new RegExp(`name:\\s*"${name}"`)), `expected a tool named "${name}"`);
  }
  // the TOOLS array lists all four
  assert.ok(
    has(FSRV, /TOOLS\s*=\s*\[\s*INGEST_TOOL,\s*INGEST_STATUS_TOOL,\s*INGEST_CANCEL_TOOL,\s*QUERY_TOOL\s*\]/),
    "expected TOOLS = [INGEST_TOOL, INGEST_STATUS_TOOL, INGEST_CANCEL_TOOL, QUERY_TOOL]",
  );
});

test("[server] ingest is ASYNC: it enqueues a job (content-hash dedup), not an awaited agent run", () => {
  assert.ok(has(FSRV, /jobs\.enqueue\(/), "ingest must enqueue a job rather than run the agent inline");
  // server.mjs must NOT run an ingest session itself (the detached runner does) — only query is sync.
  assert.ok(!has(FSRV, /runIngestSession/), "server.mjs must not run ingest sessions (the runner does)");
  assert.ok(has(FSRV, /runQuerySession/), "query stays synchronous via runQuerySession");
});

test("[server] the file-read guard runs BEFORE the job is enqueued", () => {
  const i = SRV.indexOf("async function handleIngest");
  const end = SRV.indexOf("async function handleIngestStatus");
  assert.ok(i >= 0 && end > i, "expected a handleIngest handler");
  const body = SRV.slice(i, end);
  const validateIdx = body.indexOf("validateFiles(");
  const enqueueIdx = body.indexOf("jobs.enqueue(");
  assert.ok(validateIdx >= 0, "handleIngest must call validateFiles()");
  assert.ok(enqueueIdx >= 0, "handleIngest must call jobs.enqueue()");
  assert.ok(validateIdx < enqueueIdx, "validateFiles() must run BEFORE jobs.enqueue()");
});

test("[server] the CallTool dispatcher reads extra.signal and wires the Tasks-extension seam", () => {
  assert.ok(has(FSRV, /async\s*\(\s*request\s*,\s*extra\s*\)/), "handler takes (request, extra)");
  assert.ok(has(FSRV, /extra\?\.signal/), "reads extra?.signal for the synchronous query cancel path");
  assert.ok(has(FSRV, /function tasksCapable\(/), "tasksCapable() seam for the future Tasks-extension swap");
});
