#!/usr/bin/env node
// MCP server (registry name "vault") for the Cos DOMAIN-SPLIT KNOWLEDGE VAULT.
//
// UNLIKE the sibling stdio servers (board / calendar / guard), which are thin `fetch`
// wrappers over an HTTP route and make NO LLM calls, this server EMBEDS the Claude Agent
// SDK (`@anthropic-ai/claude-agent-sdk`). Each tool call spawns a HEADLESS, scoped Claude
// Code session (`query({prompt, options})`) whose cwd is the vault root and whose only
// reach is the vault filesystem + the two `second-brain-*` skills. The session synthesizes
// the wiki (ingest) or reads it to answer a question (query). It is KNOWLEDGE-ONLY: it has
// NO board / calendar / guard tools and MUST NOT create or move board cases — any board case
// id it is handed is recorded by reference (a read-only `cases:` / **Board:** note) only.
//
// NESTING SAFEGUARDS (this is the whole reason `baseOptions` is so explicit). This MCP is
// itself bridged at vault:8005 inside the repo's `.mcp.json`. If the inner session re-loaded
// that config it would re-mount THIS server and could recurse into `ingest`/`query` forever,
// fanning out claude subprocesses. We prevent that four ways, all set deliberately:
//   • mcpServers:{} + strictMcpConfig:true  → the inner agent loads NO MCP servers and is
//       forbidden from reading any .mcp.json (so it never re-mounts vault:8005 / recurses).
//   • disallowedTools lists mcp__vault__ingest / mcp__vault__query  → belt-and-braces: even
//       if a server somehow mounted, the two re-entrant tools are hard-denied.
//   • settingSources:["project"]  → set EXPLICITLY (the SDK default is version-ambiguous).
//       The inner session loads ONLY the vault-local CLAUDE.md + skills under cwd's .claude/,
//       NOT the repo-root config (which carries the full board/guard MCP wiring).
//   • cwd = COS_VAULT_DIR  → the scoped vault, NOT the launchd repo-root WorkingDirectory, so
//       "project" resolves to the vault, and Read/Write/Glob/Grep are anchored there.
// bypassPermissions + allowDangerouslySkipPermissions make the session fully non-interactive
// behind the MCP (no human is on the other end of a permission prompt).
//
// AUTH: the embedded SDK calls the Anthropic API, so ANTHROPIC_API_KEY MUST be present in
// this process's environment (inherited from the launchd plist / supergateway shell). Without
// it the spawned session fails and the tool returns a clean err() (never an unhandled crash).
//
// COST / LATENCY: each tool call is a full agent session — it takes SECONDS TO MINUTES and
// consumes tokens (single model COS_VAULT_MODEL=claude-sonnet-4-6). A tiny in-process semaphore caps how many
// sessions run at once so concurrent tool calls don't fan out into N claude subprocesses.
// Every failure mode — thrown error, abort/timeout, SDK spawn failure — is caught and turned
// into an err() result, so a bad input can never crash-loop the KeepAlive'd process.
//
// Runs over stdio; supergateway fronts it for the HTTP bridge on 127.0.0.1:8005/mcp.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Shared first-party MCP helpers (result shapers, arg trimmer, transport boot) — imported by
// RELATIVE path so launchd's direct `node .../server.mjs` resolves it with zero dependence on a
// workspace install. The Agent SDK is NOT imported from mcp-kit (the kit imports nothing from
// any SDK); we import `query` straight from the Agent SDK package here.
import { err, text, str, start } from "../../packages/mcp-kit/index.mjs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";

// ── Config (read once at boot) ─────────────────────────────────────────────────
// COS_VAULT_DIR is REQUIRED — the absolute vault root. If it is missing, the tools all
// return a clear err() (we do NOT throw at boot, so the process still starts and KeepAlive
// stays calm; the operator sees the error on the first tool call).
const COS_VAULT_DIR = process.env.COS_VAULT_DIR || "";
const COS_VAULT_MODEL = process.env.COS_VAULT_MODEL || "claude-sonnet-4-6";
const COS_VAULT_MAX_TURNS = Number(process.env.COS_VAULT_MAX_TURNS) || 30;
const COS_VAULT_TIMEOUT_MS = Number(process.env.COS_VAULT_TIMEOUT_MS) || 180000;
// Optional colon-separated allowlist of dirs OUTSIDE the vault from which file attachments
// may be read. An attachment path is accepted only if it lives inside the vault OR inside one
// of these dirs — the arbitrary-file-read guard (see validateFiles).
const COS_VAULT_ATTACH_DIRS = (process.env.COS_VAULT_ATTACH_DIRS || "")
  .split(":")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(d));

