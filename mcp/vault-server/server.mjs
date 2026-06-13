#!/usr/bin/env node
// MCP server (registry name "vault") for the Cos DOMAIN-SPLIT KNOWLEDGE VAULT.
//
// This is the THIN MCP layer. The agent-run path (the embedded Claude Agent SDK session + the
// nesting/scoping safeguards + the prompts) lives in agent.mjs; the durable async job state lives in
// jobs.mjs. This file just maps MCP tool calls onto them:
//
//   • query        — SYNCHRONOUS. Runs a read-only Haiku session (agent.mjs runQuerySession) and
//                     returns the answer directly. Fast enough to return inside any client's cap.
//   • ingest       — ASYNCHRONOUS (submit-then-poll). Validates the file allowlist, ENQUEUES a job
//                     (jobs.mjs, content-hash dedup so identical re-submits collapse to one job), and
//                     returns the job_id IMMEDIATELY in an ordinary CallToolResult. A separate
//                     launchd-supervised jobs-runner (jobs-runner.mjs) claims the job and runs the
//                     Sonnet synthesis DETACHED, so a multi-minute ingest survives the client's tool
//                     -call timeout (notably Cowork's unconfigurable ~4-min cap).
//   • ingest_status / ingest_cancel — poll a job to a terminal state / cooperatively cancel it.
//
// WHY a job id in a NORMAL result and not the MCP Tasks extension: today's clients negotiate
// protocolVersion 2025-11-25 and do not advertise io.modelcontextprotocol/tasks, and the Tasks spec
// (§4.3) FORBIDS returning a CreateTaskResult to a client that didn't advertise it. A job-id-in-
// CallToolResult is ordinary application data — spec-compatible — and the field names mirror the Tasks
// shape so the future swap (when a client advertises the extension — see tasksCapable()) is a one-file
// wire-adapter change, not a rewrite.
//
// KNOWLEDGE-ONLY: no board/calendar/guard tools; a board case id handed to ingest is recorded by
// reference only. AUTH: the embedded SDK needs ANTHROPIC_API_KEY in the environment (the RUNNER's
// environment for ingest; this process's for query). Every failure mode is caught and turned into a
// clean err()/failed-job, so a bad input can never crash-loop the KeepAlive'd process.
//
// Runs over stdio; supergateway fronts it for the HTTP bridge on 127.0.0.1:8005/mcp.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start } from "../../packages/mcp-kit/index.mjs";
import fs from "node:fs";
import {
  COS_VAULT_DIR,
  COS_VAULT_QUERY_MODEL,
  COS_VAULT_INGEST_MODEL,
  validateFiles,
  runQuerySession,
} from "./agent.mjs";
import { makeJobStore, resolveJobsFile, TERMINAL_STATUSES } from "./jobs.mjs";

// ── Async surface tuning ─────────────────────────────────────────────────────────
// Suggested poll cadence + the job retrievability window, surfaced honestly in structuredContent so
// the model polls on a sane interval and knows how long a result stays fetchable.
const POLL_INTERVAL_MS = Number(process.env.COS_VAULT_POLL_INTERVAL_MS) || 8000;
const INGEST_TTL_MS = Number(process.env.COS_VAULT_JOBS_TTL_MS) || 3_600_000; // 60 min (Tasks §11.2 default)

const jobs = makeJobStore(resolveJobsFile());

// A CallToolResult carrying both a human line and structured data (the interim form of the Tasks
// CreateTaskResult / tasks-get payload). structuredContent gives the model the job_id + cadence + the
// terminal result/error without parsing prose.
const textSC = (line, structuredContent) => ({
  content: [{ type: "text", text: line }],
  structuredContent,
});

// ── Tool definitions ───────────────────────────────────────────────────────────
const KNOWLEDGE_NOTE =
  "KNOWLEDGE ONLY — never writes the board; a board case id is recorded by reference only. Each call " +
  "runs a headless Claude Code session scoped to the vault.";

const INGEST_TOOL = {
  name: "ingest",
  description:
    "Submit material for ingestion into the domain-split vault wiki (work/life). " +
    KNOWLEDGE_NOTE +
    " ASYNCHRONOUS: returns IMMEDIATELY with a job_id in structuredContent; ingestion runs in the " +
    "background and takes seconds to minutes. A returned job_id does NOT mean it finished — you MUST " +
    "poll ingest_status(job_id) on the cadence in poll_interval_ms until status is terminal " +
    "(completed/failed/cancelled/interrupted) before reporting the result. Do NOT call ingest again " +
    "for the same material while a job is in flight — an identical re-submit returns the SAME job_id " +
    "(dedup), so re-submitting wastes a turn; poll instead. Provide inline `content` and/or `files` " +
    "(absolute on-device paths, read as sources). `domain` ('work'|'life'|'auto', default 'auto'). " +
    "`cases` are board case ids recorded BY REFERENCE only.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "Inline material to ingest — a thought, email body, transcript, or recap. May be an empty " +
          "string if `files` are supplied instead.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Absolute on-device paths to read as SOURCES. Each must be inside the vault root or an " +
          "allowed COS_VAULT_ATTACH_DIRS dir; any path outside the allowlist rejects the whole call.",
      },
      domain: {
        type: "string",
        enum: ["work", "life", "auto"],
        description: "Domain hint. 'auto' (default) lets the session classify each input itself.",
      },
      cases: {
        type: "array",
        items: { type: "string" },
        description:
          "OPTIONAL board case ids (e.g. 'CASE-1') recorded BY REFERENCE only — the vault never writes the board.",
      },
    },
    required: ["content"],
  },
};

