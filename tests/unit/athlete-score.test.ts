// Unit tests for the pure "form score" sub-scorers (board/lib/athlete-score.ts) — the four
// I/O-free 0..100 sub-scorers that computeFormScore blends into the daily readiness score.
// computeFormScore itself reads the store via listEntries (not pure), so this suite drives
// ONLY the exported pure helpers — scoreHRV / scoreSleep / scoreRestingHR / scoreLoad — on
// in-memory inputs, never touching disk or a clock. Sibling of nutrition-targets.test.ts:
// pure logic, run headless under `node --test`.
//
// What it asserts (against the ACTUAL implementation):
//   • the NULL / no-data contract — a missing input (or a zero baseline) yields the neutral 50;
//   • the RATIO scorers (HRV today/baseline, restingHR baseline/today) scale + clamp to 0..100;
//   • the SLEEP piecewise — ≤6h floor (0), ≥8h ceil (100), the linear ramp between, plus the
//     deep-sleep ±10 bonus/penalty, all clamped;
//   • the LOAD step function — the <60 / ≤180 / ≤360 / >360 minute bands.
//
// Run from repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
//     --test tests/unit/athlete-score.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreHRV,
  scoreSleep,
  scoreRestingHR,
  scoreLoad,
} from "../../board/lib/athlete-score.ts";

// ── scoreHRV: today/baseline × 100, clamped; neutral 50 on missing/zero ─────────
test("scoreHRV: null inputs and a zero baseline fall back to the neutral 50", () => {
  assert.equal(scoreHRV(null, 60), 50, "no today value → neutral");
  assert.equal(scoreHRV(60, null), 50, "no baseline → neutral");
  assert.equal(scoreHRV(60, 0), 50, "a zero baseline (would divide by zero) → neutral");
});

test("scoreHRV: scales today/baseline to a 0..100 score and clamps the ends", () => {
  assert.equal(scoreHRV(60, 60), 100, "today == baseline → 100");
  assert.equal(scoreHRV(45, 60), 75, "today 75% of baseline → 75");
  assert.equal(scoreHRV(120, 60), 100, "well above baseline clamps at 100");
  assert.equal(scoreHRV(6, 60), 10, "today 10% of baseline → 10 (rounds, no clamp at the low end)");
});

// ── scoreSleep: piecewise on total hours + a deep-sleep adjustment ──────────────
test("scoreSleep: null total → neutral 50", () => {
  assert.equal(scoreSleep(null, null), 50, "no sleep total → neutral");
  assert.equal(scoreSleep(null, 1.5), 50, "deep alone, no total → still neutral");
});

test("scoreSleep: the ≤6 / ≥8 / linear-ramp piecewise on total hours", () => {
  assert.equal(scoreSleep(6, null), 0, "6h is the floor → 0");
  assert.equal(scoreSleep(5, null), 0, "below 6h stays at 0");
  assert.equal(scoreSleep(8, null), 100, "8h is the ceiling → 100");
  assert.equal(scoreSleep(9, null), 100, "above 8h stays at 100");
  assert.equal(scoreSleep(7, null), 50, "7h is the midpoint of the 6→8 ramp → 50");
});

test("scoreSleep: the deep-sleep bonus (+10) and penalty (−10), clamped", () => {
  // 7h base = 50; deep ≥ 1.5 adds 10 → 60.
  assert.equal(scoreSleep(7, 1.6), 60, "ample deep sleep adds the +10 bonus");
  // 7h base = 50; deep < 0.3 subtracts 10 → 40.
  assert.equal(scoreSleep(7, 0.2), 40, "scant deep sleep applies the −10 penalty");
  // 7h base = 50; deep in the neutral band (0.3..1.5) → no adjustment.
  assert.equal(scoreSleep(7, 0.8), 50, "mid-range deep sleep leaves the score unchanged");
  // The bonus can't push past 100: 8h base = 100, +10 → clamp 100.
  assert.equal(scoreSleep(8, 1.6), 100, "the deep bonus is clamped at 100");
});

// ── scoreRestingHR: baseline/today × 100 (lower RHR is better), clamped ─────────
test("scoreRestingHR: null inputs and a zero today fall back to the neutral 50", () => {
  assert.equal(scoreRestingHR(null, 60), 50, "no today value → neutral");
  assert.equal(scoreRestingHR(60, null), 50, "no baseline → neutral");
  assert.equal(scoreRestingHR(0, 60), 50, "a zero today RHR (would divide by zero) → neutral");
});

test("scoreRestingHR: lower-than-baseline RHR scores high; higher scores low; clamps", () => {
  assert.equal(scoreRestingHR(60, 60), 100, "today == baseline → 100");
  assert.equal(scoreRestingHR(48, 60), 100, "below baseline (better) clamps at 100");
  assert.equal(scoreRestingHR(80, 60), 75, "above baseline (worse) → 75 (60/80)");
});

// ── scoreLoad: the 60 / 180 / 360 minute step bands ─────────────────────────────
test("scoreLoad: the recent-load step function bands", () => {
  assert.equal(scoreLoad(0), 100, "no recent load → fully fresh (100)");
  assert.equal(scoreLoad(59), 100, "under 60 min → 100");
  assert.equal(scoreLoad(60), 75, "60 min hits the next band → 75");
  assert.equal(scoreLoad(180), 75, "180 min is the top of the 75 band");
  assert.equal(scoreLoad(181), 50, "just over 180 → 50");
  assert.equal(scoreLoad(360), 50, "360 min is the top of the 50 band");
  assert.equal(scoreLoad(361), 25, "over 360 min → the most-fatigued band (25)");
});
