import { NextResponse } from "next/server";
import { loadJobs, saveJobs, readSecret, type JobEntry, type MatchAnalysis } from "@/lib/jobs-store";
import fs from "fs";
import path from "path";

const PROFILE_FILE = path.join(process.cwd(), "data", "candidate-profile.json");

function loadProfile(): string | null {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, "utf8");
    const profile = JSON.parse(raw);
    return profile.rawContent || null;
  } catch {
    return null;
  }
}

async function analyzeWithClaude(
  profile: string,
  job: JobEntry
): Promise<MatchAnalysis | { error: string }> {
  const apiKey = readSecret("ANTHROPIC_API_KEY");
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
    if (!res.ok) {
      const errText = await res.text();
      return { error: `Claude API returned ${res.status}: ${errText}` };
    }
    const data = await res.json();
    const responseText = data.content?.[0]?.text || "";
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "Could not parse Claude response as JSON" };
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { error: `Claude analysis failed: ${(e as Error).message}` };
  }
}

export async function POST(request: Request) {
  const body = await request.json();
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";

  if (!jobId) {
    return NextResponse.json({ error: "job_id is required" }, { status: 400 });
  }

  const db = loadJobs();
  const job = db.entries.find((e) => e.id === jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const profile = loadProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Aucun profil candidat. Importez votre CV d'abord via /profile." },
      { status: 404 }
    );
  }

  const analysis = await analyzeWithClaude(profile, job);
  if ("error" in analysis) {
    return NextResponse.json({ error: analysis.error }, { status: 500 });
  }

  job.match_score = analysis.match_score;
  job.match_analysis = analysis;
  if (job.status === "new") job.status = "reviewed";
  saveJobs(db);

  return NextResponse.json({ entry: job });
}