const INGEST_STATUS_TOOL = {
  name: "ingest_status",
  description:
    "Check an ingestion job started by `ingest`. Call after ingest and re-call every poll_interval_ms " +
    "until status is terminal (completed/failed/cancelled/interrupted). While status is working or " +
    "running the job is still in progress — wait and poll again; do NOT start a new ingest. On " +
    "completed, structuredContent.result holds the ingest summary; on failed/interrupted, " +
    "structuredContent.error holds the reason. An unknown or expired job_id is an error (it aged out " +
    "of its retention window — re-submit the material).",
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string", description: "The job_id returned by ingest." } },
    required: ["job_id"],
  },
};

const INGEST_CANCEL_TOOL = {
  name: "ingest_cancel",
  description:
    "Cancel an in-flight ingestion job by job_id. Cooperative: the job stops at its next checkpoint " +
    "and already-written pages STAY (no rollback). Acking an already-finished job is harmless. Use " +
    "when the user aborts or the ingest is no longer needed.",
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string", description: "The job_id to cancel." } },
    required: ["job_id"],
  },
};

const QUERY_TOOL = {
  name: "query",
  description:
    "Answer a question against the domain-split vault wiki. " +
    KNOWLEDGE_NOTE +
    " Read-only and SYNCHRONOUS — returns the answer directly (do NOT poll). The session reads the " +
    "matching domain index.md(s), follows [[wikilinks]], and answers with [[wikilink]] citations. " +
    "Purely-open-work questions (open to-dos / what's-in-flight) are declined with a board pointer. " +
    "`domain` ('work'|'life'|'both'|'auto', default 'auto') scopes which wiki(s) are read.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to answer against the vault wiki." },
      domain: {
        type: "string",
        enum: ["work", "life", "both", "auto"],
        description: "Which wiki(s) to read. 'auto' (default) lets the session pick; 'both' reads work + life.",
      },
    },
    required: ["question"],
  },
};

const TOOLS = [INGEST_TOOL, INGEST_STATUS_TOOL, INGEST_CANCEL_TOOL, QUERY_TOOL];

// ── Guards + wire seam ───────────────────────────────────────────────────────────
function requireVaultDir() {
  if (!COS_VAULT_DIR) {
    return err("COS_VAULT_DIR is not set — the vault MCP needs the absolute vault root in its environment.");
  }
  if (!fs.existsSync(COS_VAULT_DIR)) {
    return err(`COS_VAULT_DIR does not exist: ${COS_VAULT_DIR}`);
  }
  return null;
}

// The future Tasks-extension swap point. On a client that advertises io.modelcontextprotocol/tasks in
// this request's _meta we would emit a real CreateTaskResult; no 2025-11-25 client does, so this is
// always false today and ingest always takes the interim job-id path. Wiring it now makes the later
// swap a branch, not a rewrite.
function tasksCapable(request) {
  const caps = request?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
  return !!caps?.extensions?.["io.modelcontextprotocol/tasks"];
}

// shapeJobResult — the SOLE serialization seam for the async surface. Today it emits the interim
// job-id CallToolResult; the Tasks-extension swap replaces ONLY this function (+ tool registration).
function shapeJobResult(job, { created } = {}) {
  const sc = {
    job_id: job.id,
    status: job.status,
    created_at: job.firstSeen,
    last_updated_at: job.lastSeen,
    poll_interval_ms: POLL_INTERVAL_MS,
    ttl_ms: INGEST_TTL_MS,
    submission_count: job.submissionCount,
    dedup: created === false,
  };
  const line =
    created === false
      ? `Ingest job ${job.id} is already ${job.status} (submission #${job.submissionCount}); poll ingest_status — do NOT re-submit.`
      : `Ingest job ${job.id} submitted (status: ${job.status}). Poll ingest_status(${job.id}) every ~${Math.round(POLL_INTERVAL_MS / 1000)}s until terminal before reporting the result.`;
  return textSC(line, sc);
}

