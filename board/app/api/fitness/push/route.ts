import { NextResponse, type NextRequest } from "next/server";
import { pushEntries } from "@/lib/fitness";
import { storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/fitness/push — receive a batch of Apple Watch HealthKit entries.
// Token-gated: the x-fitness-token header must match FITNESS_PUSH_TOKEN from env.
// Entries are deduplicated by id. Entries older than 90 days are auto-purged.
export async function POST(req: NextRequest) {
  // ── Auth ──
  const token = (process.env.FITNESS_PUSH_TOKEN || "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Health push is not configured on the server." },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-fitness-token")?.trim();
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // ── Parse body ──
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // ── Normalize Health Auto Export formats ──
  // HAE sends two shapes depending on the export type:
  //   Workouts: { data: { workouts: [...] } }
  //   Metrics:  { data: { metrics: [ { name, units, data: [...] } ] } }
  // Also accept flat body.workouts / body.metrics / body.entries (native).
  if (!body.entries) {
    const converted: Record<string, unknown>[] = [];

    // Workouts
    const haeWorkouts =
      (body.data && Array.isArray(body.data.workouts) && body.data.workouts) ||
      (Array.isArray(body.workouts) && body.workouts) ||
      null;
    if (haeWorkouts) converted.push(...haeWorkouts.map(convertHAEWorkout));

    // Metrics (sleep, HRV, resting HR, steps, VO2max, etc.)
    const haeMetrics =
      (body.data && Array.isArray(body.data.metrics) && body.data.metrics) ||
      (Array.isArray(body.metrics) && body.metrics) ||
      null;
    if (haeMetrics) {
      converted.push(...haeMetrics.flatMap(convertHAEMetric));
    }

    if (converted.length > 0) body.entries = converted;
  }

  const raw = body.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json(
      { error: "Accepted shapes: { entries }, { data: { workouts } }, { data: { metrics } }, or combinations. None found or empty." },
      { status: 400 }
    );
  }

  // ── Validate each entry ──
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== "object") {
      return NextResponse.json({ error: `entries[${i}] must be an object.` }, { status: 400 });
    }
    if (typeof e.id !== "string" || e.id.trim() === "") {
      return NextResponse.json({ error: `entries[${i}].id is required.` }, { status: 400 });
    }
    if (typeof e.ts !== "string" || e.ts.trim() === "") {
      return NextResponse.json({ error: `entries[${i}].ts is required (ISO-8601).` }, { status: 400 });
    }
    // Normalize: Health Auto Export / iOS may send "Workout", "HRV", etc.
    if (typeof e.type === "string") e.type = e.type.toLowerCase();
    // Accept any non-empty string type — HAE can send metric names we don't
    // know yet and the converter maps known ones to our canonical types.
    // Rejecting unknowns would break whenever HAE adds a new export.
    if (typeof e.type !== "string" || e.type.trim() === "") {
      return NextResponse.json(
        { error: `entries[${i}].type is required as a non-empty string.` },
        { status: 400 }
      );
    }
    if (!e.data || typeof e.data !== "object") {
      return NextResponse.json({ error: `entries[${i}].data must be an object.` }, { status: 400 });
    }
  }

  // ── Persist ──
  // The add-on gate lives inside pushEntries (assertAddonEnabled in mutate): a
  // disabled "fitness" add-on throws NotFoundError → 404 via storeErrorToResponse.
  try {
    const result = await pushEntries(raw);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}

// ── Health Auto Export → native entry conversion ────────────────────────────

// Parse HAE's timestamp format "2026-02-27 11:01:27 +0100" into ISO-8601.
function parseHAETimestamp(raw: string): string {
  // Replace the space between date and time with "T", and the space before the
  // timezone offset with nothing, yielding "2026-02-27T11:01:27+0100" which
  // Date can parse. If that fails, return the raw string (validation catches it).
  const iso = raw.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})$/, "$1T$2$3");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

