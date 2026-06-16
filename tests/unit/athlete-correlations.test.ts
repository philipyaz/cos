// Unit tests for the pure athlete statistics (board/lib/athlete-correlations.ts) — the
// Pearson correlation + ordinary-least-squares regression that the /correlations route runs
// over paired health series. Both helpers are I/O-free, so this suite drives the REAL exports
// on known series with hand-computable expectations, never touching disk. Sibling of
// nutrition-targets.test.ts: pure logic, run headless under `node --test`.
//
// What it asserts (against the ACTUAL implementation):
//   • pearson — the "not enough signal" contract (n<3 or zero variance → null), a perfect
//     +1 / −1 on collinear series, and a known intermediate r on a fixed 5-point series;
//   • linearRegression — the n<2 / zero-x-variance → null contract, and the exact
//     slope/intercept of a known line (incl. a noisy fit that recovers the generating line).

import { test } from "node:test";
import assert from "node:assert/strict";

import { pearson, linearRegression } from "../../board/lib/athlete-correlations.ts";

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── pearson ─────────────────────────────────────────────────────────────────────
test("pearson: the 'not enough signal' nulls (n<3, length mismatch, zero variance)", () => {
  assert.equal(pearson([], []), null, "empty → null");
  assert.equal(pearson([1, 2], [1, 2]), null, "fewer than 3 pairs → null");
  assert.equal(pearson([1, 2, 3], [1, 2]), null, "mismatched lengths → null");
  assert.equal(pearson([5, 5, 5], [1, 2, 3]), null, "zero variance in x → null (undefined r)");
  assert.equal(pearson([1, 2, 3], [7, 7, 7]), null, "zero variance in y → null (undefined r)");
});

test("pearson: perfect positive (+1) and perfect negative (−1) on collinear series", () => {
  const up = pearson([1, 2, 3, 4], [2, 4, 6, 8]); // y = 2x
  assert.ok(up !== null && approx(up, 1), "a perfectly increasing line → r = +1");
  const down = pearson([1, 2, 3, 4], [8, 6, 4, 2]); // y = -2x + 10
  assert.ok(down !== null && approx(down, -1), "a perfectly decreasing line → r = −1");
});

test("pearson: a known intermediate r on a fixed 5-point series", () => {
  // xs=[1,2,3,4,5], ys=[2,4,5,4,5]: meanX=3, meanY=4.
  //   cov-num = Σ(dx·dy) = (-2)(-2)+(-1)(0)+(0)(1)+(1)(0)+(2)(1) = 4+0+0+0+2 = 6
  //   denX = Σdx² = 4+1+0+1+4 = 10 ; denY = Σdy² = 4+0+1+0+1 = 6
  //   r = 6 / sqrt(10·6) = 6 / sqrt(60) ≈ 0.7745966692
  const r = pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
  assert.ok(r !== null, "a 5-point series has enough pairs");
  assert.ok(approx(r!, 6 / Math.sqrt(60), 1e-9), `r ≈ 0.7746 (got ${r})`);
});

// ── linearRegression ──────────────────────────────────────────────────────────
test("linearRegression: the n<2 / zero-x-variance / length-mismatch nulls", () => {
  assert.equal(linearRegression([1], [1]), null, "a single point → null");
  assert.equal(linearRegression([1, 2, 3], [1, 2]), null, "mismatched lengths → null");
  assert.equal(linearRegression([4, 4, 4], [1, 2, 3]), null, "zero variance in x (vertical fit) → null");
});

test("linearRegression: recovers the exact slope/intercept of a clean line", () => {
  // y = 3x + 1 on x = 1..4.
  const fit = linearRegression([1, 2, 3, 4], [4, 7, 10, 13]);
  assert.ok(fit !== null, "two+ points → a fit");
  assert.ok(approx(fit!.slope, 3), `slope = 3 (got ${fit!.slope})`);
  assert.ok(approx(fit!.intercept, 1), `intercept = 1 (got ${fit!.intercept})`);
});

test("linearRegression: the OLS fit of a symmetric noisy series recovers the generating line", () => {
  // Points symmetric about y = 2x: residuals +1/−1 cancel, so OLS recovers slope 2, intercept 0.
  //   xs=[0,1,2,3], ys=[1,1,5,5]  (y=2x is [0,2,4,6]; residuals +1,−1,+1,−1)
  const fit = linearRegression([0, 1, 2, 3], [1, 1, 5, 5]);
  assert.ok(fit !== null, "four points → a fit");
  // meanX=1.5, meanY=3; num=Σdx·dy = (-1.5)(-2)+(-0.5)(-2)+(0.5)(2)+(1.5)(2)=3+1+1+3=8;
  // den=Σdx²=2.25+0.25+0.25+2.25=5; slope=8/5=1.6, intercept=3−1.6·1.5=0.6.
  assert.ok(approx(fit!.slope, 1.6), `slope = 1.6 (got ${fit!.slope})`);
  assert.ok(approx(fit!.intercept, 0.6), `intercept = 0.6 (got ${fit!.intercept})`);
});
