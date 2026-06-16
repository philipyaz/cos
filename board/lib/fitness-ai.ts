import { promises as fs } from "node:fs";
import path from "node:path";

// AI coaching helpers for the fitness surface. callClaude is a HARDENED single-shot call to the
// Anthropic Messages API that uses FORCED TOOL USE to get already-valid JSON back (no markdown
// fence stripping, no bare JSON.parse on free text), with a cache_control breakpoint on the
// STABLE system-prompt prefix so the volatile per-request health/nutrition data never invalidates
// the cache. The athlete profile is now read via getProfile() from @/lib/fitness (the store
// singleton) — this module no longer touches data/athlete.json directly.

// Read the Anthropic API key from config/secrets.env (the repo convention), falling back to the
// process env. Quotes are stripped; placeholder/empty values are rejected.
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

export type ClaudeJsonSchema = Record<string, unknown>;

export interface CallClaudeArgs {
  apiKey: string;
  // The STABLE coaching instructions — the part of the system prompt that does NOT vary per
  // request. A cache_control breakpoint is placed at the end of this block.
  stableSystem: string;
  // The VOLATILE per-request context (profile, health data, nutrition data, dates) appended
  // AFTER the cached prefix so it never invalidates the cache.
  volatileSystem: string;
  // The user turn.
  userMessage: string;
  // The forced tool: its name, a one-line description, and the JSON schema the model must fill.
  toolName: string;
  toolDescription: string;
  schema: ClaudeJsonSchema;
}

type CallClaudeResult =
  | { json: Record<string, unknown> }
  | { error: string; status: number; raw?: string };

// claude-sonnet-4-6 — adaptive thinking only; supports forced tool use + prompt caching. The
// model is conformant per the lead's decision (do not downgrade/upgrade it).
const MODEL = "claude-sonnet-4-6";

export async function callClaude(args: CallClaudeArgs): Promise<CallClaudeResult> {
  const { apiKey, stableSystem, volatileSystem, userMessage, toolName, toolDescription, schema } = args;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        // System is an array of text blocks: the STABLE coaching prefix carries a
        // cache_control breakpoint (render order tools → system → messages, so the tool +
        // this prefix cache together); the VOLATILE data block follows it uncached.
        system: [
          { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
          { type: "text", text: volatileSystem },
        ],
        // FORCED TOOL USE: the tool's input_schema IS the expected JSON; tool_choice forces it,
        // so the response carries a tool_use block whose `input` is already valid JSON — no
        // fence-stripping, no JSON.parse on free text.
        tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
        tool_choice: { type: "tool", name: toolName },
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "Unknown error");
      return { error: `Anthropic API error (${res.status}): ${err}`, status: 502 };
    }

    const data = await res.json();

    // A max_tokens truncation can cut the forced tool call mid-JSON → a clear, specific error
    // rather than a generic 502 the caller can't act on.
    if (data.stop_reason === "max_tokens") {
      return {
        error: "The AI response was cut off (max_tokens reached). Try again or reduce the input.",
        status: 502,
      };
    }

    const toolUse = Array.isArray(data.content)
      ? data.content.find((b: { type?: string }) => b.type === "tool_use")
      : undefined;

    if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
      return {
        error: `The AI did not return the expected structured result (stop_reason: ${data.stop_reason ?? "unknown"}).`,
        status: 502,
      };
    }

    return { json: toolUse.input as Record<string, unknown> };
  } catch (e) {
    return {
      error: `Failed to call Anthropic API: ${e instanceof Error ? e.message : String(e)}`,
      status: 502,
    };
  }
}

// ── date utilities (shared by the coaching routes) ─────────────────────────────

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
