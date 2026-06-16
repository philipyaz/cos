import { NextResponse } from "next/server";
import { listEntries, getProfile } from "@/lib/fitness";
import { computeFormScore } from "@/lib/fitness-score";
import { readApiKey, callClaude, formatDate } from "@/lib/fitness-ai";

export const dynamic = "force-dynamic";

function nextDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const STABLE_SYSTEM = `You are an expert sports coach. You analyze the athlete's current readiness
to produce a pre-workout brief as structured data.

Rules:
- readiness: "ready" if score >= 70 and good sleep, "caution" if score 40-70 or average sleep, "rest" if score < 40 or very poor sleep.
- recommended_session: propose a sport/duration/intensity adapted to the current state. Base it on the profile's sports.
- warnings: list the points of caution (fatigue, lack of sleep, high recent load).
- green_lights: list the positive indicators.
- one_liner: one short motivating or cautionary sentence depending on the state.`;

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    readiness: { type: "string", enum: ["ready", "caution", "rest"] },
    form_score: { type: "number" },
    recommended_session: {
      type: "object",
      properties: {
        sport: { type: "string" },
        duration_min: { type: "number" },
        intensity: { type: "string", enum: ["easy", "moderate", "hard"] },
        description: { type: "string" },
      },
      required: ["sport", "duration_min", "intensity", "description"],
    },
    warnings: { type: "array", items: { type: "string" } },
    green_lights: { type: "array", items: { type: "string" } },
    one_liner: { type: "string" },
  },
  required: ["readiness", "form_score", "recommended_session", "warnings", "green_lights", "one_liner"],
};

export async function GET() {
  const apiKey = await readApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured (config/secrets.env)." },
      { status: 500 },
    );
  }

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "No athlete profile found. Save your profile first at /athlete." },
      { status: 404 },
    );
  }

  const today = formatDate(new Date());
  const to = nextDate(today);
  const d2 = new Date(today + "T00:00:00Z");
  d2.setUTCDate(d2.getUTCDate() - 2);
  const from48h = formatDate(d2);

  // Form score for today — computed IN-PROCESS (no loopback fetch to /api/fitness/form-score).
  const formScore = await computeFormScore(today);

  const inRange = (from: string, toD: string) => (e: { ts: string }) =>
    e.ts >= from && e.ts < toD + "T";

  const [workoutsRes, sleepRes] = await Promise.all([
    listEntries({ type: "workout", from: from48h, to, limit: 0 }),
    listEntries({ type: "sleep_night", from: from48h, to, limit: 0 }),
  ]);

  const workouts = workoutsRes.entries.filter(inRange(from48h, to)).map((e) => ({
    date: e.ts.slice(0, 10),
    activity: e.data.activity,
    duration_min: num(e.data.duration_min),
    calories: num(e.data.calories),
    avg_hr: num(e.data.avg_hr),
  }));

  const sleepEntries = sleepRes.entries.filter(inRange(from48h, to));
  const lastSleep = sleepEntries.length > 0 ? (() => {
    const e = sleepEntries[0]; // newest first
    const meta = e.data.metadata && typeof e.data.metadata === "object"
      ? (e.data.metadata as Record<string, unknown>) : {};
    return {
      date: e.ts.slice(0, 10),
      total_h: num(e.data.value),
      deep_h: num(meta.deep),
      rem_h: num(meta.rem),
    };
  })() : null;

  const volatileSystem = `# Athlete profile
${JSON.stringify(profile, null, 2)}

# Today's form score
${JSON.stringify(formScore, null, 2)}

# Workouts, last 48 hours
${JSON.stringify(workouts, null, 2)}

# Last night's sleep
${JSON.stringify(lastSleep, null, 2)}

# Current date: ${today}`;

  const result = await callClaude({
    apiKey,
    stableSystem: STABLE_SYSTEM,
    volatileSystem,
    userMessage: "Analyze my current readiness and generate the pre-workout brief.",
    toolName: "submit_pre_workout_brief",
    toolDescription: "Submit the pre-workout readiness brief.",
    schema: BRIEF_SCHEMA,
  });

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  return NextResponse.json({ brief: result.json });
}
