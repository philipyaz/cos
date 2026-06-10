// vault-options.test.ts — the vault MCP's nesting / scoping safeguards must be present.
//
// The vault MCP (mcp/vault-server/server.mjs) is the ONE server that EMBEDS the Claude
// Agent SDK and spawns a headless Claude session per tool call. Because the server is
// itself bridged at vault:8005 in the repo's .mcp.json, a naïvely-configured inner
// session could re-mount THIS server and recurse into ingest/query — fanning out claude
// subprocesses. The whole point of baseOptions() is to make that impossible. This test
// pins the mandatory safeguards so a future refactor can't silently drop one.
//
// IDEAL: import the server's option-builder and assert on the live object. The current
// server does NOT export baseOptions/buildOptions, AND it boots on import (top-level
// `await start(...)`) while hard-importing @anthropic-ai/claude-agent-sdk (which may not
// be installed). Both make a real import unsafe here. So we assert on the SERVER SOURCE
// instead — a structural lint of the safeguards. If the build agent later exports
// `baseOptions` (see EXPECTED-EXPORTS at the bottom), tighten this to a real import.
//
// Run via the repo's unit harness: `node --test tests/unit/vault-options.test.ts`
// (and through tests/run.sh step [1]).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(HERE, "..", "..", "mcp", "vault-server", "server.mjs");
const SRC = readFileSync(SERVER_PATH, "utf8");

// Collapse all whitespace so the assertions are tolerant of formatting (line breaks,
// indentation) — we care that the safeguard is PRESENT, not how it is laid out.
const FLAT = SRC.replace(/\s+/g, " ");
const has = (re: RegExp) => re.test(FLAT);

test("vault server registers itself under the name \"vault\"", () => {
  // initialize → serverInfo.name must be "vault" (the registry name the .mcp.json + the
  // mcp__vault__* disallowedTools entries depend on).
  assert.ok(
    has(/name:\s*"vault"/),
    "expected `new Server({ name: \"vault\", ... })` in the server source",
  );
});

test("the inner agent mounts NO MCP servers (mcpServers:{} + strictMcpConfig:true)", () => {
  // The primary anti-recursion guard: an empty mcpServers map AND strictMcpConfig:true
  // (forbids reading any .mcp.json), so the inner session can never re-mount vault:8005.
  assert.ok(has(/mcpServers:\s*\{\s*\}/), "expected `mcpServers: {}` (empty — no inner MCP servers)");
  assert.ok(has(/strictMcpConfig:\s*true/), "expected `strictMcpConfig: true` (forbids reading .mcp.json)");
});

test("settingSources is pinned to [\"project\"] (loads only the vault-local config)", () => {
  // Set EXPLICITLY (the SDK default is version-ambiguous) so the inner session loads the
  // vault-local CLAUDE.md + skills, NOT the repo-root config with the board/guard wiring.
  assert.ok(
    has(/settingSources:\s*\[\s*"project"\s*\]/),
    "expected `settingSources: [\"project\"]`",
  );
});

test("the session runs fully non-interactive (bypassPermissions)", () => {
  // No human is on the other end of a permission prompt behind the MCP.
  assert.ok(
    has(/permissionMode:\s*"bypassPermissions"/),
    "expected `permissionMode: \"bypassPermissions\"`",
  );
  assert.ok(
    has(/allowDangerouslySkipPermissions:\s*true/),
    "expected `allowDangerouslySkipPermissions: true`",
  );
});

test("cwd is anchored to COS_VAULT_DIR (the scoped vault, not the repo root)", () => {
  // cwd = the scoped vault makes settingSources:\"project\" resolve to the vault's
  // .claude/ and anchors Read/Write/Glob/Grep there.
  assert.ok(has(/cwd:\s*COS_VAULT_DIR/), "expected `cwd: COS_VAULT_DIR` in baseOptions");
});

