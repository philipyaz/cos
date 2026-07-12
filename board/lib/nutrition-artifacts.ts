// The "nutrition" add-on's AGENT-AUTHORED nutrition-targets VALIDATOR — the chokepoint that turns a
// raw HTTP/MCP body into a store-ready artifact input. NEVER persist raw unvalidated model output:
// every save_nutrition_targets write funnels through validateNutritionTargetInput first. PURE (no I/O,
// no db, no clock — `todayYmd` is injected), so it is safe to import from anywhere. The 1:1 nutrition
// twin of lib/fitness-artifacts.ts; the board validates the SHAPE only — the calories/macros inside
// `payload` are the agent's authored body, stored verbatim. The one SAFETY check (lowCalorieWarn) runs
// in the route/store layer (it needs db → sex) and is returned as a sibling field, never folded in here.

import { VALID_NUTRITION_TARGET_KIND, VALID_ARTIFACT_SOURCE } from "@/lib/types";
import type { NutritionTargetKind, ArtifactSource } from "@/lib/types";

function isYmd(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// The validated, store-ready input (the exact shape upsertNutritionTarget takes).
export interface NutritionTargetInput {
  kind: NutritionTargetKind;
  periodKey: string;
  source: ArtifactSource;
  payload: Record<string, unknown>;
  generatedAt: string;
}

// Derive the UNIQUE periodKey (the upsert key per kind). An explicit non-empty body.periodKey wins;
// else daily_targets → payload.date when a YYYY-MM-DD string, else the injected `todayYmd`. Clock-free
// (the route supplies its own today). Returns null when it cannot be derived (caller maps null → 400).
export function deriveNutritionPeriodKey(
  kind: NutritionTargetKind,
  payload: Record<string, unknown>,
  explicit: unknown,
  todayYmd: string,
): string | null {
  if (isNonEmptyString(explicit)) return explicit.trim();
  switch (kind) {
    case "daily_targets":
      return isYmd(payload.date) ? (payload.date as string) : isYmd(todayYmd) ? todayYmd : null;
    default:
      return null;
  }
}

// Per-kind minimal required-field check — deliberately permissive about the rich body, asserting only
// the load-bearing field. Returns an error string on failure, or null on success.
function checkDailyTargets(payload: Record<string, unknown>): string | null {
  if (typeof payload.daily_calories !== "number" || !Number.isFinite(payload.daily_calories)) {
    return "daily_targets payload.daily_calories must be a finite number";
  }
  return null;
}

export function validateNutritionTargetPayload(
  kind: NutritionTargetKind,
  payload: Record<string, unknown>,
): string | null {
  switch (kind) {
    case "daily_targets":
      return checkDailyTargets(payload);
    default:
      return "unknown nutrition target kind";
  }
}

// Validate a raw artifact body into a store-ready input. On success returns the coerced
// { kind, periodKey, source, payload, generatedAt }; on any failure { ok:false, error } (route → 400).
//   - body must be a non-null object; body.kind defaults to "daily_targets" (the only v1 kind);
//   - body.payload a non-null object with the per-kind required field;
//   - periodKey = deriveNutritionPeriodKey(kind, payload, body.periodKey, todayYmd) (null → error);
//   - source = body.source when ∈ VALID_ARTIFACT_SOURCE, else "agent";
//   - generatedAt = payload.generated_at (non-empty string) else a periodKey-anchored midnight (clock-free).
export function validateNutritionTargetInput(
  body: unknown,
  todayYmd: string,
): { ok: true; value: NutritionTargetInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  const kind = (b.kind === undefined ? "daily_targets" : b.kind) as NutritionTargetKind;
  if (!VALID_NUTRITION_TARGET_KIND.includes(kind)) {
    return { ok: false, error: `kind must be one of ${VALID_NUTRITION_TARGET_KIND.join(", ")}` };
  }

  if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload)) {
    return { ok: false, error: "payload must be a non-null object" };
  }
  const payload = b.payload as Record<string, unknown>;

  const payloadErr = validateNutritionTargetPayload(kind, payload);
  if (payloadErr) return { ok: false, error: payloadErr };

  const periodKey = deriveNutritionPeriodKey(kind, payload, b.periodKey, todayYmd);
  if (!periodKey) return { ok: false, error: `could not derive periodKey for ${kind}` };

  const source: ArtifactSource = VALID_ARTIFACT_SOURCE.includes(b.source as ArtifactSource)
    ? (b.source as ArtifactSource)
    : "agent";

  const generatedAt =
    (typeof payload.generated_at === "string" && payload.generated_at) || `${periodKey}T00:00:00.000Z`;

  return { ok: true, value: { kind, periodKey, source, payload, generatedAt } };
}
