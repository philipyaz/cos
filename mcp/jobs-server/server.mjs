#!/usr/bin/env node
// MCP server (registry name "jobs") for the Cos job-matcher add-on.
// Scrapes Indeed RSS + Adzuna API, stores offers in board/data/jobs.json
// with dedup by URL hash, and scores offers against the vault profile via Claude.
//
// Tools:
//   fetch_jobs(query, location, limit)  — scrape and store new offers
//   list_jobs(status, min_score)        — list stored offers
//   analyze_job(job_id)                 — score an offer vs vault profile
//   update_job_status(job_id, status)   — update offer status
//
// Config:
//   CRM_BASE_URL        (default http://localhost:3000)
//   ADZUNA_APP_ID       Adzuna API credentials (in config/secrets.env)
//   ADZUNA_APP_KEY
//   ANTHROPIC_API_KEY   For the analyze_job Claude call
//   VAULT_MCP_URL       Vault MCP bridge URL (default http://localhost:8005)

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err, text, str, start, baseUrl } from "../../packages/mcp-kit/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const JOBS_FILE = join(REPO_ROOT, "board", "data", "jobs.json");
const CRM_BASE_URL = baseUrl("CRM_BASE_URL", "http://localhost:3000");
const VAULT_MCP_URL = baseUrl("VAULT_MCP_URL", "http://localhost:8005");

const JOB_STATUS = ["new", "reviewed", "applied", "rejected"];

// ── Persistence ──────────────────────────────────────────────────────────────

function loadJobs() {
  try {
    if (existsSync(JOBS_FILE)) {
      return JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
    }
  } catch { /* corrupt file — start fresh */ }
  return { entries: [] };
}

function saveJobs(db) {
  const dir = dirname(JOBS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(db, null, 2) + "\n", "utf-8");
}

function hashUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// ── Exa.ai search ────────────────────────────────────────────────────────────

