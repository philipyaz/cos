// The "fitness" add-on's coaching-artifact VALIDATORS — the single chokepoint that turns
// a raw HTTP/MCP body (or a board generate-route's output) into a store-ready artifact input.
// NEVER persist raw unvalidated model output: every write of a CoachingArtifact goes through
// validateCoachingArtifactInput first (the routes call it, the generate routes call it on
// persist-on-generate). Pure (no I/O), so it is safe to import from anywhere.
//
// The four kinds share ONE record (CoachingArtifact) keyed by (kind, periodKey). This module
// owns BOTH the per-kind minimal required-field checks ("is this actually a plan / review /
// brief / correlation report, not garbage?") and the periodKey derivation (the upsert key).

import { VALID_COACHING_ARTIFACT_KIND, VALID_ARTIFACT_SOURCE } from "@/lib/types";
import type { CoachingArtifactKind, ArtifactSource } from "@/lib/types";

// A "YYYY-MM-DD" calendar-day string check (the brief's periodKey + the date field shape).
function isYmd(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Derive the UNIQUE periodKey for an artifact (the upsert key per kind).
 *   - an explicit non-empty `explicit` always wins (the caller passed body.periodKey);
 *   - else training_plan/weekly_review → payload.week (must be a non-empty string);
 *   - else pre_workout_brief → payload.date when it is a YYYY-MM-DD string, else today;
 *   - else correlations → "<from>_<to>" when both payload.from + payload.to are present.
 * Returns null when it cannot be derived (the caller maps null → 400).
 */
export function derivePeriodKey(
  kind: CoachingArtifactKind,
  payload: Record<string, unknown>,
  explicit?: unknown,
): string | null {
  if (isNonEmptyString(explicit)) return explicit.trim();
  switch (kind) {
    case "training_plan":
    case "weekly_review":
      return isNonEmptyString(payload.week) ? (payload.week as string).trim() : null;
    case "pre_workout_brief":
      return isYmd(payload.date) ? (payload.date as string) : new Date().toISOString().slice(0, 10);
    case "correlations":
      return isNonEmptyString(payload.from) && isNonEmptyString(payload.to)
        ? `${(payload.from as string).trim()}_${(payload.to as string).trim()}`
        : null;
    default:
      return null;
  }
}

// The validated, store-ready artifact input (the exact shape upsertCoachingArtifact takes).
export interface CoachingArtifactInput {
  kind: CoachingArtifactKind;
  periodKey: string;
  source: ArtifactSource;
  payload: Record<string, unknown>;
  generatedAt: string;
}

// ── Per-kind minimal required-field checks ─────────────────────────────────────
// These guard "is this actually a <kind>, not raw garbage?" — the MINIMAL shape each
// surface's renderer + the upsert key need. They are deliberately permissive about the
// rich body (the generate routes already produced schema-valid JSON); they only assert the
// load-bearing fields. Each returns an error string on failure, or null on success.

function checkTrainingPlan(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.week)) return "training_plan payload.week must be a non-empty string";
  if (!Array.isArray(payload.days)) return "training_plan payload.days must be an array";
  return null;
}

function checkWeeklyReview(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.week)) return "weekly_review payload.week must be a non-empty string";
  if (typeof payload.overall_score !== "number") return "weekly_review payload.overall_score must be a number";
  return null;
}

function checkPreWorkoutBrief(payload: Record<string, unknown>): string | null {
  if (!["ready", "caution", "rest"].includes(payload.readiness as string)) {
    return "pre_workout_brief payload.readiness must be one of ready|caution|rest";
  }
  return null;
}

function checkCorrelations(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.points)) return "correlations payload.points must be an array";
  return null;
}

// Run the per-kind minimal required-field check. Reused by the generate routes' persist-on-
// generate (they already produced schema-valid JSON, but they still funnel it through here).
export function validateCoachingPayload(
  kind: CoachingArtifactKind,
  payload: Record<string, unknown>,
): string | null {
  switch (kind) {
    case "training_plan":
      return checkTrainingPlan(payload);
    case "weekly_review":
      return checkWeeklyReview(payload);
    case "pre_workout_brief":
      return checkPreWorkoutBrief(payload);
    case "correlations":
      return checkCorrelations(payload);
    default:
      return "unknown coaching artifact kind";
  }
}

/**
 * Validate a raw artifact body (HTTP POST / MCP / persist-on-generate) into a store-ready
 * input. NEVER persist raw unvalidated model output — this is the chokepoint. On success it
 * returns the coerced { kind, periodKey, source, payload, generatedAt }; on any failure a
 * { ok:false, error } the route maps to a 400.
 *   - body must be a non-null object; body.kind ∈ VALID_COACHING_ARTIFACT_KIND;
 *     body.payload a non-null object; the per-kind required fields present;
 *   - periodKey = derivePeriodKey(kind, payload, body.periodKey) (null → error);
 *   - source = body.source when ∈ VALID_ARTIFACT_SOURCE, else "agent";
 *   - generatedAt = payload.generated_at (a non-empty string) else now.
 */
export function validateCoachingArtifactInput(
  body: unknown,
): { ok: true; value: CoachingArtifactInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  if (!VALID_COACHING_ARTIFACT_KIND.includes(b.kind as CoachingArtifactKind)) {
    return { ok: false, error: `kind must be one of ${VALID_COACHING_ARTIFACT_KIND.join(", ")}` };
  }
  const kind = b.kind as CoachingArtifactKind;

  if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload)) {
    return { ok: false, error: "payload must be a non-null object" };
  }
  const payload = b.payload as Record<string, unknown>;

  const payloadErr = validateCoachingPayload(kind, payload);
  if (payloadErr) return { ok: false, error: payloadErr };

  const periodKey = derivePeriodKey(kind, payload, b.periodKey);
  if (!periodKey) return { ok: false, error: `could not derive periodKey for ${kind}` };

  const source: ArtifactSource = VALID_ARTIFACT_SOURCE.includes(b.source as ArtifactSource)
    ? (b.source as ArtifactSource)
    : "agent";

  const generatedAt =
    (typeof payload.generated_at === "string" && payload.generated_at) || new Date().toISOString();

  return { ok: true, value: { kind, periodKey, source, payload, generatedAt } };
}
