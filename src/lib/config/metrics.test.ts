import { describe, it, expect } from "vitest";
import {
  METRICS,
  METRIC_GROUPS,
  TEST_TYPES,
  ASYMMETRY_SOURCE_METRICS,
  metricsForTest,
  primaryMetricsForTest,
  advancedMetricsForTest,
  defaultMetricForTest,
} from "./metrics";
import { computeCmj } from "../calc/cmj";
import { computeImtp } from "../calc/imtp";
import { generateCmjTrace, generateImtpTrace } from "../calc/synthetic";

describe("Test-first registry lookup", () => {
  it("metricsForTest returns only metrics whose testType matches", () => {
    for (const key of metricsForTest("cmj").map((m) => m.key)) {
      expect(METRICS[key].testType).toBe("cmj");
    }
    const cmjKeys = new Set(metricsForTest("cmj").map((m) => m.key));
    expect(cmjKeys).toEqual(
      new Set(["cmj_jump_height", "cmj_mrsi", "cmj_time_to_takeoff", "cmj_ecc_braking_impulse", "cmj_peak_propulsive_force"])
    );
  });

  it("excludes derived metrics from any real test's metric list", () => {
    expect(metricsForTest("cmj").some((m) => m.key === "asymmetry_index")).toBe(false);
    expect(metricsForTest("imtp").some((m) => m.key === "asymmetry_index")).toBe(false);
  });

  it("returns an empty list for an unknown test type rather than throwing", () => {
    expect(metricsForTest("not_a_real_test")).toEqual([]);
  });

  it("defaultMetricForTest matches TEST_TYPES configuration for every real test", () => {
    expect(defaultMetricForTest("cmj")).toBe("cmj_jump_height");
    expect(defaultMetricForTest("imtp")).toBe("imtp_peak_force");
    expect(defaultMetricForTest("drop_jump")).toBe("dj_rsi");
    expect(defaultMetricForTest("vbt")).toBe("lv_mean_velocity");
    for (const t of Object.values(TEST_TYPES)) {
      if (t.defaultMetric) expect(METRICS[t.defaultMetric]).toBeDefined();
    }
  });

  it("marks exactly CMJ and IMTP as curve-eligible (waveform-backed force-time tests)", () => {
    expect(TEST_TYPES.cmj.curveEligible).toBe(true);
    expect(TEST_TYPES.imtp.curveEligible).toBe(true);
    expect(TEST_TYPES.drop_jump.curveEligible).toBe(false);
    expect(TEST_TYPES.vbt.curveEligible).toBe(false);
  });
});

describe("Trainer-facing vs advanced metric visibility", () => {
  it("primaryMetricsForTest never includes an advanced-visibility metric", () => {
    for (const testType of Object.keys(TEST_TYPES)) {
      const primaryKeys = new Set(primaryMetricsForTest(testType).filter((e) => e.kind === "metric").map((e) => e.key));
      for (const key of primaryKeys) {
        expect(METRICS[key].visibility).toBe("primary");
      }
    }
  });

  it("advancedMetricsForTest returns exactly the advanced-visibility metrics for that test", () => {
    const advancedImtp = new Set(advancedMetricsForTest("imtp").map((m) => m.key));
    expect(advancedImtp.has("imtp_rfd_0_50")).toBe(true);
    expect(advancedImtp.has("imtp_rfd_50_150")).toBe(true);
    expect(advancedImtp.has("imtp_rfd_150_250")).toBe(true);
    expect(advancedImtp.has("imtp_peak_force")).toBe(false);
  });

  it("the IMTP fixed-time-force group appears as ONE selector entry, not six", () => {
    const primary = primaryMetricsForTest("imtp");
    const groupEntries = primary.filter((e) => e.kind === "group");
    expect(groupEntries).toHaveLength(1);
    expect(groupEntries[0]).toEqual({ key: "imtp_force_window", label: "Force 0–300 ms", kind: "group" });
    // none of the six member keys appear individually in the primary list
    for (const memberKey of METRIC_GROUPS.imtp_force_window.memberKeys) {
      expect(primary.some((e) => e.key === memberKey)).toBe(false);
    }
  });
});

describe("RFD placement", () => {
  it("is excluded from primary/test-first metric selection", () => {
    const rfdKeys = ["imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250"];
    for (const key of rfdKeys) {
      expect(METRICS[key].visibility).toBe("advanced");
    }
    const primaryImtpKeys = new Set(primaryMetricsForTest("imtp").map((e) => e.key));
    for (const key of rfdKeys) expect(primaryImtpKeys.has(key)).toBe(false);
  });

  it("is correctly marked bilateral-only — no per-side RFD calculation exists", () => {
    for (const key of ["imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250"]) {
      expect(METRICS[key].sided).toBe(false);
      expect(METRICS[key].asymmetryEligible).toBe(false);
    }
    expect(ASYMMETRY_SOURCE_METRICS).not.toContain("imtp_rfd_0_50");
    expect(ASYMMETRY_SOURCE_METRICS).not.toContain("imtp_rfd_50_150");
    expect(ASYMMETRY_SOURCE_METRICS).not.toContain("imtp_rfd_150_250");
  });
});

