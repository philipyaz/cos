// Shared agent-run path for the vault MCP — the embedded Claude Agent SDK session and everything
// that scopes it. Extracted from server.mjs so BOTH the MCP server (which runs synchronous `query`
// sessions) and the detached jobs-runner (which runs `ingest` sessions claimed from the job store)
// import ONE implementation of the prompts, the nesting/scoping safeguards, and run().
//
// The four anti-recursion safeguards live here (baseOptions): this server is itself bridged at
// vault:8005 in the repo's .mcp.json, so a naïve inner session could re-mount this server and recurse
// into ingest/query forever. mcpServers:{} + strictMcpConfig:true (mount no MCP, read no .mcp.json),
// disallowedTools (hard-deny the re-entrant vault tools + web), settingSources:["project"] (load only
// the vault-local config), and cwd=COS_VAULT_DIR (anchor the file tools to the scoped vault) make that
// impossible. Importing this module has NO side effects (no boot, no transport) — server.mjs and the
// runner own their own lifecycles; the unit suite asserts on this source without spawning anything.
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

// ── Config (read once) ─────────────────────────────────────────────────────────
export const COS_VAULT_DIR = process.env.COS_VAULT_DIR || "";
// Per-tool models: the READ path (query) on the fast/low-cost Haiku tier so a lookup returns inside
// the client's tool-call timeout; the WRITE path (ingest) on Sonnet for multi-page synthesis quality.
// COS_VAULT_MODEL, if set, pins BOTH (back-compat).
export const COS_VAULT_INGEST_MODEL =
  process.env.COS_VAULT_MODEL || process.env.COS_VAULT_INGEST_MODEL || "claude-sonnet-4-6";
export const COS_VAULT_QUERY_MODEL =
  process.env.COS_VAULT_MODEL || process.env.COS_VAULT_QUERY_MODEL || "claude-haiku-4-5";
export const COS_VAULT_MAX_TURNS = Number(process.env.COS_VAULT_MAX_TURNS) || 30;
export const COS_VAULT_QUERY_MAX_TURNS = Number(process.env.COS_VAULT_QUERY_MAX_TURNS) || 15;
// Internal session timeouts (per tool). For ingest these now govern a DETACHED runner session, so a
// long synthesis is bounded only by this ceiling, never the client wall-clock. COS_VAULT_TIMEOUT_MS,
// if set, overrides BOTH (back-compat).
export const COS_VAULT_INGEST_TIMEOUT_MS =
  Number(process.env.COS_VAULT_TIMEOUT_MS) ||
  Number(process.env.COS_VAULT_INGEST_TIMEOUT_MS) ||
  600000;
export const COS_VAULT_QUERY_TIMEOUT_MS =
  Number(process.env.COS_VAULT_TIMEOUT_MS) ||
  Number(process.env.COS_VAULT_QUERY_TIMEOUT_MS) ||
  90000;
export const COS_VAULT_CONCURRENCY = Number(process.env.COS_VAULT_CONCURRENCY) || 2;
// Optional colon-separated allowlist of dirs OUTSIDE the vault from which file attachments may be read.
export const COS_VAULT_ATTACH_DIRS = (process.env.COS_VAULT_ATTACH_DIRS || "")
  .split(":")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(d));