// How many embedded agent sessions may run at once (each is a claude subprocess). Concurrent
// tool calls serialize through this semaphore so we never fan out into N subprocesses.
const COS_VAULT_CONCURRENCY = Number(process.env.COS_VAULT_CONCURRENCY) || 2;

// ── Tiny in-process semaphore ──────────────────────────────────────────────────
// FIFO permit pool of size COS_VAULT_CONCURRENCY. acquire() resolves when a permit is free;
// release() hands the permit to the next waiter (or returns it to the pool).
function makeSemaphore(limit) {
  let active = 0;
  const waiters = [];
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };
  const acquire = () =>
    new Promise((resolve) => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  return { acquire, release };
}
const sessions = makeSemaphore(COS_VAULT_CONCURRENCY);

// ── Tool definitions ───────────────────────────────────────────────────────────

const DOMAIN_KNOWLEDGE_NOTE =
  "KNOWLEDGE ONLY — never writes the board. Each call runs a headless Claude Code session " +
  "scoped to the vault; it takes seconds to minutes.";

const INGEST_TOOL = {
  name: "ingest",
  description:
    "Ingest knowledge into the domain-split vault wiki (work/life). " +
    DOMAIN_KNOWLEDGE_NOTE +
    " Provide inline `content` (a thought / email / transcript / recap) and/or `files` " +
    "(absolute on-device paths read as sources). `domain` ('work'|'life'|'auto', default " +
    "'auto') hints classification. `cases` are board case ids recorded BY REFERENCE only — " +
    "the vault never creates or moves a case. The session classifies each input's domain, " +
    "re-synthesizes the affected source/entity/concept pages in that wiki, and updates the " +
    "domain index.md / log.md. Returns a JSON ingest summary.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "Inline material to ingest — a thought, email body, transcript, or recap. May be " +
          "an empty string if `files` are supplied instead.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Absolute on-device paths to read as SOURCES. Each must be inside the vault root or " +
          "inside an allowed COS_VAULT_ATTACH_DIRS dir; any path outside the allowlist rejects " +
          "the whole call. PDFs/images are read natively.",
      },
      domain: {
        type: "string",
        enum: ["work", "life", "auto"],
        description:
          "Domain hint. 'auto' (default) lets the session classify each input itself.",
      },
      cases: {
        type: "array",
        items: { type: "string" },
        description:
          "OPTIONAL board case ids (e.g. 'CASE-1') to record BY REFERENCE only. The vault " +
          "NEVER writes the board; these are stored as a read-only `cases:` / **Board:** note.",
      },
    },
    required: ["content"],
  },
};

const QUERY_TOOL = {
  name: "query",
  description:
    "Answer a question against the domain-split vault wiki. " +
    DOMAIN_KNOWLEDGE_NOTE +
    " The session reads the matching domain index.md(s), follows [[wikilinks]], and answers " +
    "with [[wikilink]] citations. KNOWLEDGE ONLY — no board access; purely-open-work questions " +
    "(open to-dos / what's-in-flight) are declined with a board pointer. `domain` " +
    "('work'|'life'|'both'|'auto', default 'auto') scopes which wiki(s) are read. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to answer against the vault wiki.",
      },
      domain: {
        type: "string",
        enum: ["work", "life", "both", "auto"],
        description:
          "Which wiki(s) to read. 'auto' (default) lets the session pick; 'both' reads work + life.",
      },
    },
    required: ["question"],
  },
};

const TOOLS = [INGEST_TOOL, QUERY_TOOL];

