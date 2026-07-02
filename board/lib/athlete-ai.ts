import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.COS_DATA_DIR || path.join(process.cwd(), "data");
const ATHLETE_FILE = path.join(DATA_DIR, "athlete.json");

export async function readAthlete(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(ATHLETE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function readApiKey(): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "..", "config", "secrets.env"),
      "utf8",
    );
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^ANTHROPIC_API_KEY=(.*)$/);
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
  } catch {}
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export async function callClaude(
  apiKey: string,
  system: string,
  userMessage: string,
): Promise<{ json: Record<string, unknown> } | { error: string; status: number; raw?: string }> {
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
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      return { error: `Anthropic API error (${res.status}): ${err}`, status: 502 };
    }

    const data = await res.json();
    const text: string = data.content?.[0]?.text ?? "";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    try {
      return { json: JSON.parse(cleaned) };
    } catch {
      return { error: "Failed to parse JSON from LLM response.", status: 502, raw: text };
    }
  } catch (e) {
    return {
      error: `Failed to call Anthropic API: ${e instanceof Error ? e.message : String(e)}`,
      status: 502,
    };
  }
}

export function isoWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function last7DaysFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

export function healthEntryToSummary(e: { ts: string; data: Record<string, unknown> }) {
  const meta =
    e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>)
      : {};
  return { ts: e.ts, date: e.ts.slice(0, 10), data: e.data, meta };
}