function extractCompany(title, url) {
  const atMatch = title.match(/\b(?:at|chez|@)\s+(.+?)(?:\s*[-–|]|$)/i);
  if (atMatch) return atMatch[1].trim();
  const parts = title.split(/\s*[-–|]\s*/);
  if (parts.length >= 2) return parts[1].trim();
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function searchExa(query, location, limit) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    console.error("[jobs] EXA_API_KEY not set");
    return [];
  }
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: `offres emploi ${query} ${location}`,
        num_results: limit,
        use_autoprompt: true,
        type: "neural",
        contents: { text: true },
      }),
    });
    if (!res.ok) {
      console.error(`[jobs] Exa API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.results || [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title || "",
        company: extractCompany(r.title || "", r.url || ""),
        location,
        url: r.url,
        description: (r.text || "").slice(0, 500),
        source: "exa",
      }));
  } catch (e) {
    console.error(`[jobs] Exa error: ${e.message}`);
    return [];
  }
}

// ── Vault profile query ──────────────────────────────────────────────────────

async function queryVaultProfile() {
  try {
    const res = await fetch(`${VAULT_MCP_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query",
          arguments: { query: "CV competences experiences professionnelles skills" },
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.result?.content;
    if (Array.isArray(content)) {
      return content.map((c) => c.text || "").join("\n");
    }
    return null;
  } catch (e) {
    console.error(`[jobs] Vault query error: ${e.message}`);
    return null;
  }
}

// ── Claude analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(profile, job) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { error: "ANTHROPIC_API_KEY not configured in config/secrets.env" };
  }

  const prompt = `Tu es un expert en recrutement. Analyse la correspondance entre le profil du candidat et l'offre d'emploi.

## Profil du candidat
${profile}

## Offre d'emploi
**Poste:** ${job.title}
**Entreprise:** ${job.company}
**Lieu:** ${job.location}
**Description:** ${job.description}

## Instructions
Reponds en JSON strict (pas de markdown, pas de code block) avec exactement cette structure:
{
  "match_score": <nombre 0-100>,
  "strengths": ["<point fort 1>", "<point fort 2>", ...],
  "gaps": ["<lacune 1>", "<lacune 2>", ...],
  "recommendation": "<postuler|a_considerer|passer>",
  "cover_letter_hook": "<premiere phrase d'accroche personnalisee pour la lettre de motivation>"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errData = await res.text();
      return { error: `Claude API returned ${res.status}: ${errData}` };
    }
    const data = await res.json();
    const responseText = data.content?.[0]?.text || "";
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "Could not parse Claude response as JSON" };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { error: `Claude analysis failed: ${e.message}` };
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const FETCH_JOBS_TOOL = {
  name: "fetch_jobs",
  description:
    "Search job offers via Exa.ai neural search, deduplicate by URL, " +
    "and store new offers in the jobs database. Returns the count of new offers found. " +
    "Requires EXA_API_KEY in config/secrets.env.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, e.g. 'software engineer', 'data scientist'." },
      location: { type: "string", description: "Location, e.g. 'Zurich', 'Geneva', 'Remote'." },
      limit: { type: "number", description: "Max offers per source (default 20)." },
    },
    required: ["query", "location"],
  },
};

const LIST_JOBS_TOOL = {
  name: "list_jobs",
  description:
    "List stored job offers from the jobs database. Filter by status (new|reviewed|applied|rejected) " +
    "and/or minimum match score. Returns a compact summary of each offer.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: JOB_STATUS, description: "Filter by status: new | reviewed | applied | rejected." },
      min_score: { type: "number", description: "Filter by minimum match score (0-100). Only shows analyzed jobs." },
    },
  },
};

const ANALYZE_JOB_TOOL = {
  name: "analyze_job",
  description:
    "Analyze a job offer against the user's vault profile using Claude. Reads the CV/skills from " +
    "the vault, compares with the offer, and produces a match score (0-100), strengths, gaps, a " +
    "recommendation (postuler|a_considerer|passer), and a personalized cover letter hook. " +
    "Requires ANTHROPIC_API_KEY in config/secrets.env.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job ID (the 16-char URL hash), e.g. 'a1b2c3d4e5f67890'." },
    },
    required: ["job_id"],
  },
};

const UPDATE_JOB_STATUS_TOOL = {
  name: "update_job_status",
  description:
    "Update the status of a job offer. Status flow: new -> reviewed -> applied or rejected.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job ID (the 16-char URL hash)." },
      status: { type: "string", enum: JOB_STATUS, description: "New status: new | reviewed | applied | rejected." },
    },
    required: ["job_id", "status"],
  },
};

const TOOLS = [FETCH_JOBS_TOOL, LIST_JOBS_TOOL, ANALYZE_JOB_TOOL, UPDATE_JOB_STATUS_TOOL];

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleFetchJobs(args) {
  const query = str(args.query);
  const location = str(args.location);
  if (!query) return err("'query' is required.");
  if (!location) return err("'location' is required.");
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;

  const exaResults = await searchExa(query, location, limit);

  const db = loadJobs();
  const existingIds = new Set(db.entries.map((e) => e.id));
  let added = 0;

  for (const raw of exaResults) {
    if (!raw.url) continue;
    const id = hashUrl(raw.url);
    if (existingIds.has(id)) continue;
    db.entries.push({
      id,
      ts: new Date().toISOString(),
      title: raw.title,
      company: raw.company,
      location: raw.location,
      url: raw.url,
      description: raw.description,
      source: raw.source,
      match_score: null,
      match_analysis: null,
      status: "new",
    });
    existingIds.add(id);
    added++;
  }

  saveJobs(db);

  const lines = [
    `Fetched jobs for "${query}" in "${location}":`,
    `  Exa.ai: ${exaResults.length} results`,
    `  New offers added: ${added}`,
    `  Total in database: ${db.entries.length}`,
  ];
  return text(lines.join("\n"));
}

async function handleListJobs(args) {
  const db = loadJobs();
  let entries = db.entries;

  if (typeof args.status === "string" && JOB_STATUS.includes(args.status)) {
    entries = entries.filter((e) => e.status === args.status);
  }
  if (typeof args.min_score === "number") {
    entries = entries.filter((e) => typeof e.match_score === "number" && e.match_score >= args.min_score);
  }

  if (!entries.length) return text("No jobs found matching the filters.");

  // Sort: analyzed jobs by score desc, then unanalyzed by date desc
  entries.sort((a, b) => {
    if (a.match_score !== null && b.match_score !== null) return b.match_score - a.match_score;
    if (a.match_score !== null) return -1;
    if (b.match_score !== null) return 1;
    return b.ts.localeCompare(a.ts);
  });

  const lines = [`Jobs (${entries.length}):`];
  for (const e of entries) {
    const score = typeof e.match_score === "number" ? `${e.match_score}/100` : "—";
    lines.push(`  ${e.id}  [${e.status}]  score:${score}  ${e.source}`);
    lines.push(`    ${e.title} @ ${e.company} (${e.location})`);
  }
  return text(lines.join("\n"));
}

async function handleAnalyzeJob(args) {
  const jobId = str(args.job_id);
  if (!jobId) return err("'job_id' is required.");

  const db = loadJobs();
  const job = db.entries.find((e) => e.id === jobId);
  if (!job) return err(`Job '${jobId}' not found.`);

  // Query the vault for the user's profile
  const profile = await queryVaultProfile();
  if (!profile) {
    return err(
      "Could not retrieve profile from the vault. Make sure the vault MCP bridge is running " +
      "and your vault contains CV/skills information."
    );
  }

  const analysis = await analyzeWithClaude(profile, job);
  if (analysis.error) return err(analysis.error);

  // Store the analysis
  job.match_score = analysis.match_score;
  job.match_analysis = analysis;
  if (job.status === "new") job.status = "reviewed";
  saveJobs(db);

  const lines = [
    `Analysis for: ${job.title} @ ${job.company}`,
    `Match score: ${analysis.match_score}/100`,
    `Recommendation: ${analysis.recommendation}`,
    "",
    "Strengths:",
    ...(analysis.strengths || []).map((s) => `  + ${s}`),
    "",
    "Gaps:",
    ...(analysis.gaps || []).map((g) => `  - ${g}`),
    "",
    `Cover letter hook: "${analysis.cover_letter_hook}"`,
  ];
  return text(lines.join("\n"));
}

async function handleUpdateJobStatus(args) {
  const jobId = str(args.job_id);
  const status = str(args.status);
  if (!jobId) return err("'job_id' is required.");
  if (!JOB_STATUS.includes(status)) return err(`'status' must be one of: ${JOB_STATUS.join(", ")}.`);

  const db = loadJobs();
  const job = db.entries.find((e) => e.id === jobId);
  if (!job) return err(`Job '${jobId}' not found.`);

  const oldStatus = job.status;
  job.status = status;
  saveJobs(db);

  return text(`Updated ${jobId}: ${oldStatus} -> ${status}\n${job.title} @ ${job.company}`);
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "jobs", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "fetch_jobs":
      return handleFetchJobs(args);
    case "list_jobs":
      return handleListJobs(args);
    case "analyze_job":
      return handleAnalyzeJob(args);
    case "update_job_status":
      return handleUpdateJobStatus(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

await start(
  server,
  new StdioServerTransport(),
  `jobs MCP server v1 ready (tools: ${TOOLS.map((t) => t.name).join(", ")}; CRM_BASE_URL=${CRM_BASE_URL})`
);