// ── Tiny in-process semaphore ────────────────────────────────────────────────────
// Per-process FIFO permit pool. Caps concurrent embedded sessions so simultaneous calls (queries in
// the server; ingests in the runner) don't fan out into N claude subprocesses. Each process gets its
// own pool.
export function makeSemaphore(limit) {
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

// ── Agent-SDK options (the scoping + nesting safeguards) ───────────────────────────
function baseOptions(extra = {}) {
  return {
    cwd: COS_VAULT_DIR,
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    allowedTools: ["Skill", "Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Defaults below are the INGEST (write) profile — Sonnet + the full turn budget. runQuerySession
    // overrides both via `extra` to the lighter Haiku read profile (COS_VAULT_QUERY_MODEL).
    model: COS_VAULT_INGEST_MODEL,
    maxTurns: COS_VAULT_MAX_TURNS,
    mcpServers: {},
    strictMcpConfig: true,
    disallowedTools: ["WebFetch", "WebSearch", "mcp__vault__ingest", "mcp__vault__query"],
    ...extra,
  };
}

// ── Path validation for ingest.files (arbitrary-file-read guard) ───────────────────
// Accept a path only if it is a non-empty ABSOLUTE path inside COS_VAULT_DIR or inside one of
// COS_VAULT_ATTACH_DIRS. Returns { error } (reject the WHOLE call, naming the offending path, BEFORE
// any agent runs) or { accepted, extraDirs } (extraDirs = parent dirs of accepted OUT-OF-VAULT paths,
// for additionalDirectories).
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function validateFiles(files) {
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
    if (!inVault) extraDirs.add(path.dirname(resolved));
  }
  return { accepted, extraDirs: [...extraDirs] };
}

// ── Prompt templates ───────────────────────────────────────────────────────────────
export function buildIngestPrompt({ content, accepted, cases, domain }) {
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

export function buildQueryPrompt({ question, domain }) {
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

// ── Run an embedded session ─────────────────────────────────────────────────────────
// SINGLE OWNER of the per-call AbortController: creates it, wires the (per-tool) timeout AND the
// caller's cancellation signal to its abort(), then streams the query, captures the type==="result"
// message, and returns its text. A non-success / errored result throws; the caller turns a throw into
// a clean error (an err() MCP result in the server, a failed-job setStatus in the runner).
export async function run(prompt, options, timeoutMs, clientSignal) {
  const controller = new AbortController();
  options.abortController = controller;

  // Wire the caller's cancellation (the MCP client's timeout/notifications-cancelled in the server, or
  // the job's cancelRequested flag in the runner) into the same abort, so the session stops promptly
  // instead of running to timeoutMs and burning tokens.
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let finalText = null;
    for await (const message of query({ prompt, options })) {
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
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
            console.error(`[vault] agent error result: ${JSON.stringify(message).slice(0, 2000)}`);
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
      throw new Error(`vault agent timed out after ${timeoutMs}ms`);
    }
    const cause = e?.cause ? ` (cause: ${e.cause?.message ?? String(e.cause)})` : "";
    const msg = `${e?.message ?? String(e)}${cause}`;
    console.error(`[vault] agent session failed: ${msg}`);
    throw new Error(`vault agent session failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── High-level sessions (semaphore-wrapped) ──────────────────────────────────────────
// runQuerySession — READ path (Haiku, tight turns/timeout, read-only tool set). Used by the MCP
// server synchronously.
export async function runQuerySession({ question, domain, clientSignal }) {
  const prompt = buildQueryPrompt({ question, domain });
  const options = baseOptions({
    skills: ["second-brain-query"],
    model: COS_VAULT_QUERY_MODEL,
    maxTurns: COS_VAULT_QUERY_MAX_TURNS,
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
    return await run(prompt, options, COS_VAULT_QUERY_TIMEOUT_MS, clientSignal);
  } finally {
    sessions.release();
  }
}

// runIngestSession — WRITE path (Sonnet, full turns, generous timeout). Used by the DETACHED runner;
// `accepted`/`extraDirs` come from validateFiles run earlier (in the server, before the job was even
// enqueued). clientSignal is the runner's cancel-observer.
export async function runIngestSession({ content, accepted = [], cases = [], domain, extraDirs = [], clientSignal }) {
  const prompt = buildIngestPrompt({ content, accepted, cases, domain });
  const options = baseOptions({
    skills: ["second-brain-ingest"],
    additionalDirectories: extraDirs,
  });
  await sessions.acquire();
  try {
    return await run(prompt, options, COS_VAULT_INGEST_TIMEOUT_MS, clientSignal);
  } finally {
    sessions.release();
  }
}
