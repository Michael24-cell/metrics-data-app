import { describe, it, expect } from "vitest";
import { summarizeSeries } from "./seriesSummary";

describe("series summary — Peak / Average / Most recent", () => {
  it("computes peak as the highest value regardless of position in the series", () => {
    const s = summarizeSeries([
      { date: "2026-01-01", value: 30 },
      { date: "2026-02-01", value: 42 },
      { date: "2026-03-01", value: 35 },
    ]);
    expect(s.peak).toBe(42);
  });

  it("computes average as the arithmetic mean of all valid values", () => {
    const s = summarizeSeries([
      { date: "2026-01-01", value: 10 },
      { date: "2026-02-01", value: 20 },
      { date: "2026-03-01", value: 30 },
    ]);
    expect(s.average).toBeCloseTo(20, 10);
  });

  it("takes most recent as the LAST point in chronological order, not the max or first", () => {
    const s = summarizeSeries([
      { date: "2026-01-01", value: 42 }, // peak, but not most recent
      { date: "2026-02-01", value: 30 },
      { date: "2026-03-01", value: 28 }, // most recent, lower than both
    ]);
    expect(s.mostRecent).toBe(28);
    expect(s.mostRecentDate).toBe("2026-03-01");
    expect(s.peak).toBe(42);
  });

  it("returns an all-null summary for an empty series", () => {
    const s = summarizeSeries([]);
    expect(s).toEqual({ n: 0, peak: null, average: null, mostRecent: null, mostRecentDate: null });
  });

  it("handles a single-point series (peak = average = most recent)", () => {
    const s = summarizeSeries([{ date: "2026-05-01", value: 17 }]);
    expect(s.peak).toBe(17);
    expect(s.average).toBe(17);
    expect(s.mostRecent).toBe(17);
    expect(s.n).toBe(1);
  });
});
