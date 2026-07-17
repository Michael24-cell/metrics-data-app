import { describe, it, expect } from "vitest";
import { compareCurves, ComparableCurve } from "./curveCompare";

let seq = 0;
function curve(partial: Partial<ComparableCurve>): ComparableCurve {
  seq += 1;
  return {
    token: `t${seq}`,
    label: `curve ${seq}`,
    kind: "individual",
    hz: 250,
    stepMs: 4,
    startMs: -20,
    // 0..500 ms ramp: force[k] = 100 + index*4
    force: Array.from({ length: 131 }, (_, i) => 100 + i * 4),
    includedCount: 1,
    annotations: {},
    ...partial,
  };
}

describe("deterministic curve comparison", () => {
  it("computes display-resolution peak and mean difference over the OVERLAP only", () => {
    const a = curve({ force: Array.from({ length: 131 }, () => 1000) }); // flat 1000, [-20, 500]
    const b = curve({ startMs: 0, force: Array.from({ length: 101 }, () => 900) }); // flat 900, [0, 400]
    const cmp = compareCurves(a, b);
    expect(cmp.comparable).toBe(true);
    expect(cmp.overlapStartMs).toBe(0);
    expect(cmp.overlapEndMs).toBe(400);
    expect(cmp.displayPeakN).toEqual({ a: 1000, b: 900, diff: 100 });
    expect(cmp.meanDiffOverOverlapN).toBe(100);
  });

  it("refuses mixed display sample rates with a reason (no silent resampling)", () => {
    const a = curve({});
    const b = curve({ hz: 100, stepMs: 10 });
    const cmp = compareCurves(a, b);
    expect(cmp.comparable).toBe(false);
    expect(cmp.reasons[0]).toContain("250 Hz vs 100 Hz");
    expect(cmp.meanDiffOverOverlapN).toBeNull();
  });

  it("reports no-overlap windows as not comparable", () => {
    const a = curve({ startMs: -20, force: Array.from({ length: 6 }, () => 500) }); // [-20, 0]
    const b = curve({ startMs: 100, force: Array.from({ length: 6 }, () => 500) }); // [100, 120]
    const cmp = compareCurves(a, b);
    expect(cmp.comparable).toBe(false);
    expect(cmp.reasons.some((r) => r.includes("no overlapping"))).toBe(true);
  });

  it("compares official values only when BOTH curves are individual attempts", () => {
    const annotations = {
      officialPeakForceN: 2400,
      officialTimeToPeakMs: 2100,
      officialForcePoints: [
        { ms: 50, forceN: 1100 },
        { ms: 100, forceN: 1500 },
      ],
    };
    const a = curve({ annotations });
    const bAnn = {
      officialPeakForceN: 2300,
      officialTimeToPeakMs: 2250,
      officialForcePoints: [
        { ms: 50, forceN: 1050 },
        { ms: 100, forceN: 1480 },
      ],
    };
    const indiv = compareCurves(a, curve({ annotations: bAnn }));
    expect(indiv.officialPeakForceN).toEqual({ a: 2400, b: 2300, diff: 100 });
    expect(indiv.officialTimeToPeakMs).toEqual({ a: 2100, b: 2250, diff: -150 });
    expect(indiv.officialForcePointDiffs).toEqual([
      { ms: 50, a: 1100, b: 1050, diff: 50 },
      { ms: 100, a: 1500, b: 1480, diff: 20 },
    ]);

    // versus an average: official comparisons must be withheld, not fabricated
    const vsAvg = compareCurves(a, curve({ kind: "average", includedCount: 5, annotations: bAnn }));
    expect(vsAvg.officialPeakForceN).toBeNull();
    expect(vsAvg.officialTimeToPeakMs).toBeNull();
    expect(vsAvg.officialForcePointDiffs).toBeNull();
    expect(vsAvg.displayPeakN).not.toBeNull(); // display-resolution comparison still allowed
  });

  it("compares CMJ time to takeoff between two individual attempts", () => {
    const a = curve({ annotations: { officialTimeToTakeoffMs: 810 } });
    const b = curve({ annotations: { officialTimeToTakeoffMs: 845 } });
    const cmp = compareCurves(a, b);
    expect(cmp.officialTimeToTakeoffMs).toEqual({ a: 810, b: 845, diff: -35 });
  });

  it("only diffs force points present on BOTH attempts (short signals omit late points)", () => {
    const a = curve({ annotations: { officialForcePoints: [{ ms: 50, forceN: 1000 }, { ms: 300, forceN: 2000 }] } });
    const b = curve({ annotations: { officialForcePoints: [{ ms: 50, forceN: 900 }] } });
    const cmp = compareCurves(a, b);
    expect(cmp.officialForcePointDiffs).toEqual([{ ms: 50, a: 1000, b: 900, diff: 100 }]);
  });
});