// ── HAE metric name → our HealthType mapping ────────────────────────────────
// HAE metric names are verbose HealthKit identifiers. We map the ones we know
// to our internal types; unknown metrics are stored verbatim so no data is lost.
const HAE_METRIC_MAP: Record<string, string> = {
  // HRV
  heart_rate_variability:      "hrv",
  heart_rate_variability_sdnn: "hrv",
  hrv_sdnn:                    "hrv",
  // Resting HR
  resting_heart_rate:          "resting_hr",
  // Steps
  step_count:                  "steps",
  // Sleep
  sleep_analysis:              "sleep",
  // VO2 Max
  vo2_max:                     "vo2max",
  vo2max:                      "vo2max",
  apple_exercise_time:         "active_exercise_time",
};

// Metrics that use SUM aggregation per day (additive counts / energy).
const SUM_METRICS = new Set(["step_count", "steps", "active_energy_burned", "active_energy"]);
// Metrics that use AVG aggregation per day.
const AVG_METRICS = new Set([
  "heart_rate", "heart_rate_variability", "heart_rate_variability_sdnn", "hrv_sdnn",
  "resting_heart_rate", "vo2_max", "vo2max",
]);
// Metrics that use LAST aggregation per day (take the final data point).
const LAST_METRICS = new Set(["sleep_analysis"]);

// Classify a sleep dataPoint as night or nap based on sleepStart hour.
// Night: 20:00–05:59, Nap: 06:00–19:59.
function classifySleep(sleepStart: unknown): "sleep_night" | "sleep_nap" {
  if (typeof sleepStart !== "string") return "sleep_night"; // default to night
  const iso = parseHAETimestamp(sleepStart);
  const hour = new Date(iso).getHours();
  return (hour >= 20 || hour < 6) ? "sleep_night" : "sleep_nap";
}

// Extract the hour (HH) from an HAE timestamp for use in nap IDs.
function extractHour(sleepStart: unknown): string {
  if (typeof sleepStart !== "string") return "00";
  const iso = parseHAETimestamp(sleepStart);
  return new Date(iso).getHours().toString().padStart(2, "0");
}

