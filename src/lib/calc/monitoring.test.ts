import { describe, it, expect } from "vitest";
import {
  classifySession,
  ClassifyInputs,
  mergePolicyLayers,
  MonitoringPolicyV1,
  MonitoringState,
  policyFingerprint,
  PRODUCT_DEFAULT_POLICY,
} from "./monitoring";
import { NoiseAssessment } from "./reliability";
import { getDb, newId, nowIso } from "../db/db";
import { effectivePolicy, savePolicyLayer } from "../services/monitoringPolicy";

const noise = (state: NoiseAssessment["state"] = "reliability_unavailable"): NoiseAssessment => ({
  state, gate: "none", threshold: null, observedChange: 0, detail: "test",
});

const policy = (o: Partial<MonitoringPolicyV1> = {}): MonitoringPolicyV1 => ({ ...PRODUCT_DEFAULT_POLICY, ...o });

const classify = (o: Partial<ClassifyInputs>): ReturnType<typeof classifySession> =>
  classifySession({
    history: [],
    currentValue: 40,
    higherIsBetter: true,
    policy: policy(),
    noise: noise(),
    reliabilityAvailability: "eligible",
    previousStates: [],
    ...o,
  });

/** stable history: 15 sessions at exactly 40 except a known last-5 window */
const hist = (n: number, tail: number[] = []) => [...Array(n - tail.length).fill(40), ...tail];

describe("baseline phase", () => {
  it("collects baseline for 15 (default) with progress and NO signals", () => {
    const r = classify({ history: hist(14), currentValue: 20 });
    expect(r.monitoringState).toBe("collecting_baseline");
    expect(r.rangeState).toBe("insufficient_data");
    expect(r.baselineProgress).toEqual({ have: 15, need: 15 });
    expect(r.detail).toContain("No automated monitoring signals");
  });

  it("supports the optional 30-session baseline", () => {
    expect(classify({ history: hist(29), policy: policy({ baselineSessions: 30 }) }).monitoringState).toBe("collecting_baseline");
    expect(classify({ history: hist(30), currentValue: 40, policy: policy({ baselineSessions: 30 }) }).monitoringState).toBe("within_expected_range");
  });

  it("session 16 is judged against sessions 11–15 (rolling 5), not the whole baseline", () => {
    // history = 15 sessions; last five are 50s, earlier ten are 40s
    const r = classify({ history: hist(15, [50, 50, 50, 50, 50]), currentValue: 50 });
    expect(r.referenceMean).toBe(50); // window = the last 5 only
    expect(r.referenceCount).toBe(5);
    expect(r.monitoringState).toBe("within_expected_range");
  });
});

describe("rolling monitoring", () => {
  it("supports rolling windows of 5, 7, and 10", () => {
    for (const rollingWindow of [5, 7, 10] as const) {
      const r = classify({ history: hist(20, Array(rollingWindow).fill(44)), policy: policy({ rollingWindow }), currentValue: 44 });
      expect(r.referenceCount).toBe(rollingWindow);
      expect(r.referenceMean).toBe(44);
    }
  });

  it("never includes the current result in the window that judges it", () => {
    // history mean 40 (SD 0); current value 100 must not shift the reference
    const r = classify({ history: hist(20), currentValue: 100 });
    expect(r.referenceMean).toBe(40);
    expect(r.rangeState).toBe("above_expected");
  });

  it("keeps rolling continuously — a later window reflects newer history, no block resets", () => {
    const early = classify({ history: hist(16, [41, 41, 41, 41, 41]), currentValue: 41 });
    const later = classify({ history: hist(30, [45, 45, 45, 45, 45]), currentValue: 45 });
    expect(early.referenceMean).toBe(41);
    expect(later.referenceMean).toBe(45);
  });
});

