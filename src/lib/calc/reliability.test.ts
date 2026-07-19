import { describe, it, expect } from "vitest";
import {
  withinSessionCv,
  typicalError,
  buildSessionPairs,
  smallestWorthwhileChange,
  minimalDetectableChange,
  assessChangeVsNoise,
  computeReliability,
  ReliabilityInputs,
} from "./reliability";
import { MetricStatPolicy, statPolicyFor } from "../config/statPolicies";

const policy = (overrides: Partial<MetricStatPolicy> = {}): MetricStatPolicy => ({
  metricKey: "cmj_jump_height",
  minAttemptsPerSession: 2,
  minSessions: 5,
  cvMethod: "within_session_sd_over_mean",
  teMethod: "paired_diff_sd_div_sqrt2",
  swc: { kind: "none" },
  mdcConfidence: 95,
  cvWarnPct: 10,
  minDenominator: 1e-3,
  provisional: true,
  ...overrides,
});

describe("within-session CV", () => {
  it("computes SD/mean × 100 over valid attempts", () => {
    // values 38, 40, 42: mean 40, sample SD 2 → CV 5%
    const r = withinSessionCv([38, 40, 42], policy());
    expect(r.available).toBe(true);
    expect(r.mean).toBe(40);
    expect(r.cvPct).toBeCloseTo(5, 6);
  });

  it("refuses insufficient attempts with the count in the reason", () => {
    const r = withinSessionCv([40], policy());
    expect(r.available).toBe(false);
    expect(r.reason).toContain("only 1 valid attempt");
  });

  it("refuses a near-zero denominator instead of producing a huge CV", () => {
    const r = withinSessionCv([0.0001, -0.0002, 0.0001], policy());
    expect(r.available).toBe(false);
    expect(r.reason).toContain("mean too close to zero");
  });
});

describe("typical error (paired consecutive sessions)", () => {
  it("TE = SD(paired differences) ÷ √2 with a known dataset", () => {
    // session bests 40, 42, 41, 44 → diffs [2, -1, 3]; sample SD ≈ 2.0817
    const te = typicalError(buildSessionPairs([40, 42, 41, 44]), policy());
    expect(te.available).toBe(true);
    expect(te.pairCount).toBe(3);
    expect(te.te).toBeCloseTo(2.0817 / Math.SQRT2, 3);
  });

  it("refuses when pairs are missing", () => {
    expect(typicalError(buildSessionPairs([40]), policy()).available).toBe(false);
    expect(typicalError(buildSessionPairs([40, 42]), policy()).available).toBe(false); // 1 pair < 2
  });

  it("respects a policy that disables TE", () => {
    const te = typicalError(buildSessionPairs([40, 42, 41, 44]), policy({ teMethod: "none" }));
    expect(te.available).toBe(false);
    expect(te.reason).toContain("not enabled by policy");
  });
});

describe("SWC method variants", () => {
  const bests = [40, 42, 41, 44, 43];

  it("is unavailable when no method is configured (no silent universal default)", () => {
    const r = smallestWorthwhileChange(bests, { kind: "none" });
    expect(r.available).toBe(false);
    expect(r.reason).toContain("no approved SWC method");
  });

  it("fraction of between-session SD", () => {
    const mean = 42;
    const sdVal = Math.sqrt(bests.reduce((a, x) => a + (x - mean) ** 2, 0) / (bests.length - 1));
    const r = smallestWorthwhileChange(bests, { kind: "between_sd_fraction", factor: 0.2 });
    expect(r.available).toBe(true);
    expect(r.value).toBeCloseTo(0.2 * sdVal, 6);
  });

  it("absolute, percent, and facility-approved values", () => {
    expect(smallestWorthwhileChange(bests, { kind: "absolute", value: 1.5 }).value).toBe(1.5);
    expect(smallestWorthwhileChange(bests, { kind: "percent", pct: 5 }).value).toBeCloseTo(42 * 0.05, 6);
    expect(smallestWorthwhileChange(bests, { kind: "facility_value", value: 2.2, approvedBy: "HoP" }).value).toBe(2.2);
  });
});

describe("MDC", () => {
  it("MDC = z × √2 × TE at the configured confidence", () => {
    const te = typicalError(buildSessionPairs([40, 42, 41, 44]), policy());
    const m95 = minimalDetectableChange(te, 95);
    expect(m95.available).toBe(true);
    expect(m95.mdc).toBeCloseTo(1.96 * Math.SQRT2 * te.te!, 6);
    const m90 = minimalDetectableChange(te, 90);
    expect(m90.mdc).toBeCloseTo(1.645 * Math.SQRT2 * te.te!, 6);
  });

  it("is only presented when TE and confidence are valid", () => {
    const noTe = minimalDetectableChange({ available: false, reason: "x", pairCount: 0, te: null, pairingMethod: "consecutive_eligible_sessions" }, 95);
    expect(noTe.available).toBe(false);
    const noConf = minimalDetectableChange(typicalError(buildSessionPairs([40, 42, 41, 44]), policy()), null);
    expect(noConf.available).toBe(false);
    expect(noConf.reason).toContain("no MDC confidence configured");
  });
});

