// THE STALENESS VOCABULARY — the one named home for "what hasn't been done" across the board.
// ADR 0017 recorded that a staleness / recency / attention read is COMPUTED ON EVERY READ from
// records the board already owns, and NEVER PERSISTED — a stored staleness flag is wrong the
// moment nobody rewrites it. The shape every instance follows: a pure engine function with the
// clock (`now`/`today`) injected, a thin `force-dynamic` route returning the read + `version`,
// one MCP tool, a unit test, and an api test. Worked examples: `nutrition-status.ts` +
// `/api/nutrition/status`, `selectVaultCoverage` + `/api/cases/vault-coverage`, and now
// `needsAttention` (`./selectors`) + `/api/cases/needs-attention`. VARIANT: a computed read may
// instead ride an EXISTING domain GET when the issue forbids a new route — cos-ops#19's fitness
// reconciliation (riding the existing `GET /api/fitness/coaching/[id]`) is the worked example.
//
// This module owns the VOCABULARY — the whole-day-difference idiom + the idle thresholds + this
// rule — not an engine registry. Each status read's engine stays in its own domain module
// (nutrition-status, body-baseline, selectors, and fitness-plan-status keep their own modules;
// they do not move here — the fitness read compares dates with strict lexicographic string
// comparison and imports `wholeDaysBetween` only if a whole-day diff there is ever actually
// needed). Whole-day differences over "YYYY-MM-DD" strings use
// `wholeDaysBetween` below — NEVER mint a private day-diff (the last private one, body-baseline's
// `dayDiff`, died in this change). Idle thresholds are named constants here, never inline numbers.
//
// Two frames that never compose — pick the one that matches your input, never mix them in one
// predicate:
//   (a) `wholeDaysBetween` answers in CALENDAR DAYS: a UTC-midnight floor over "YYYY-MM-DD"
//       strings (nutrition-status's daysSince* figures).
//   (b) `STALE_AFTER_DAYS` is consumed as ROLLING MILLISECONDS over ISO timestamps
//       (`now − updatedAt > STALE_AFTER_DAYS × 24h`, in `./selectors`).
//   The two frames disagree at boundaries by up to a day — pick the one that matches your input,
//   never mix them in one predicate.
//
// Perimeter: this rule covers `board/lib` only. Skill-prose staleness (e.g. reminders-review's
// ~15-day "cold" rule) is the other leg of ADR 0017's deliberately-unresolved fork and stays in
// skill prose, not here. `./format.ts`'s `slaLabel` repeats the floor-idle-days EXPRESSION (not a
// threshold) for display — knowingly out of scope.
//
// `addDays` (plain calendar-day projection, one home, no drift) deliberately STAYS in
// `./nutrition-format` — there is nothing drifted to fix there, so moving it would only grow the
// diff without removing a concept.
//
// No I/O, no clock, imports nothing app-specific — same purity contract as `./nutrition-format`
// (safe from server components, route handlers, AND client components alike).

// Whole-day difference (toDay − fromDay) between two "YYYY-MM-DD" strings, UTC-MIDNIGHT anchored
// (floor, not rounded) — the age-in-days arithmetic every staleness figure uses.
export function wholeDaysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map((s) => parseInt(s, 10));
  const [ty, tm, td] = toDay.split("-").map((s) => parseInt(s, 10));
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.floor((to - from) / 86_400_000);
}

// THE unified idle threshold (days). Was three different numbers under three names: 3
// (needsAttention's agingWaiting bucket), 5 (isStale's default), 5 (slaStatus's breach) — unified
// here at the tighter attention threshold per cos-ops#20 (the brief's direction is EARLIER agent
// detection, and agingWaiting's 3-day rule is the one becoming a public API contract at this
// moment). Measured zero live-membership change on the day it shipped: no case sat in the 3–5 day
// idle band on the live store. Also consumed by starvingObligations (./selectors) as the
// membership gate over open reminders and unanswered messages, and (via isStale) over cases —
// cos-ops#24's aging rank.
export const STALE_AFTER_DAYS = 3;
