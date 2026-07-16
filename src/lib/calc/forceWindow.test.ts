import { describe, it, expect } from "vitest";
import { buildForceWindowRow, ForceWindowRowInput } from "./forceWindow";

function input(partial: Partial<ForceWindowRowInput>): ForceWindowRowInput {
  return {
    ms: 100,
    metricKey: "imtp_force_at_100ms",
    abs: [],
    rel: [],
    left: [],
    right: [],
    asymmetry: [],
    ...partial,
  };
}

describe("Force 0–300 ms window row assembly", () => {
  it("reports all values when every series is aligned on the latest session", () => {
    const row = buildForceWindowRow(
      input({
        abs: [
          { date: "2026-01-01", value: 1800 },
          { date: "2026-02-01", value: 1900 },
        ],
        rel: [{ date: "2026-02-01", value: 23.2 }],
        left: [{ date: "2026-02-01", value: 1000 }],
        right: [{ date: "2026-02-01", value: 900 }],
        asymmetry: [
          { date: "2026-01-01", value: 4.0, strongerSide: "right" },
          { date: "2026-02-01", value: 10.5, strongerSide: "left" },
        ],
      })
    );
    expect(row.latestDate).toBe("2026-02-01");
    expect(row.absN).toBe(1900);
    expect(row.relNkg).toBe(23.2);
    expect(row.leftN).toBe(1000);
    expect(row.rightN).toBe(900);
    expect(row.asymmetryPct).toBe(10.5);
    expect(row.strongerSide).toBe("left");
    expect(row.sideChanges).toBe(1);
    expect(row.sessionCount).toBe(2);
  });

  it("returns an all-null row (sessionCount 0) when no absolute data exists", () => {
    const row = buildForceWindowRow(input({}));
    expect(row.latestDate).toBeNull();
    expect(row.absN).toBeNull();
    expect(row.relNkg).toBeNull();
    expect(row.leftN).toBeNull();
    expect(row.rightN).toBeNull();
    expect(row.asymmetryPct).toBeNull();
    expect(row.strongerSide).toBeNull();
    expect(row.sideChanges).toBeNull();
    expect(row.sessionCount).toBe(0);
  });

  it("omits left/right and asymmetry when no bilateral data exists (single-plate history)", () => {
    const row = buildForceWindowRow(
      input({
        abs: [{ date: "2026-02-01", value: 1900 }],
        rel: [{ date: "2026-02-01", value: 23.2 }],
      })
    );
    expect(row.absN).toBe(1900);
    expect(row.relNkg).toBe(23.2);
    expect(row.leftN).toBeNull();
    expect(row.rightN).toBeNull();
    expect(row.asymmetryPct).toBeNull();
    expect(row.strongerSide).toBeNull();
    expect(row.sideChanges).toBeNull();
  });

  it("never mixes sessions: stale relative/side values from an earlier session are not reported", () => {
    const row = buildForceWindowRow(
      input({
        abs: [
          { date: "2026-01-01", value: 1800 },
          { date: "2026-02-01", value: 1900 },
        ],
        rel: [{ date: "2026-01-01", value: 22.0 }],
        left: [{ date: "2026-01-01", value: 950 }],
        right: [{ date: "2026-01-01", value: 850 }],
        asymmetry: [{ date: "2026-01-01", value: 11.1, strongerSide: "left" }],
      })
    );
    expect(row.latestDate).toBe("2026-02-01");
    expect(row.absN).toBe(1900);
    expect(row.relNkg).toBeNull();
    expect(row.leftN).toBeNull();
    expect(row.rightN).toBeNull();
    expect(row.asymmetryPct).toBeNull();
    expect(row.strongerSide).toBeNull();
  });

  it("counts side changes across the full history even when the latest session lacks asymmetry", () => {
    const row = buildForceWindowRow(
      input({
        abs: [
          { date: "2026-01-01", value: 1800 },
          { date: "2026-01-15", value: 1850 },
          { date: "2026-02-01", value: 1900 },
        ],
        asymmetry: [
          { date: "2026-01-01", value: 6.0, strongerSide: "left" },
          { date: "2026-01-08", value: 5.0, strongerSide: "right" },
          { date: "2026-01-15", value: 4.0, strongerSide: "left" },
        ],
      })
    );
    // latest session (02-01) has no asymmetry point → no current asym shown
    expect(row.asymmetryPct).toBeNull();
    expect(row.strongerSide).toBeNull();
    // but history-level side changes still counted (left→right→left = 2)
    expect(row.sideChanges).toBe(2);
  });

  it("does not count 'equal' as a side when counting changes (shared directionChanges rule)", () => {
    const row = buildForceWindowRow(
      input({
        abs: [{ date: "2026-02-01", value: 1900 }],
        asymmetry: [
          { date: "2026-01-01", value: 3.0, strongerSide: "left" },
          { date: "2026-01-08", value: 0.0, strongerSide: "equal" },
          { date: "2026-01-15", value: 2.0, strongerSide: "left" },
        ],
      })
    );
    expect(row.sideChanges).toBe(0);
  });

  it("reports sideChanges as null (not 0) with fewer than two bilateral sessions", () => {
    const row = buildForceWindowRow(
      input({
        abs: [{ date: "2026-02-01", value: 1900 }],
        asymmetry: [{ date: "2026-02-01", value: 5.0, strongerSide: "left" }],
      })
    );
    expect(row.asymmetryPct).toBe(5.0);
    expect(row.sideChanges).toBeNull();
  });
});
