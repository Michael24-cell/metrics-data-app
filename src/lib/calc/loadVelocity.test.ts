import { describe, it, expect } from "vitest";
import { buildLoadVelocityProfile } from "./loadVelocity";

describe("live load–velocity profile from stored reps", () => {
  it("averages valid reps per distinct load, sorted by load", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 80, meanVelocityMs: 0.52 },
      { loadKg: 40, meanVelocityMs: 1.0 },
      { loadKg: 40, meanVelocityMs: 1.04 },
      { loadKg: 80, meanVelocityMs: 0.5 },
      { loadKg: 40, meanVelocityMs: 0.99 },
    ]);
    expect(p.points.map((x) => x.loadKg)).toEqual([40, 80]);
    expect(p.points[0].meanVelocityMs).toBeCloseTo((1.0 + 1.04 + 0.99) / 3, 10);
    expect(p.points[0].repCount).toBe(3);
    expect(p.points[1].meanVelocityMs).toBeCloseTo(0.51, 10);
    expect(p.validReps).toBe(5);
  });

  it("excludes ONLY explicitly flagged reps and keeps statistical outliers", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 60, meanVelocityMs: 0.8 },
      { loadKg: 60, meanVelocityMs: 0.82 },
      // wildly off but unflagged — must stay in (no silent outlier discard)
      { loadKg: 60, meanVelocityMs: 2.4 },
      // flagged — excluded with its reason carried through
      { loadKg: 100, meanVelocityMs: 0.31, qualityFlag: "bar path fault — coach flagged" },
      { loadKg: 100, meanVelocityMs: 0.33 },
    ]);
    expect(p.points.find((x) => x.loadKg === 60)!.repCount).toBe(3);
    expect(p.points.find((x) => x.loadKg === 60)!.meanVelocityMs).toBeCloseTo((0.8 + 0.82 + 2.4) / 3, 10);
    expect(p.points.find((x) => x.loadKg === 100)!.repCount).toBe(1);
    expect(p.excludedReps).toEqual([{ loadKg: 100, meanVelocityMs: 0.31, reason: "bar path fault — coach flagged" }]);
    expect(p.notes.some((n) => n.includes("explicit quality flag"))).toBe(true);
  });

  it("reports insufficient status below 2 distinct loads (points still shown)", () => {
    const one = buildLoadVelocityProfile([
      { loadKg: 50, meanVelocityMs: 0.9 },
      { loadKg: 50, meanVelocityMs: 0.92 },
    ]);
    expect(one.status).toBe("insufficient");
    expect(one.method).toBeNull();
    expect(one.slope).toBeNull();
    expect(one.r2).toBeNull();
    expect(one.points).toHaveLength(1);
    expect(one.notes.some((n) => n.includes("at least 2 distinct loads"))).toBe(true);
    expect(buildLoadVelocityProfile([]).status).toBe("insufficient");
  });

  it("uses the exact two-point line for 2 distinct loads, with no R²", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 40, meanVelocityMs: 1.0 },
      { loadKg: 90, meanVelocityMs: 0.4 },
    ]);
    expect(p.status).toBe("fitted");
    expect(p.method).toBe("two_point");
    expect(p.slope).toBeCloseTo((0.4 - 1.0) / 50, 10);
    // line passes exactly through both points
    expect(p.intercept! + p.slope! * 40).toBeCloseTo(1.0, 10);
    expect(p.intercept! + p.slope! * 90).toBeCloseTo(0.4, 10);
    expect(p.r2).toBeNull();
    expect(p.notes.some((n) => n.includes("R² is not meaningful for 2 points"))).toBe(true);
  });

  it("presents two-point 40%/80% load placement as guidance, not measurement", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 40, meanVelocityMs: 1.0 },
      { loadKg: 90, meanVelocityMs: 0.4 },
    ]);
    const guidance = p.notes.find((n) => n.includes("~40%"));
    expect(guidance).toBeDefined();
    expect(guidance).toContain("guidance only");
    expect(guidance).toContain("not a measured percentage");
  });

  it("fits least squares with R² for ≥3 distinct loads (4 = standard fuller profile)", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 40, meanVelocityMs: 1.01 },
      { loadKg: 55, meanVelocityMs: 0.88 },
      { loadKg: 70, meanVelocityMs: 0.72 },
      { loadKg: 85, meanVelocityMs: 0.6 },
    ]);
    expect(p.status).toBe("fitted");
    expect(p.method).toBe("least_squares");
    expect(p.distinctLoads).toBe(4);
    expect(p.slope).toBeLessThan(0);
    expect(p.r2).not.toBeNull();
    expect(p.r2!).toBeGreaterThan(0.98);
  });

  it("labels a 3-load profile as minimal multi-point", () => {
    const p = buildLoadVelocityProfile([
      { loadKg: 40, meanVelocityMs: 1.0 },
      { loadKg: 60, meanVelocityMs: 0.8 },
      { loadKg: 80, meanVelocityMs: 0.58 },
    ]);
    expect(p.method).toBe("least_squares");
    expect(p.r2).not.toBeNull();
    expect(p.notes.some((n) => n.includes("minimal multi-point"))).toBe(true);
  });
});
