import { NextResponse } from "next/server";
import { loadSearches, loadJobs, saveJobs, hashUrl, readSecret, type JobEntry } from "@/lib/jobs-store";
import fs from "fs";
import path from "path";

const BOARD_URL = process.env.BOARD_URL || "http://localhost:3000";
const PROFILE_FILE = path.join(process.cwd(), "data", "candidate-profile.json");
const SCORE_THRESHOLD = 50;

function loadProfile(): string | null {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, "utf8");
    const profile = JSON.parse(raw);
    return profile.rawContent || null;
  } catch {
    return null;
  }
}

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
}

function extractCompany(title: string, url: string): string {
  const atMatch = title.match(/\b(?:at|chez|@)\s+(.+?)(?:\s*[-\u2013|]|$)/i);
  if (atMatch) return atMatch[1].trim();
  const parts = title.split(/\s*[-\u2013|]\s*/);
  if (parts.length >= 2) return parts[1].trim();
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function scrapeExa(query: string, location: string, apiKey: string): Promise<ExaResult[]> {
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query: `offres emploi ${query} ${location}`,
        num_results: 10,
        use_autoprompt: true,
        type: "neural",
        contents: { text: true },
      }),
    });
    if (!res.ok) {
      console.error(`[daily-scan] Exa ${res.status}: ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    console.error(`[daily-scan] Exa error: ${(e as Error).message}`);
    return [];
  }
}

async function analyzeJob(profile: string, job: JobEntry): Promise<{ match_score: number; strengths: string[]; gaps: string[]; recommendation: string; cover_letter_hook: string } | null> {
  const apiKey = readSecret("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

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
  "strengths": ["<point fort 1>", "<point fort 2>"],
  "gaps": ["<lacune 1>", "<lacune 2>"],
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
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

async function createReminder(job: JobEntry) {
  try {
    await fetch(`${BOARD_URL}/api/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-actor": "agent" },
      body: JSON.stringify({
        title: `\u{1F4BC} Nouveau match job: ${job.title} chez ${job.company} (${job.match_score}/100)`,
        body: `${job.match_analysis?.cover_letter_hook || ""}\n\n${job.url}`,
        domain: "work",
        actor: "agent",
      }),
    });
  } catch (e) {
    console.error(`[daily-scan] reminder error: ${(e as Error).message}`);
  }
}

// GET /api/jobs/daily-scan — run all active saved searches
export async function GET() {
  const searches = loadSearches().filter((s) => s.active);
  if (searches.length === 0) {
    return NextResponse.json({ scanned: 0, new_jobs: 0, above_threshold: 0, message: "Aucune recherche active." });
  }

  const exaKey = readSecret("EXA_API_KEY");
  if (!exaKey) {
    return NextResponse.json({ error: "EXA_API_KEY not configured" }, { status: 500 });
  }

  const profile = loadProfile();
  const db = loadJobs();
  const existingIds = new Set(db.entries.map((e) => e.id));

  let totalScanned = 0;
  let newJobs = 0;
  let aboveThreshold = 0;
  const newEntries: JobEntry[] = [];

  // Scrape all active searches
  for (const search of searches) {
    const results = await scrapeExa(search.query, search.location, exaKey);
    totalScanned += results.length;

    for (const r of results) {
      if (!r.url) continue;
      const id = hashUrl(r.url);
      if (existingIds.has(id)) continue;

      const entry: JobEntry = {
        id,
        ts: new Date().toISOString(),
        title: r.title || "",
        company: extractCompany(r.title || "", r.url),
        location: search.location,
        url: r.url,
        description: (r.text || "").slice(0, 500),
        source: "exa",
        match_score: null,
        match_analysis: null,
        status: "new",
      };

      db.entries.push(entry);
      existingIds.add(id);
      newEntries.push(entry);
      newJobs++;
    }
  }

  saveJobs(db);

  // Analyze new entries if profile is available
  if (profile && newEntries.length > 0) {
    for (const entry of newEntries) {
      const analysis = await analyzeJob(profile, entry);
      if (analysis) {
        entry.match_score = analysis.match_score;
        entry.match_analysis = analysis;
        entry.status = "reviewed";

        if (analysis.match_score >= SCORE_THRESHOLD) {
          aboveThreshold++;
          await createReminder(entry);
        }
      }
    }
    saveJobs(db);
  }

  console.log(`[daily-scan] scanned=${totalScanned} new=${newJobs} above_threshold=${aboveThreshold}`);

  return NextResponse.json({
    scanned: totalScanned,
    new_jobs: newJobs,
    above_threshold: aboveThreshold,
    searches_run: searches.length,
    profile_available: !!profile,
  });
}