// Map an HAE metric to ONE entry PER metric PER DAY. Data points are grouped by
// calendar day, aggregated (sum / avg / last), and raw points kept in metadata.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HAE payloads are untyped
function convertHAEMetric(m: Record<string, any>): Record<string, unknown>[] {
  if (!m || typeof m !== "object") return [];
  const rawName = typeof m.name === "string" ? m.name : "";
  const points = Array.isArray(m.data) ? m.data : [];
  if (!rawName || points.length === 0) return [];

  const normalName = rawName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const ourType = HAE_METRIC_MAP[normalName] ?? normalName;

  // Group data points by calendar day (YYYY-MM-DD).
  // HAE re-sends the FULL history on every push, so keep ALL days — pushEntries
  // dedups by id (`<metric>_<day>`), and dropping non-today days would lose any
  // day the watch didn't push on (a missed sync = permanent gap).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byDay = new Map<string, Array<Record<string, any>>>();
  for (const pt of points) {
    const rawDate = typeof pt.date === "string" ? parseHAETimestamp(pt.date) : "";
    const day = rawDate.slice(0, 10); // "YYYY-MM-DD"
    if (!day) continue;
    let arr = byDay.get(day);
    if (!arr) { arr = []; byDay.set(day, arr); }
    arr.push(pt);
  }

  // One entry per day
  const results: Record<string, unknown>[] = [];
  for (const [day, dayPoints] of byDay) {
    const id = `${normalName}_${day}`;
    const ts = day; // YYYY-MM-DD

    let value: number | undefined;
    const metadata: Record<string, unknown> = { dataPoints: dayPoints };

    if (LAST_METRICS.has(normalName)) {
      // Sleep: split into night vs nap based on sleepStart hour.
      // Each dataPoint becomes its own entry — skip the generic aggregation.
      for (const pt of dayPoints) {
        const sleepType = classifySleep(pt.sleepStart);
        const sleepId = sleepType === "sleep_night"
          ? `sleep_night_${day}`
          : `sleep_nap_${day}_${extractHour(pt.sleepStart)}`;
        const ptValue = typeof pt.totalSleep === "number" ? pt.totalSleep : undefined;
        results.push({
          id: sleepId,
          ts: day,
          type: sleepType,
          data: {
            value: ptValue,
            source: "Health Auto Export",
            metadata: {
              deep: pt.deep,
              rem: pt.rem,
              core: pt.core,
              awake: pt.awake,
              totalSleep: pt.totalSleep,
              sleepStart: pt.sleepStart,
              sleepEnd: pt.sleepEnd,
              dataPoints: [pt],
            },
          },
        });
      }
      continue; // skip the generic push below
    } else {
      const qtys = dayPoints
        .map((pt: Record<string, unknown>) => (typeof pt.qty === "number" ? pt.qty : NaN))
        .filter((n: number) => Number.isFinite(n));

      if (SUM_METRICS.has(normalName)) {
        value = qtys.reduce((s: number, n: number) => s + n, 0);
      } else if (AVG_METRICS.has(normalName)) {
        value = qtys.length ? qtys.reduce((s: number, n: number) => s + n, 0) / qtys.length : undefined;
      } else {
        // Unknown metric — default to avg
        value = qtys.length ? qtys.reduce((s: number, n: number) => s + n, 0) / qtys.length : undefined;
      }
    }

    results.push({
      id,
      ts,
      type: ourType,
      data: {
        value,
        source: "Health Auto Export",
        metadata,
      },
    });
  }
  return results;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HAE payloads are untyped
function convertHAEWorkout(w: Record<string, any>): Record<string, unknown> {
  const start = typeof w.start === "string" ? parseHAETimestamp(w.start) : "";
  const end = typeof w.end === "string" ? parseHAETimestamp(w.end) : "";

  // Duration in minutes from start/end
  let durationMin: number | undefined;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (Number.isFinite(ms) && ms > 0) durationMin = Math.round(ms / 60000);
  }

  // Energy: try activeEnergyBurned, activeEnergy, totalEnergy (HAE varies).
  // Value is usually kJ — convert to kcal (÷ 4.184) unless units say "kcal".
  const energySrc = w.activeEnergyBurned ?? w.activeEnergy ?? w.totalEnergy;
  let calories: number | undefined;
  if (energySrc && typeof energySrc === "object" && typeof energySrc.qty === "number") {
    const unit = typeof energySrc.units === "string" ? energySrc.units.toLowerCase() : "kj";
    calories = Math.round(unit === "kcal" ? energySrc.qty : energySrc.qty / 4.184);
  }

  // Heart rate: try avgHeartRate, then heartRateData.avg, then heartRate.avg.
  const avgHR = w.avgHeartRate ?? w.heartRateData?.avg ?? w.heartRate?.avg;
  let avgHrBpm: number | undefined;
  if (avgHR && typeof avgHR === "object" && typeof avgHR.qty === "number") {
    avgHrBpm = Math.round(avgHR.qty);
  } else if (typeof avgHR === "number") {
    avgHrBpm = Math.round(avgHR);
  }

  // Heart rate min/max (metadata)
  const hrMin = w.heartRate?.min ?? w.heartRateData?.min;
  const hrMax = w.heartRate?.max ?? w.heartRateData?.max;

  // Distance: try distance, then cyclingDistance (HAE cycling-specific field).
  const distSrc = w.distance ?? w.cyclingDistance;
  let distanceKm: number | undefined;
  if (distSrc && typeof distSrc === "object" && typeof distSrc.qty === "number") {
    // Normalize to km: HAE may send "mi" or "km"
    const unit = typeof distSrc.units === "string" ? distSrc.units.toLowerCase() : "km";
    const raw = distSrc.qty;
    distanceKm = Math.round((unit === "mi" ? raw * 1.60934 : raw) * 100) / 100;
  }

  // Speed (metadata, preserved as-is)
  const speed = w.speed;

  return {
    id: typeof w.id === "string" ? w.id : `hae-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: start,
    type: "workout",
    data: {
      activity: typeof w.name === "string" ? w.name : "unknown",
      duration_min: durationMin,
      calories,
      avg_hr: avgHrBpm,
      hr_min: hrMin && typeof hrMin.qty === "number" ? Math.round(hrMin.qty) : undefined,
      hr_max: hrMax && typeof hrMax.qty === "number" ? Math.round(hrMax.qty) : undefined,
      distance_km: distanceKm,
      speed_kmh: speed && typeof speed === "object" && typeof speed.qty === "number"
        ? Math.round(speed.qty * 100) / 100
        : undefined,
      source: "Health Auto Export",
    },
  };
}
