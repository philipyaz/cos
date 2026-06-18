import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const JOBS_FILE = path.join(process.cwd(), "data", "jobs.json");

export interface JobEntry {
  id: string;
  ts: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  source: string;
  match_score: number | null;
  match_analysis: MatchAnalysis | null;
  status: string;
}

export interface MatchAnalysis {
  match_score: number;
  strengths: string[];
  gaps: string[];
  recommendation: string;
  cover_letter_hook: string;
}

export interface JobsDb {
  entries: JobEntry[];
}

export function loadJobs(): JobsDb {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    }
  } catch { /* corrupt — return empty */ }
  return { entries: [] };
}

export function saveJobs(db: JobsDb): void {
  const dir = path.dirname(JOBS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(db, null, 2) + "\n", "utf-8");
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// ── Saved searches ──────────────────────────────────────────────────────────

const SEARCHES_FILE = path.join(process.cwd(), "data", "job-searches.json");

export interface SavedSearch {
  id: string;
  query: string;
  location: string;
  active: boolean;
  createdAt: string;
}

export function loadSearches(): SavedSearch[] {
  try {
    if (fs.existsSync(SEARCHES_FILE)) {
      return JSON.parse(fs.readFileSync(SEARCHES_FILE, "utf-8"));
    }
  } catch { /* corrupt — return empty */ }
  return [];
}

export function saveSearches(searches: SavedSearch[]): void {
  const dir = path.dirname(SEARCHES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEARCHES_FILE, JSON.stringify(searches, null, 2) + "\n", "utf-8");
}

// ── Secrets ─────────────────────────────────────────────────────────────────

const SECRETS_FILE = path.join(process.cwd(), "..", "config", "secrets.env");

/** Read a key from config/secrets.env, falling back to process.env. */
export function readSecret(name: string): string | null {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(new RegExp(`^${name}=(.*)`));
      if (m) {
        let v = m[1] ?? "";
        if (
          v.length >= 2 &&
          ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'")))
        )
          v = v.slice(1, -1);
        v = v.trim();
        if (v && !v.toLowerCase().includes("xxxx") && !v.toLowerCase().startsWith("your"))
          return v;
      }
    }
  } catch { /* file missing — fall through */ }
  return process.env[name]?.trim() || null;
}
