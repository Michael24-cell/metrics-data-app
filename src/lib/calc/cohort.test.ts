import { describe, it, expect } from "vitest";
import { cohortStats, zScore, diffFromMean, SMALL_SAMPLE_N } from "./cohort";

describe("cohort statistics contract", () => {
  it("uses the POPULATION standard deviation (divide by n, not n−1)", () => {
    const s = cohortStats([2, 4, 4, 4, 5, 5, 7, 9]); // classic example: population SD = 2
    expect(s.populationSd).toBeCloseTo(2, 10);
    expect(s.mean).toBe(5);
    expect(s.n).toBe(8);
  });

  it("computes median for odd and even cohort sizes", () => {
    expect(cohortStats([3, 1, 2]).median).toBe(2);
    expect(cohortStats([4, 1, 2, 3]).median).toBe(2.5);
  });

  it("z-score follows z = (value − mean) / populationSD with the athlete included", () => {
    const s = cohortStats([2, 4, 4, 4, 5, 5, 7, 9]);
    // an athlete whose value (9) is part of the cohort still gets a z against it
    expect(zScore(9, s)).toBeCloseTo(2, 10);
    expect(zScore(5, s)).toBeCloseTo(0, 10);
    expect(diffFromMean(9, s)).toBeCloseTo(4, 10);
  });

  it("returns no z-score when n < 2, but keeps the raw diff usable", () => {
    const s = cohortStats([40]);
    expect(s.n).toBe(1);
    expect(zScore(40, s)).toBeNull();
    expect(diffFromMean(40, s)).toBe(0); // raw diff still available
  });

  it("returns no z-score when SD = 0 (zero-variance cohort)", () => {
    const s = cohortStats([30, 30, 30]);
    expect(s.populationSd).toBe(0);
    expect(zScore(30, s)).toBeNull();
    expect(zScore(31, s)).toBeNull(); // never ±Infinity
    expect(diffFromMean(31, s)).toBeCloseTo(1, 10);
  });

  it("flags small samples below the warning threshold and empty cohorts as inert", () => {
    expect(SMALL_SAMPLE_N).toBe(5);
    expect(cohortStats([1, 2, 3, 4]).smallSample).toBe(true);
    expect(cohortStats([1, 2, 3, 4, 5]).smallSample).toBe(false);
    const empty = cohortStats([]);
    expect(empty.n).toBe(0);
    expect(empty.mean).toBeNull();
    expect(empty.median).toBeNull();
    expect(empty.populationSd).toBeNull();
    expect(empty.smallSample).toBe(false);
  });
});