// ── Agent-SDK options ───────────────────────────────────────────────────────────
// baseOptions returns the MANDATORY scoping + nesting safeguards shared by both tools.
// `extra` layers per-tool bits (skills, read-only disallow list, additionalDirectories).
// A FRESH AbortController is created per call so run()'s timeout aborts only that session.
function baseOptions(extra = {}) {
  return {
    // cwd = the scoped vault, NOT the launchd repo-root WorkingDirectory — anchors the
    // file tools and makes settingSources:"project" resolve to the vault's .claude/.
    cwd: COS_VAULT_DIR,
    // EXPLICIT (SDK default is version-ambiguous): load ONLY the vault-local CLAUDE.md +
    // skills, NOT the repo-root config with the full board/guard MCP wiring.
    settingSources: ["project"],
    // Use the standard Claude Code system prompt preset.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // The session needs Skill (to load second-brain-*) plus the file primitives.
    allowedTools: ["Skill", "Read", "Write", "Edit", "Glob", "Grep"],
    // Fully non-interactive behind the MCP — no human to answer a permission prompt.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model: COS_VAULT_MODEL,
    maxTurns: COS_VAULT_MAX_TURNS,
    // mcpServers:{} + strictMcpConfig:true → the inner agent mounts NO MCP servers and is
    // forbidden from reading any .mcp.json, so it can never re-mount vault:8005 and recurse.
    mcpServers: {},
    strictMcpConfig: true,
    // Belt-and-braces: even if a server were somehow mounted, the two re-entrant vault tools
    // are hard-denied; web tools are off (KNOWLEDGE-ONLY, vault-local).
    disallowedTools: ["WebFetch", "WebSearch", "mcp__vault__ingest", "mcp__vault__query"],
    // NB: the AbortController is created + wired SOLELY by run() (it is the single owner),
    // which injects it into options before calling query() — see run().
    ...extra,
  };
}

// ── Path validation for ingest.files (arbitrary-file-read guard) ─────────────────
// Each path must be a non-empty ABSOLUTE path; resolve it; ACCEPT only if it is inside
// COS_VAULT_DIR or inside one of COS_VAULT_ATTACH_DIRS. Returns either { error } (reject the
// WHOLE call, naming the offending path, BEFORE invoking the agent) or { accepted, extraDirs }
// where extraDirs are the parent dirs of accepted OUT-OF-VAULT paths (for additionalDirectories).
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function validateFiles(files) {
  const accepted = [];
  const extraDirs = new Set();
  const vaultRoot = path.resolve(COS_VAULT_DIR);
  for (const raw of files) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { error: `every entry in 'files' must be a non-empty absolute path (got ${JSON.stringify(raw)}).` };
    }
    const p = raw.trim();
    if (!path.isAbsolute(p)) {
      return { error: `file path must be absolute, not relative: ${p}` };
    }
    const resolved = path.resolve(p);
    const inVault = isInside(vaultRoot, resolved);
    const allowedDir = COS_VAULT_ATTACH_DIRS.find((d) => isInside(d, resolved));
    if (!inVault && !allowedDir) {
      return {
        error:
          `refusing to read file outside the vault and the allowed attachment dirs: ${resolved}. ` +
          (COS_VAULT_ATTACH_DIRS.length
            ? `Allowed dirs: ${COS_VAULT_ATTACH_DIRS.join(", ")}.`
            : `Set COS_VAULT_ATTACH_DIRS to permit out-of-vault sources.`),
      };
    }
    accepted.push(resolved);
    // Only out-of-vault (but allowlisted) paths need an additionalDirectories grant; in-vault
    // paths are already reachable via cwd.
    if (!inVault) extraDirs.add(path.dirname(resolved));
  }
  return { accepted, extraDirs: [...extraDirs] };
}

// ── Prompt templates ─────────────────────────────────────────────────────────────