test("the re-entrant vault tools are hard-denied (belt-and-braces)", () => {
  // Even if a server were somehow mounted, the two re-entrant tools must be disallowed so
  // the session can never call back into ingest/query and recurse.
  assert.ok(
    has(/disallowedTools:\s*\[[^\]]*"mcp__vault__ingest"[^\]]*\]/),
    "expected disallowedTools to include \"mcp__vault__ingest\"",
  );
  assert.ok(
    has(/disallowedTools:\s*\[[^\]]*"mcp__vault__query"[^\]]*\]/),
    "expected disallowedTools to include \"mcp__vault__query\"",
  );
});

test("web tools are disallowed (KNOWLEDGE-ONLY, vault-local)", () => {
  assert.ok(
    has(/disallowedTools:\s*\[[^\]]*"WebFetch"[^\]]*"WebSearch"[^\]]*\]/) ||
      (has(/"WebFetch"/) && has(/"WebSearch"/)),
    "expected WebFetch + WebSearch to be disallowed",
  );
});

test("the query path is READ-ONLY — it disallows Write and Edit", () => {
  // query() layers a stricter disallow list on top of baseOptions. The single place that
  // names BOTH Write and Edit in a disallowedTools array is the read-only query handler.
  // Match a disallowedTools:[ ... ] block that contains both "Write" and "Edit".
  const queryDisallow = /disallowedTools:\s*\[[^\]]*"Write"[^\]]*"Edit"[^\]]*\]/;
  const editFirst = /disallowedTools:\s*\[[^\]]*"Edit"[^\]]*"Write"[^\]]*\]/;
  assert.ok(
    has(queryDisallow) || has(editFirst),
    "expected the query handler to disallow both Write and Edit (read-only)",
  );
  // And query's allowedTools must NOT grant Write/Edit (only Skill/Read/Glob/Grep).
  assert.ok(
    has(/allowedTools:\s*\[\s*"Skill",\s*"Read",\s*"Glob",\s*"Grep"\s*\]/),
    "expected the query handler's allowedTools to be exactly [Skill, Read, Glob, Grep] (no Write/Edit)",
  );
});

test("the arbitrary-file-read guard rejects out-of-vault paths BEFORE the agent", () => {
  // ingest.files must be validated (inside COS_VAULT_DIR or COS_VAULT_ATTACH_DIRS) before
  // any agent session is spawned. Assert the guard function exists and that ingest calls
  // it ahead of building the prompt / acquiring a session.
  assert.ok(has(/function validateFiles\(/), "expected a validateFiles() guard function");
  const ingestIdx = SRC.indexOf("async function handleIngest");
  assert.ok(ingestIdx >= 0, "expected a handleIngest handler");
  const ingestBody = SRC.slice(ingestIdx, SRC.indexOf("async function handleQuery"));
  const validateIdx = ingestBody.indexOf("validateFiles(");
  const acquireIdx = ingestBody.indexOf("sessions.acquire");
  const runIdx = ingestBody.indexOf("run(");
  assert.ok(validateIdx >= 0, "expected handleIngest to call validateFiles()");
  assert.ok(
    acquireIdx === -1 || validateIdx < acquireIdx,
    "validateFiles() must run BEFORE the session semaphore is acquired",
  );
  assert.ok(
    runIdx === -1 || validateIdx < runIdx,
    "validateFiles() must run BEFORE the agent run() is invoked",
  );
});

// ── EXPECTED-EXPORTS (reconcile with the build agent) ────────────────────────────────
// This file asserts on SOURCE because server.mjs currently (a) does not export its
// option-builder and (b) boots on import. If the build agent makes the server testable
// by exporting `baseOptions` (and ideally guarding the top-level `start()` behind an
// `if (import.meta.url === pathToFileURL(process.argv[1]).href)` main-guard so importing
// it is side-effect-free), replace the source-asserts above with a real import, e.g.:
//
//   import { baseOptions } from "../../mcp/vault-server/server.mjs";
//   const o = baseOptions();
//   assert.deepEqual(o.mcpServers, {});
//   assert.equal(o.strictMcpConfig, true);
//   assert.deepEqual(o.settingSources, ["project"]);
//   assert.equal(o.permissionMode, "bypassPermissions");
//   assert.ok(o.disallowedTools.includes("mcp__vault__ingest"));
//
// Until then, the source-assertion is the safe, dependency-free form.