function shapeStatusResult(job) {
  const sc = {
    job_id: job.id,
    status: job.status,
    status_message: job.status_message ?? null,
    created_at: job.firstSeen,
    last_updated_at: job.lastSeen,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    poll_interval_ms: POLL_INTERVAL_MS,
    ttl_ms: INGEST_TTL_MS,
  };
  if (job.status === "completed") {
    sc.result = job.result ?? null;
    // Honesty: if the store clipped an off-contract oversized result (capPatch → resultTruncated),
    // tell the caller so it never reports a silently-shortened receipt as the whole summary.
    if (job.resultTruncated) sc.result_truncated = true;
  }
  if (job.status === "failed" || job.status === "interrupted") {
    sc.error = job.error ?? { message: job.interruptedReason || "interrupted", retryable: true };
  }
  const live = !TERMINAL_STATUSES.has(job.status);
  const line = live
    ? `Ingest job ${job.id}: ${job.status}${job.status_message ? " — " + job.status_message : ""}. Still running — poll again in ~${Math.round(POLL_INTERVAL_MS / 1000)}s.`
    : `Ingest job ${job.id}: ${job.status} (terminal).`;
  return textSC(line, sc);
}

// ── Tool handlers ────────────────────────────────────────────────────────────────
async function handleIngest(args, { wantsTasks } = {}) {
  const guard = requireVaultDir();
  if (guard) return guard;

  const content = typeof args.content === "string" ? args.content : "";
  const files = Array.isArray(args.files) ? args.files : [];
  const cases = Array.isArray(args.cases) ? args.cases.filter((c) => str(c)) : [];
  const domain = ["work", "life", "auto"].includes(args.domain) ? args.domain : "auto";

  if (content.trim() === "" && files.length === 0) {
    return err("provide content or files — both are empty.");
  }

  // Arbitrary-file-read guard runs BEFORE the job is ever enqueued (fail fast to the caller). The
  // runner re-validates from the stored files list before it runs the agent.
  if (files.length) {
    const v = validateFiles(files);
    if (v.error) return err(v.error);
  }

  // wantsTasks is the future Tasks-extension seam — always false on 2025-11-25 clients, so we always
  // take the interim job-id path below. (When true, a future build returns a real CreateTaskResult.)
  void wantsTasks;

  try {
    const { job, created } = await jobs.enqueue({ content, files, domain, cases });
    return shapeJobResult(job, { created });
  } catch (e) {
    return err(`vault ingest enqueue failed: ${e?.message ?? String(e)}`);
  }
}

async function handleIngestStatus(args) {
  const guard = requireVaultDir();
  if (guard) return guard;
  const id = str(args.job_id);
  if (!id) return err("'job_id' is required.");
  const job = await jobs.getJob(id);
  if (!job) return err(`unknown or expired ingest job: ${id}`);
  return shapeStatusResult(job);
}

async function handleIngestCancel(args) {
  const guard = requireVaultDir();
  if (guard) return guard;
  const id = str(args.job_id);
  if (!id) return err("'job_id' is required.");
  const job = await jobs.requestCancel(id);
  if (!job) return err(`unknown or expired ingest job: ${id}`);
  return textSC(
    `Cancellation requested for ingest job ${id} (current status: ${job.status}). It stops at its next checkpoint.`,
    { job_id: id, status: job.status, cancel_requested: !!job.cancelRequested },
  );
}

// query is SYNCHRONOUS — runQuerySession wraps the semaphore + the read-only Haiku session. The MCP
// request's cancellation signal aborts it if the client gives up.
async function handleQuery(args, clientSignal) {
  const guard = requireVaultDir();
  if (guard) return guard;
  const question = str(args.question);
  if (!question) return err("'question' is required.");
  const domain = ["work", "life", "both", "auto"].includes(args.domain) ? args.domain : "auto";
  try {
    return text(await runQuerySession({ question, domain, clientSignal }));
  } catch (e) {
    return err(e?.message ?? String(e));
  }
}

// ── Server wiring ────────────────────────────────────────────────────────────────
const server = new Server({ name: "vault", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  // extra.signal aborts when the client cancels this tool call (its timeout / notifications/cancelled);
  // it matters for the synchronous query (ingest returns instantly).
  const clientSignal = extra?.signal;
  const wantsTasks = tasksCapable(request); // future Tasks-extension seam — false on today's clients
  try {
    switch (request.params.name) {
      case "ingest":
        return await handleIngest(args, { wantsTasks });
      case "ingest_status":
        return await handleIngestStatus(args);
      case "ingest_cancel":
        return await handleIngestCancel(args);
      case "query":
        return await handleQuery(args, clientSignal);
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
  `vault MCP server v2 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; ` +
    `COS_VAULT_DIR=${COS_VAULT_DIR || "(UNSET — tools will error)"}; ` +
    `query=${COS_VAULT_QUERY_MODEL} (sync), ingest=${COS_VAULT_INGEST_MODEL} (async via jobs-runner); ` +
    `jobs=${jobs.file})`,
);