function buildIngestPrompt({ content, accepted, cases, domain }) {
  const filesBlock = accepted.length ? accepted.map((f) => `- ${f}`).join("\n") : "(none)";
  const casesBlock = cases.length ? cases.join(", ") : "(none)";
  return (
    "You are the vault knowledge librarian. Load and follow the `second-brain-ingest` skill " +
    `exactly. Vault root: ${COS_VAULT_DIR}. The wiki is DOMAIN-SPLIT: work -> ${COS_VAULT_DIR}/work/wiki, ` +
    `life -> ${COS_VAULT_DIR}/life/wiki, shared entities -> ${COS_VAULT_DIR}/shared/wiki. You are ` +
    "KNOWLEDGE-ONLY: you have NO board/calendar/guard tools and MUST NOT create or move board " +
    "cases. Record any board case id you are given only as a read-only `cases:`/**Board:** reference.\n\n" +
    "Process the input(s). For each: classify domain (work|life), synthesize the affected " +
    "source/entity/concept pages in that wiki (rewrite, don't append; a substantive source " +
    "touches 10-15 pages), update that domain's index.md and log.md, resolve entities to canonical " +
    "[[wikilinks]].\n\n" +
    "If files are attached, COPY each into raw/assets/ and link it from the source page so it is " +
    "preserved and searchable (an associated artifact).\n\n" +
    "Maintain the domain's ULTRA-STRONG index.md — an overarching-theme map grouping concepts+entities, " +
    "not a flat list.\n\n" +
    "INLINE MATERIAL:\n<<<\n" +
    (content || "(none)") +
    "\n>>>\n\n" +
    "ATTACHED FILES (read each as a SOURCE; PDFs/images via native Read, describe content in text):\n" +
    filesBlock +
    "\n\n" +
    "ASSOCIATED BOARD CASES (record by reference only, do NOT write the board):\n" +
    casesBlock +
    "\n\n" +
    `DOMAIN HINT: ${domain && domain !== "auto" ? domain : "auto — classify yourself"}\n\n` +
    "When done, return ONLY a JSON summary: { perDomain, sourcesCreated, pagesResynthesized, " +
    "contradictions, boardRefsRecorded }. Do not ask interactive questions; make best-judgment " +
    "calls and note assumptions."
  );
}

function buildQueryPrompt({ question, domain }) {
  const hint =
    domain && domain !== "auto"
      ? `domain hint: ${domain}`
      : "domain hint: auto — determine the domain yourself";
  return (
    "You are the vault knowledge librarian. Load and follow the `second-brain-query` skill " +
    `exactly. Vault root: ${COS_VAULT_DIR}; wiki is DOMAIN-SPLIT (work/life/shared). KNOWLEDGE-ONLY: ` +
    "NO board access; if the question is purely about open work/to-dos, say so and stop (the " +
    `board owns that surface). Determine the question's domain (${hint}), read the matching ` +
    "index.md(s), follow [[wikilinks]], answer with [[wikilink]] citations. Do NOT write any " +
    "files.\n\n" +
    "QUESTION:\n<<<\n" +
    question +
    "\n>>>\n\n" +
    "Return the answer text plus a list of pages cited. Also return any ASSOCIATED ARTIFACTS " +
    "(files in raw/assets/ linked from the pages you cite) relevant to the answer."
  );
}