describe("observed change vs expected noise", () => {
  const te = typicalError(buildSessionPairs([40, 42, 41, 44]), policy());

  it("without a configured gate, no noise claim is made (range-only honesty)", () => {
    const a = assessChangeVsNoise(3, "none", { te });
    expect(a.state).toBe("reliability_unavailable");
    expect(a.detail).toContain("no noise gate is configured");
  });

  it("with a TE gate, classifies exceeds vs within", () => {
    expect(assessChangeVsNoise(5, "te", { te }).state).toBe("exceeds_threshold");
    expect(assessChangeVsNoise(0.5, "te", { te }).state).toBe("within_noise");
  });

  it("poor CV forces the reliability_poor state regardless of gate", () => {
    expect(assessChangeVsNoise(5, "te", { te, cvPoor: true }).state).toBe("reliability_poor");
  });
});

describe("full reliability result contract", () => {
  const inputs = (sessions: ReliabilityInputs["sessions"], extra: Partial<ReliabilityInputs> = {}): ReliabilityInputs => ({
    metricKey: "cmj_jump_height",
    testType: "cmj",
    unit: "cm",
    sessions,
    excludedSessions: [],
    comparable: true,
    ...extra,
  });
  const mkSessions = (bests: number[], noise = 0.5) =>
    bests.map((b, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, sessionBest: b, attemptValues: [b - noise, b - noise / 2, b] }));

  it("eligible metric carries versions, sample sizes, and available statistics", () => {
    const r = computeReliability(inputs(mkSessions([40, 42, 41, 44, 43, 42])), policy());
    expect(r.availability).toBe("eligible");
    expect(r.calcVersion).toBe("1.0.0");
    expect(r.policyVersion).toBe("1.0.0");
    expect(r.sourceSessionCount).toBe(6);
    expect(r.te.available).toBe(true);
    expect(r.mdc.available).toBe(true);
    expect(r.swc.available).toBe(false); // no universal SWC silently activated
  });

  it("insufficient history is explicit", () => {
    const r = computeReliability(inputs(mkSessions([40, 42])), policy());
    expect(r.availability).toBe("insufficient_history");
    expect(r.availabilityReason).toContain("2 of 5");
  });

  it("poor within-session reliability warns without removing the metric", () => {
    const noisy = mkSessions([40, 42, 41, 44, 43, 42], 12); // huge attempt spread → CV >> 10%
    const r = computeReliability(inputs(noisy), policy());
    expect(r.availability).toBe("poor_within_session_reliability");
    expect(r.reliabilityWarning).toBe(true);
    expect(r.availabilityReason).toContain("do not overinterpret");
    expect(r.te.available).toBe(true); // statistics still exist — warning, not deletion
  });

  it("unsupported policy and incompatible sessions are distinct availability states", () => {
    expect(computeReliability(inputs(mkSessions([40, 42, 41, 44, 43])), null).availability).toBe("unsupported_by_policy");
    const r = computeReliability(inputs(mkSessions([40, 42, 41, 44, 43]), { comparable: false, comparabilityReason: "mixed method versions" }), policy());
    expect(r.availability).toBe("invalid_comparability");
    expect(r.availabilityReason).toContain("mixed method versions");
  });

  it("absolute and normalized metrics have separate registered policies", () => {
    expect(statPolicyFor("imtp_force_at_100ms")).not.toBeNull();
    expect(statPolicyFor("imtp_force_at_100ms_rel")).not.toBeNull();
    expect(statPolicyFor("imtp_force_at_100ms")).not.toBe(statPolicyFor("imtp_force_at_100ms_rel"));
  });

  it("historical replay: the same inputs + the same policy object reproduce identical results", () => {
    const frozen = policy(); // a stored policy version
    const a = computeReliability(inputs(mkSessions([40, 42, 41, 44, 43, 42])), frozen);
    const b = computeReliability(inputs(mkSessions([40, 42, 41, 44, 43, 42])), frozen);
    expect(a).toEqual(b);
    // changing the policy (new version) changes outputs without touching old results
    const c = computeReliability(inputs(mkSessions([40, 42, 41, 44, 43, 42])), policy({ minSessions: 10 }));
    expect(c.availability).toBe("insufficient_history");
    expect(a.availability).toBe("eligible");
  });
});
