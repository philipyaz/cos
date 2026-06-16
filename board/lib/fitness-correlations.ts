// Pure statistics for the fitness /correlations surface — Pearson correlation + ordinary
// least-squares linear regression over paired numeric series. No I/O, no store access, no
// HTTP: the route (board/app/api/fitness/correlations) reads the canonical health entries via
// listEntries and calls these. Kept here so the math is unit-testable in isolation and shared
// with any future consumer (the weekly-review trend math, etc.).

/**
 * Pearson product-moment correlation coefficient r in [-1, 1] for two equal-length series.
 * Returns null when there are fewer than 3 pairs or either series has zero variance (an
 * undefined correlation), mirroring the route's "not enough signal" contract.
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

/**
 * Ordinary least-squares fit y = slope·x + intercept. Returns null when there are fewer than
 * 2 pairs or x has zero variance (a vertical fit is undefined).
 */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}