// ── Run an embedded session ─────────────────────────────────────────────────────
// SINGLE OWNER of the per-call AbortController: creates it, wires the timeout to its abort(),
// injects it into the options object, then streams the query, captures the single
// type==="result" message, and returns its text. A non-success / errored result throws; the
// caller (handleIngest/handleQuery) turns any throw into a clean err().
async function run(prompt, options) {
  const controller = new AbortController();
  options.abortController = controller;

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, COS_VAULT_TIMEOUT_MS);

  try {
    let finalText = null;
    for await (const message of query({ prompt, options })) {
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
          // Surface the REAL failure detail. Different SDK/API errors populate
          // different fields — a model-not-found, for instance, comes back as
          // subtype:"success" + is_error:true with the message in `result`, while a
          // max-turns/exec error uses `subtype`/`errors`. Check them all, and log the
          // raw result message to stderr (→ vault.err.log) so a bad run is diagnosable
          // without re-probing the API by hand.
          const detail =
            [
              message.api_error_status ? `http=${message.api_error_status}` : null,
              Array.isArray(message.errors) && message.errors.length
                ? message.errors.join("; ")
                : null,
              typeof message.result === "string" && message.result.trim()
                ? message.result.trim()
                : null,
              message.subtype && message.subtype !== "success"
                ? `subtype=${message.subtype}`
                : null,
            ]
              .filter(Boolean)
              .join(" | ") || "unknown agent error (no detail in result message)";
          try {
            console.error(
              `[vault] agent error result: ${JSON.stringify(message).slice(0, 2000)}`
            );
          } catch {}
          throw new Error(`is_error=${!!message.is_error}: ${detail}`);
        }
        finalText = message.result;
      }
    }
    if (finalText === null) throw new Error("agent produced no result message");
    return finalText;
  } catch (e) {
    if (timedOut || e?.name === "AbortError") {
      throw new Error(`vault agent timed out after ${COS_VAULT_TIMEOUT_MS}ms`);
    }
    // Some failures (auth, network, a bad model id rejected before streaming) are THROWN
    // by query() rather than returned as a result message; carry the real message + cause
    // through, and log it so the err.log shows the actual API error.
    const cause = e?.cause ? ` (cause: ${e.cause?.message ?? String(e.cause)})` : "";
    const msg = `${e?.message ?? String(e)}${cause}`;
    console.error(`[vault] agent session failed: ${msg}`);
    throw new Error(`vault agent session failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool handlers ────────────────────────────────────────────────────────────────

function requireVaultDir() {
  if (!COS_VAULT_DIR) {
    return err(
      "COS_VAULT_DIR is not set — the vault MCP needs the absolute vault root in its environment."
    );
  }
  // A misconfigured root is better caught here than as a confusing agent failure.
  if (!fs.existsSync(COS_VAULT_DIR)) {
    return err(`COS_VAULT_DIR does not exist: ${COS_VAULT_DIR}`);
  }
  return null;
}

async function handleIngest(args) {
  const guard = requireVaultDir();
  if (guard) return guard;

  const content = typeof args.content === "string" ? args.content : "";
  const files = Array.isArray(args.files) ? args.files : [];
  const cases = Array.isArray(args.cases) ? args.cases.filter((c) => str(c)) : [];
  const domain = ["work", "life", "auto"].includes(args.domain) ? args.domain : "auto";

  // Reject if BOTH content is empty AND no files were supplied.
  if (content.trim() === "" && files.length === 0) {
    return err("provide content or files — both are empty.");
  }

  // Arbitrary-file-read guard runs BEFORE the agent is ever invoked.
  let accepted = [];
  let extraDirs = [];
  if (files.length) {
    const v = validateFiles(files);
    if (v.error) return err(v.error);
    accepted = v.accepted;
    extraDirs = v.extraDirs;
  }

  const prompt = buildIngestPrompt({ content, accepted, cases, domain });
  const options = baseOptions({
    skills: ["second-brain-ingest"],
    // Grant the validated parent dirs of out-of-vault attachments so Read can reach them.
    additionalDirectories: extraDirs,
  });

  await sessions.acquire();
  try {
    const result = await run(prompt, options);
    return text(result);
  } catch (e) {
    return err(e?.message ?? String(e));
  } finally {
    sessions.release();
  }
}

async function handleQuery(args) {
  const guard = requireVaultDir();
  if (guard) return guard;

  const question = str(args.question);
  if (!question) return err("'question' is required.");
  const domain = ["work", "life", "both", "auto"].includes(args.domain) ? args.domain : "auto";

  const prompt = buildQueryPrompt({ question, domain });
  const options = baseOptions({
    skills: ["second-brain-query"],
    // Read-only: strip Write/Edit on top of the base allow list.
    allowedTools: ["Skill", "Read", "Glob", "Grep"],
    disallowedTools: [
      "Write",
      "Edit",
      "WebFetch",
      "WebSearch",
      "mcp__vault__ingest",
      "mcp__vault__query",
    ],
  });

  await sessions.acquire();
  try {
    const result = await run(prompt, options);
    return text(result);
  } catch (e) {
    return err(e?.message ?? String(e));
  } finally {
    sessions.release();
  }
}

// ── Server wiring ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "vault", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  try {
    switch (request.params.name) {
      case "ingest":
        return await handleIngest(args);
      case "query":
        return await handleQuery(args);
      default:
        return err(`Unknown tool: ${request.params.name}`);
    }
  } catch (e) {
    // Final backstop — no input can crash-loop the KeepAlive'd process.
    return err(`vault MCP error: ${e?.message ?? String(e)}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `vault MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; ` +
    `COS_VAULT_DIR=${COS_VAULT_DIR || "(UNSET — tools will error)"}; model=${COS_VAULT_MODEL})`
);