describe("Fixed-time force registry", () => {
  it("names six absolute keys, distinct from six relative keys, none called RFD", () => {
    const abs = ["imtp_force_at_50ms", "imtp_force_at_100ms", "imtp_force_at_150ms", "imtp_force_at_200ms", "imtp_force_at_250ms", "imtp_force_at_300ms"];
    for (const key of abs) {
      expect(METRICS[key]).toBeDefined();
      expect(METRICS[key].unit).toBe("N");
      expect(METRICS[key].precision).toBe(0);
      expect(METRICS[key].label.toLowerCase()).not.toContain("rfd");
      const relKey = `${key}_rel`;
      expect(METRICS[relKey]).toBeDefined();
      expect(METRICS[relKey].unit).toBe("N/kg");
      expect(METRICS[relKey].precision).toBe(2);
      expect(METRICS[key].normalizedKey).toBe(relKey);
    }
  });

  it("absolute points are asymmetry-eligible and sided; relative points are bilateral-only", () => {
    for (const m of Object.values(METRICS).filter((m) => m.group === "imtp_force_window" && m.unit === "N")) {
      expect(m.sided).toBe(true);
      expect(m.asymmetryEligible).toBe(true);
    }
    for (const m of Object.values(METRICS).filter((m) => m.group === "imtp_force_window" && m.unit === "N/kg")) {
      expect(m.sided).toBe(false);
      expect(m.asymmetryEligible).toBe(false);
    }
  });
});

describe("New timing metrics registry", () => {
  it("imtp_time_to_peak_force and cmj_time_to_takeoff exist, in ms, bilateral, not asymmetry-eligible", () => {
    for (const key of ["imtp_time_to_peak_force", "cmj_time_to_takeoff"]) {
      const m = METRICS[key];
      expect(m).toBeDefined();
      expect(m.unit).toBe("ms");
      expect(m.sided).toBe(false);
      expect(m.asymmetryEligible).toBe(false);
      expect(m.trendEligible).toBe(true);
    }
  });
});

describe("Registry capability matching real calculation output", () => {
  it("every metric marked asymmetryEligible implies sided", () => {
    for (const m of Object.values(METRICS)) {
      if (m.asymmetryEligible) expect(m.sided).toBe(true);
    }
  });

  it("ASYMMETRY_SOURCE_METRICS is derived from the registry, not a second hand-maintained list", () => {
    const derived = Object.values(METRICS).filter((m) => m.asymmetryEligible).map((m) => m.key);
    expect(ASYMMETRY_SOURCE_METRICS).toEqual(derived);
    expect(new Set(ASYMMETRY_SOURCE_METRICS)).toEqual(
      new Set([
        "cmj_ecc_braking_impulse",
        "cmj_peak_propulsive_force",
        "imtp_peak_force",
        "imtp_force_at_50ms",
        "imtp_force_at_100ms",
        "imtp_force_at_150ms",
        "imtp_force_at_200ms",
        "imtp_force_at_250ms",
        "imtp_force_at_300ms",
      ])
    );
  });

  it("CMJ: every sided:true metric actually receives left+right values from computeCmj on dual-plate data", () => {
    const r = computeCmj(generateCmjTrace({ massKg: 78, takeoffVelocity: 2.5, depthFactor: 1.0, leftShare: 0.42, seed: 11 }));
    const fieldsBySidedMetric: Record<string, [unknown, unknown]> = {
      cmj_ecc_braking_impulse: [r.eccBrakingImpulseLeftNs, r.eccBrakingImpulseRightNs],
      cmj_peak_propulsive_force: [r.peakPropulsiveForceLeftN, r.peakPropulsiveForceRightN],
    };
    for (const m of metricsForTest("cmj").filter((x) => x.sided)) {
      const pair = fieldsBySidedMetric[m.key];
      expect(pair, `no known result-field mapping for sided CMJ metric '${m.key}' — registry/test drifted`).toBeDefined();
      expect(pair[0]).toBeDefined();
      expect(pair[1]).toBeDefined();
    }
  });

  it("IMTP: every sided:true non-grouped metric actually receives left+right values from computeImtp on dual-plate data", () => {
    const r = computeImtp(generateImtpTrace({ massKg: 82, peakNetForceN: 2200, riseTau: 0.25, leftShare: 0.4, seed: 6 }));
    expect(r.peakForceLeftN).toBeDefined();
    expect(r.peakForceRightN).toBeDefined();
    expect(METRICS.imtp_peak_force.sided).toBe(true);
  });

  it("IMTP: every sided:true force-window member actually receives left+right values from computeImtp", () => {
    const r = computeImtp(generateImtpTrace({ massKg: 82, peakNetForceN: 2200, riseTau: 0.25, leftShare: 0.4, seed: 6 }));
    const memberKeys = METRIC_GROUPS.imtp_force_window.memberKeys;
    expect(memberKeys.every((k) => METRICS[k].sided)).toBe(true);
    for (const p of r.forcePoints) {
      expect(p.forceLeftN).toBeDefined();
      expect(p.forceRightN).toBeDefined();
    }
    expect(r.forcePoints).toHaveLength(memberKeys.length);
  });

  it("no metric claims sided:true without appearing in either the CMJ or IMTP explicit per-side mappings above or the force-window group", () => {
    const knownSidedCmj = new Set(["cmj_ecc_braking_impulse", "cmj_peak_propulsive_force"]);
    const knownSidedImtp = new Set(["imtp_peak_force", ...METRIC_GROUPS.imtp_force_window.memberKeys]);
    for (const m of Object.values(METRICS)) {
      if (!m.sided) continue;
      const known = m.testType === "cmj" ? knownSidedCmj.has(m.key) : m.testType === "imtp" ? knownSidedImtp.has(m.key) : false;
      expect(known, `metric '${m.key}' is marked sided:true but has no verified per-side calculation path — add it to compute.ts and this test`).toBe(true);
    }
  });
});
