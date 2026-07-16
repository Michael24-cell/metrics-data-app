/**
 * Cohort statistics contract — team / position-group comparisons.
 *
 * Rules (fixed by the V2 analytics contract):
 *  - SD is the POPULATION standard deviation (divide by n), because the
 *    cohort shown IS the population being described, not a sample of one.
 *  - The athlete is INCLUDED in their own cohort.
 *  - z = (value − mean) / populationSD.
 *  - Cohort size is always surfaced; n < SMALL_SAMPLE_N warns.
 *  - No z-score when n < 2 or SD = 0 — raw values and diffs are still shown.
 *  - Whole-team and position cohorts only; custom cohorts are out of scope.
 */

export const SMALL_SAMPLE_N = 5;

export interface CohortStats {
  n: number;
  mean: number | null;
  median: number | null;
  populationSd: number | null;
  min: number | null;
  max: number | null;
  /** n > 0 but below SMALL_SAMPLE_N — display with a small-sample warning */
  smallSample: boolean;
}

export function cohortStats(values: number[]): CohortStats {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: null, median: null, populationSd: null, min: null, max: null, smallSample: false };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const populationSd = Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n);
  return {
    n,
    mean,
    median,
    populationSd,
    min: sorted[0],
    max: sorted[n - 1],
    smallSample: n < SMALL_SAMPLE_N,
  };
}

/** Difference from the cohort mean; null when the cohort has no mean. */
export function diffFromMean(value: number, stats: CohortStats): number | null {
  return stats.mean == null ? null : value - stats.mean;
}

/**
 * z = (value − mean) / populationSD. Null (never 0 or ±Infinity) when the
 * cohort cannot support one: n < 2, or zero variance.
 */
export function zScore(value: number, stats: CohortStats): number | null {
  if (stats.n < 2 || stats.mean == null || stats.populationSd == null || stats.populationSd === 0) return null;
  return (value - stats.mean) / stats.populationSd;
}
