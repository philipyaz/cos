// Unit tests for board/lib/staleness.ts — the shared home for the whole-day-difference
// idiom (wholeDaysBetween) and the unified idle threshold (STALE_AFTER_DAYS). Pure,
// deterministic, no clock, no disk — runs headless under `node --test`.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/staleness.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { wholeDaysBetween, STALE_AFTER_DAYS } from "../../board/lib/staleness.ts";

test("STALE_AFTER_DAYS is ratified at 3", () => {
  assert.equal(STALE_AFTER_DAYS, 3);
});

test("wholeDaysBetween: basics", async (t) => {
  await t.test("same day → 0", () => {
    assert.equal(wholeDaysBetween("2026-05-31", "2026-05-31"), 0);
  });

  await t.test("adjacent day → 1", () => {
    assert.equal(wholeDaysBetween("2026-05-31", "2026-06-01"), 1);
  });

  await t.test("reversed order → negative", () => {
    assert.equal(wholeDaysBetween("2026-06-01", "2026-05-31"), -1);
  });

  await t.test("month boundary", () => {
    assert.equal(wholeDaysBetween("2026-01-31", "2026-02-01"), 1);
  });

  await t.test("year boundary", () => {
    assert.equal(wholeDaysBetween("2025-12-31", "2026-01-01"), 1);
  });

  await t.test("leap day: 2024-02-28 → 2024-03-01 spans the 29th", () => {
    assert.equal(wholeDaysBetween("2024-02-28", "2024-03-01"), 2);
  });

  await t.test("non-leap year: 2025-02-28 → 2025-03-01 has no 29th, so it's 1 day", () => {
    assert.equal(wholeDaysBetween("2025-02-28", "2025-03-01"), 1);
  });
});

// The swap-safety identity — the regression this module's header promises: for any two
// "YYYY-MM-DD" strings, the surviving UTC-MIDNIGHT-floor arithmetic (wholeDaysBetween)
// agrees EXACTLY with the RETIRED UTC-NOON-anchored + Math.round arithmetic that
// body-baseline.ts's private `dayDiff` used before this change. The +12h cancels in
// subtraction and UTC has no DST, so both differences are exact multiples of
// 86_400_000 — floor and round agree on every input. This is the test that fails if
// anyone ever "simplifies" the surviving helper into a genuinely different rounding.
function retiredNoonRoundedDiff(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map((s) => parseInt(s, 10));
  const [ty, tm, td] = toDay.split("-").map((s) => parseInt(s, 10));
  const from = Date.UTC(fy, fm - 1, fd, 12, 0, 0);
  const to = Date.UTC(ty, tm - 1, td, 12, 0, 0);
  return Math.round((to - from) / 86_400_000);
}

test("wholeDaysBetween: swap-safety identity vs the retired noon-anchored+rounded arithmetic", () => {
  const pairs: [string, string][] = [
    ["2026-05-31", "2026-05-31"], // same day
    ["2026-05-31", "2026-06-01"], // adjacent
    ["2026-06-01", "2026-05-31"], // reversed
    ["2026-03-07", "2026-03-08"], // US DST spring-forward date
    ["2026-03-08", "2026-03-15"], // spans the US DST spring-forward date
    ["2026-11-01", "2026-11-02"], // US DST fall-back date
    ["2026-10-25", "2026-11-01"], // spans the US DST fall-back date
    ["2025-12-31", "2026-01-01"], // year end
    ["2026-01-01", "2025-12-31"], // year end, reversed
    ["2024-02-28", "2024-03-01"], // leap year February
    ["2025-02-28", "2025-03-01"], // non-leap year February
    ["2000-02-28", "2000-03-01"], // century leap year (divisible by 400)
    ["1900-02-28", "1900-03-01"], // century non-leap year (divisible by 100, not 400)
    ["2026-01-01", "2027-01-01"], // full year span
  ];
  for (const [a, b] of pairs) {
    assert.equal(wholeDaysBetween(a, b), retiredNoonRoundedDiff(a, b), `${a} → ${b}`);
  }
});
