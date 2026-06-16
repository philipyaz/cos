import { NextResponse } from "next/server";
import { listEntries, getProfile } from "@/lib/health";
import { readApiKey, callClaude, isoWeek, formatDate } from "@/lib/athlete-ai";

export const dynamic = "force-dynamic";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// The STABLE coaching instructions — invariant across requests, so they carry the cache_control
// breakpoint. The schema below is the forced-tool input_schema (the AI fills it directly).
const STABLE_SYSTEM = `You are an expert sports coach specialized in weekly training-plan design.
You generate a personalized weekly training plan as structured data.

Rules:
- Respect the athlete's constraints: available sports, equipment, days available per week, and max session duration.
- If available days < 7, the remaining days are "rest" or "active_recovery".
- Adapt intensity to the recovery state (HRV, sleep, recent load).
- Evaluate recovery_status: "good" if HRV is stable/high and sleep is good, "moderate" if average, "poor" if HRV is low or sleep is bad.
- The "zones" field describes the effort zones (Z1-Z5) or RPE.
- Favor gradual progression and injury prevention.
- For a triathlon goal, alternate the three disciplines.
- For weight loss, favor longer moderate sessions plus short HIIT.`;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    week: { type: "string", description: "ISO week, e.g. 2026-W25" },
    generated_at: { type: "string", description: "ISO timestamp" },
    recovery_status: { type: "string", enum: ["good", "moderate", "poor"] },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          day: { type: "string", description: "Monday|Tuesday|..." },
          type: { type: "string", enum: ["training", "rest", "active_recovery"] },
          sport: { type: "string", description: "sport name or 'Rest'" },
          duration_min: { type: "number" },
          intensity: { type: "string", enum: ["easy", "moderate", "hard"] },
          description: { type: "string", description: "detailed session description" },
          zones: { type: "string", description: "effort zones or RPE" },
        },
        required: ["date", "day", "type", "sport", "duration_min", "intensity", "description", "zones"],
      },
    },
    weekly_notes: { type: "string", description: "summary and advice for the week" },
  },
  required: ["week", "generated_at", "recovery_status", "days", "weekly_notes"],
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

  // Date-only boundaries so the filter works for both date-only ts ("2026-06-09") and full ISO.
  const fromDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })());
  const toDate = formatDate((() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })());
  const inRange = (e: { ts: string }) => e.ts >= fromDate && e.ts < toDate + "T";

  // Canonical types: sleep_night, hrv (NOT "heart_rate_variability"), workout.
  const [workouts, sleep, hrv] = await Promise.all([
    listEntries({ type: "workout", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "sleep_night", from: fromDate, to: toDate, limit: 0 }),
    listEntries({ type: "hrv", from: fromDate, to: toDate, limit: 0 }),
  ]);

  const healthSummary = {
    workouts: workouts.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      activity: e.data.activity,
      duration_min: e.data.duration_min,
      distance_km: e.data.distance_km,
      avg_hr: e.data.avg_hr,
      calories: e.data.calories,
    })),
    sleep: sleep.entries.filter(inRange).map((e) => {
      const meta = e.data.metadata && typeof e.data.metadata === "object"
        ? (e.data.metadata as Record<string, unknown>) : {};
      return {
        date: e.ts.slice(0, 10),
        duration_hours: e.data.value,
        deep_hours: meta.deep,
        rem_hours: meta.rem,
      };
    }),
    hrv: hrv.entries.filter(inRange).map((e) => ({
      date: e.ts.slice(0, 10),
      avg_ms: e.data.value,
    })),
  };

  const today = formatDate(new Date());
  const monday = nextMonday();
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return { date: formatDate(d), day: DAYS[i] };
  });

  const goalDate = profile.goalDate || undefined;
  let daysLeft = "";
  if (goalDate) {
    const diff = Math.ceil((new Date(goalDate).getTime() - new Date(today).getTime()) / 86400000);
    daysLeft = diff > 0 ? `${diff} days remaining` : "Goal date passed";
  }

  const volatileSystem = `# Athlete profile
${JSON.stringify(profile, null, 2)}

# Current date: ${today}
${goalDate ? `# Goal date: ${goalDate} (${daysLeft})` : "# No goal date set"}

# Last 7 days history (Apple Watch data)
${JSON.stringify(healthSummary, null, 2)}

# Week to plan
${JSON.stringify(weekDates, null, 2)}

# Use ISO week ${isoWeek(monday)} for the "week" field.
# Available days per week: ${profile.daysPerWeek ?? "not specified"}; max session: ${profile.maxSessionMinutes ?? "not specified"} min.`;

  const result = await callClaude({
    apiKey,
    stableSystem: STABLE_SYSTEM,
    volatileSystem,
    userMessage: "Generate the training plan for next week.",
    toolName: "submit_training_plan",
    toolDescription: "Submit the personalized weekly training plan.",
    schema: PLAN_SCHEMA,
  });

  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, ...(result.raw ? { raw: result.raw } : {}) },
      { status: result.status },
    );
  }

  return NextResponse.json({ plan: result.json });
}