describe("classification separation", () => {
  it("range, noise, and operational state are separate fields", () => {
    const r = classify({ history: hist(20, [40, 41, 39, 40, 40]), currentValue: 20 });
    expect(r.rangeState).toBe("below_expected");
    expect(r.noiseState).toBe("reliability_unavailable"); // no gate configured
    expect(r.monitoringState).toBe("review_suggested"); // range breach; no noise claim made
    expect(r.detail).toContain("no noise gate is configured");
  });

  it("with a configured TE gate, a worse-direction breach must ALSO exceed the gate", () => {
    const within: NoiseAssessment = { state: "within_noise", gate: "te", threshold: 5, observedChange: -2, detail: "t" };
    const r = classify({ history: hist(20, [40, 41, 39, 40, 40]), currentValue: 38.5, policy: policy({ noiseGate: "te" }), noise: within });
    expect(r.monitoringState).toBe("within_expected_range");
    expect(r.detail).toContain("gate was not exceeded");
    const exceeds: NoiseAssessment = { state: "exceeds_threshold", gate: "te", threshold: 5, observedChange: -20, detail: "t" };
    expect(classify({ history: hist(20, [40, 41, 39, 40, 40]), currentValue: 20, policy: policy({ noiseGate: "te" }), noise: exceeds }).monitoringState).toBe("review_suggested");
  });

  it("low signals are direction-aware (lower-is-better metrics breach ABOVE the band)", () => {
    const slowTakeoff = classify({ history: hist(20, [800, 810, 805, 795, 800]), currentValue: 900, higherIsBetter: false });
    expect(slowTakeoff.rangeState).toBe("above_expected");
    expect(slowTakeoff.monitoringState).toBe("review_suggested");
    const fastTakeoff = classify({ history: hist(20, [800, 810, 805, 795, 800]), currentValue: 700, higherIsBetter: false });
    expect(fastTakeoff.monitoringState).toBe("within_expected_range");
    expect(fastTakeoff.detail).toContain("BETTER direction");
  });

  it("poor or missing reliability withholds signals when the policy requires eligibility", () => {
    const r = classify({ history: hist(20, [40, 41, 39, 40, 40]), currentValue: 20, reliabilityAvailability: "poor_within_session_reliability" });
    expect(r.monitoringState).toBe("insufficient_reliable_data");
    // range context still shown
    expect(r.rangeState).toBe("below_expected");
    // a policy that does not require eligibility lets the range signal through
    const loose = classify({ history: hist(20, [40, 41, 39, 40, 40]), currentValue: 20, reliabilityAvailability: "poor_within_session_reliability", policy: policy({ requireReliabilityEligible: false }) });
    expect(loose.monitoringState).toBe("review_suggested");
  });
});

describe("consecutive low signals and recovery", () => {
  const lowHistory = { history: hist(20, [40, 41, 39, 40, 40]), currentValue: 20 };

  it("two consecutive qualifying lows escalate to repeated_low_signal", () => {
    const first = classify({ ...lowHistory, previousStates: [] });
    expect(first.monitoringState).toBe("review_suggested");
    const second = classify({ ...lowHistory, previousStates: ["review_suggested"] });
    expect(second.monitoringState).toBe("repeated_low_signal");
    const third = classify({ ...lowHistory, previousStates: ["review_suggested", "repeated_low_signal"] });
    expect(third.monitoringState).toBe("repeated_low_signal");
  });

  it("recovery resets the consecutive count", () => {
    const afterRecovery = classify({ ...lowHistory, previousStates: ["review_suggested", "within_expected_range"] });
    expect(afterRecovery.monitoringState).toBe("review_suggested"); // count restarted at 1
  });

  it("the consecutive threshold is configurable", () => {
    const r = classify({ ...lowHistory, previousStates: ["review_suggested", "review_suggested"], policy: policy({ consecutiveLowCount: 4 }) });
    expect(r.monitoringState).toBe("review_suggested"); // 3 < 4
  });
});

describe("policy hierarchy, versioning, and replay (DB)", () => {
  const facilityId = (getDb().prepare(`SELECT id FROM facility LIMIT 1`).get() as { id: string }).id;
  const athleteId = (getDb().prepare(`SELECT id FROM athlete WHERE facility_id = ? LIMIT 1`).get(facilityId) as { id: string }).id;

  it("layers merge default ← facility ← coach ← athlete with traceability", () => {
    const coachId = `coach-${newId()}`;
    savePolicyLayer(facilityId, "facility", { rollingWindow: 7 });
    savePolicyLayer(facilityId, "coach", { baselineSessions: 30 }, { coachUserId: coachId });
    savePolicyLayer(facilityId, "athlete", { rollingWindow: 10 }, { athleteId });
    const eff = effectivePolicy(facilityId, athleteId, coachId);
    expect(eff.policy.rollingWindow).toBe(10); // athlete override wins
    expect(eff.policy.baselineSessions).toBe(30); // coach layer
    expect(eff.policy.noiseGate).toBe("none"); // untouched default
    expect(eff.layers.map((l) => l.scope)).toEqual(["facility", "coach", "athlete"]);
    expect(eff.fingerprint).toContain("athlete:v");
  });

  it("saving a layer bumps its version and preserves the old row", () => {
    const before = effectivePolicy(facilityId, athleteId);
    savePolicyLayer(facilityId, "athlete", { rollingWindow: 5 }, { athleteId });
    const after = effectivePolicy(facilityId, athleteId);
    const bv = before.layers.find((l) => l.scope === "athlete")!.version;
    const av = after.layers.find((l) => l.scope === "athlete")!.version;
    expect(av).toBe(bv + 1);
    const rows = getDb()
      .prepare(`SELECT COUNT(*) c FROM monitoring_policy WHERE facility_id = ? AND scope = 'athlete' AND athlete_id = ?`)
      .get(facilityId, athleteId) as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(2); // history preserved, new version active
  });

  it("fingerprints identify the exact policy composition (historical replay key)", () => {
    const eff = effectivePolicy(facilityId, athleteId);
    expect(policyFingerprint(eff.policy, eff.layers.map((l) => ({ scope: l.scope, version: l.version })))).toBe(eff.fingerprint);
    // merging the same layers reproduces the same policy (replay determinism)
    expect(mergePolicyLayers(eff.layers.map((l) => l.overrides))).toEqual(eff.policy);
  });
});
