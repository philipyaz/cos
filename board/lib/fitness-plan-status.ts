// The deterministic RECONCILIATION status for the fitness add-on's training plans — the
// per-day twin of nutrition-status.ts's computeNutritionStatus. It answers "which past
// session days are still unanswered, and which of those a same-date workout entry already
// proves happened" from records ALREADY on the store (the artifact's own payload.days[] +
// db.healthEntries): nothing here is stored, nothing calls an LLM (ADR 0001 — the same
// server-side-arithmetic carve-out as the correlations stats and computeNutritionStatus).
// What to DO with the numbers — auto-close the proven subset, batch the rest into one
// question, decide whether a repeatedly-skipped slot should change next week — is the
// fitness-training-plan / fitness-pre-workout-brief skills' job; this module only computes,
// on every read, never persisted (ADR 0017).
//
// An ABSENT `status` on a day ≡ "planned" — every plan saved before this unit shipped is
// already valid, and nothing backfills. The universe is SESSION DAYS only: a DENY-list on
// `type` (`rest` / `active_recovery` are excluded; everything else counts, including a type
// this module has never seen) — the day-type enum is open (the skill mints values freely,
// e.g. `endurance`/`intervals`/`tempo`), so an ALLOW-list on `"training"` would silently
// drop every other session type, exactly the bug cos-ops#81's push route was built to avoid.
//
// A day is UNRESOLVED when it is a session day dated strictly BEFORE `today` (today's own
// session is not yet unresolved — it may still happen) and its effective status is still
// "planned". A day's `provenDone` is a `healthEntries` entry with `type === "workout"` whose
// `ts` date-prefix matches the day's date — first match by array order, one `healthEntryId`
// per day, DATE-LEVEL ONLY (no sport/activity matching: HAE `activity` strings and
// `VALID_ATHLETE_SPORT` are different vocabularies, and a fuzzy join would silently fail to
// prove a real workout — "a workout happened that day" is the honest provable claim).
//
// Pure, I/O-free, clock-free: the caller passes `today` as a "YYYY-MM-DD" string — the one
// seam where the clock is read, exactly like computeNutritionStatus / bodyBaseline. This
// module compares dates with plain STRICT LEXICOGRAPHIC string comparison — never a whole-day
// DIFF. If a whole-day diff is ever actually needed here, import `wholeDaysBetween` from
// `board/lib/staleness` — never mint a private one (that module's header names the last
// private day-diff, body-baseline's `dayDiff`, as deliberately killed).

import type { HealthEntry } from "./types";

export type PlanDayOutcome = "planned" | "done" | "skipped" | "moved";
export const VALID_PLAN_DAY_OUTCOME: PlanDayOutcome[] = ["planned", "done", "skipped", "moved"];

// DENY-list on `type` — true for every day EXCEPT "rest" / "active_recovery" (including a
// missing/garbled type: over-including is safer than silently dropping a real session, and
// the caller's own array guards handle genuinely garbage day entries). Mirrors the push
// route's inline `isRestDay` check; kept as one named predicate so both readers agree.
export function isSessionDay(day: { type?: unknown }): boolean {
  const type = typeof day?.type === "string" ? day.type : undefined;
  return type !== "rest" && type !== "active_recovery";
}

export interface PlanReconciliation {
  sessionDays: number; // deny-list days in the plan (the batched line's "N planned")
  outcomes: { done: number; skipped: number; moved: number; planned: number }; // over session days
  // ONE encoding of proof — each unresolved day carries its own provenDone flag + the
  // proving entry id; there is deliberately no separate top-level provenDone block.
  unresolvedDays: {
    count: number;
    days: { date: string; sport: string; type: string; provenDone: boolean; healthEntryId?: string }[];
  };
}

// Compute the reconciliation status. ALWAYS resolvable: a missing/non-array `days`, or a
// non-object/dateless day entry, contributes zero — never throws.
export function computePlanReconciliation(input: {
  payload: Record<string, unknown>; // the artifact payload (days read defensively)
  healthEntries: HealthEntry[];
  today: string; // "YYYY-MM-DD", injected by the shell
}): PlanReconciliation {
  const { payload, healthEntries, today } = input;
  const rawDays = Array.isArray(payload?.days) ? (payload.days as unknown[]) : [];

  const outcomes = { done: 0, skipped: 0, moved: 0, planned: 0 };
  const unresolvedDays: PlanReconciliation["unresolvedDays"]["days"] = [];
  let sessionDays = 0;

  for (const raw of rawDays) {
    if (!raw || typeof raw !== "object") continue;
    const day = raw as Record<string, unknown>;
    if (!isSessionDay(day)) continue;
    const date = typeof day.date === "string" ? day.date : undefined;
    if (!date) continue; // no date — nothing to reconcile against

    sessionDays++;
    const status: PlanDayOutcome = VALID_PLAN_DAY_OUTCOME.includes(day.status as PlanDayOutcome)
      ? (day.status as PlanDayOutcome)
      : "planned";
    outcomes[status]++;

    if (status === "planned" && date < today) {
      // First match by array order — one healthEntryId per day, date-level only.
      const proof = healthEntries.find((e) => e.type === "workout" && e.ts.slice(0, 10) === date);
      unresolvedDays.push({
        date,
        sport: typeof day.sport === "string" ? day.sport : "",
        type: typeof day.type === "string" ? day.type : "",
        provenDone: proof != null,
        ...(proof ? { healthEntryId: proof.id } : {}),
      });
    }
  }

  return {
    sessionDays,
    outcomes,
    unresolvedDays: { count: unresolvedDays.length, days: unresolvedDays },
  };
}
