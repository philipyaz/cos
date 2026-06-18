import { NextResponse } from "next/server";
import { loadJobs, saveJobs, hashUrl, readSecret } from "@/lib/jobs-store";

// ── Exa.ai search ────────────────────────────────────────────────────────────

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  author?: string;
}

/** Try to extract a company name from a job title like "Software Engineer at Acme Corp"
 *  or "Data Scientist - Google - Zurich". Falls back to the domain name. */
function extractCompany(title: string, url: string): string {
  // "… at Company" / "… chez Company"
  const atMatch = title.match(/\b(?:at|chez|@)\s+(.+?)(?:\s*[-–|]|$)/i);
  if (atMatch) return atMatch[1].trim();
  // "Title - Company - Location" (common pattern)
  const parts = title.split(/\s*[-–|]\s*/);
  if (parts.length >= 2) return parts[1].trim();
  // Fallback: domain
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function searchExa(
  query: string,
  location: string,
  limit: number
): Promise<RawJob[]> {
  const apiKey = readSecret("EXA_API_KEY");
  if (!apiKey) {
    console.error("[jobs/scrape] EXA_API_KEY not set");
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
      const errText = await res.text();
      console.error(`[jobs/scrape] Exa API returned ${res.status}: ${errText}`);
      return [];
    }

    const data = await res.json();
    const results: ExaResult[] = data.results || [];

    return results
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title || "",
        company: extractCompany(r.title || "", r.url || ""),
        location,
        url: r.url!,
        description: (r.text || "").slice(0, 500),
        source: "exa",
      }));
  } catch (e) {
    console.error(`[jobs/scrape] Exa error: ${(e as Error).message}`);
    return [];
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RawJob {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  source: string;
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = await request.json();
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 10;

  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  if (!location) {
    return NextResponse.json({ error: "location is required" }, { status: 400 });
  }

  if (!readSecret("EXA_API_KEY")) {
    return NextResponse.json(
      { error: "EXA_API_KEY not configured in config/secrets.env" },
      { status: 500 }
    );
  }

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

  return NextResponse.json({
    exa: exaResults.length,
    added,
    total: db.entries.length,
  });
}
