/**
 * Individualized monitoring classification — pure, deterministic, versioned.
 *
 * Three separated layers, never conflated:
 *  1. RANGE: where the current value sits relative to the rolling reference
 *     band (mean ± k·SD of the PRECEDING window — the current session is
 *     never part of the window that judges it).
 *  2. NOISE: whether the change exceeds the CONFIGURED measurement-noise
 *     gate (TE / MDC / SWC). With no approved gate configured, range
 *     information is shown but no noise-exceedance claim is ever made.
 *  3. OPERATIONAL STATE: the trainer-facing label driving alerts.
 *
 * States: within_expected_range | review_suggested | repeated_low_signal |
 * collecting_baseline | insufficient_reliable_data.
 *
 * "Low signal" is direction-aware: the WORSE direction for the metric
 * (below the band for higher-is-better metrics, above it for
 * lower-is-better metrics such as time to takeoff).
 *
 * No readiness, injury, medical, or train/no-train meaning is attached to
 * any state — these are measured-performance labels for coach review.
 */

import { NoiseAssessment, NoiseState } from "./reliability";

export const MONITORING_CALC_VERSION = "1.0.0";
export const MONITORING_POLICY_SCHEMA_VERSION = "1.0.0";

export interface MonitoringPolicyV1 {
  schemaVersion: string;
  /** eligible-session count that completes the baseline phase */
  baselineSessions: 15 | 30;
  /** rolling reference window after baseline */
  rollingWindow: 5 | 7 | 10;
  /** which noise gate (if any) is APPROVED to gate low signals */
  noiseGate: "te" | "mdc" | "swc" | "none";
  /** reference band half-width in reference-window SDs */
  bandSdMultiplier: number;
  /** consecutive qualifying low signals that escalate to repeated_low_signal */
  consecutiveLowCount: number;
  /** when true, metrics with unavailable/poor reliability cannot generate signals */
  requireReliabilityEligible: boolean;
  /** metrics selected for monitoring (no arbitrary cap) */
  metricKeys: string[];
}

/** Product-safe default: spec-fixed values; no unapproved noise gate active. */
export const PRODUCT_DEFAULT_POLICY: MonitoringPolicyV1 = {
  schemaVersion: MONITORING_POLICY_SCHEMA_VERSION,
  baselineSessions: 15,
  rollingWindow: 5,
  noiseGate: "none",
  bandSdMultiplier: 1,
  consecutiveLowCount: 2,
  requireReliabilityEligible: true,
  metricKeys: ["cmj_jump_height"],
};

export type RangeState = "above_expected" | "within_expected" | "below_expected" | "insufficient_data";

export type MonitoringState =
  | "within_expected_range"
  | "review_suggested"
  | "repeated_low_signal"
  | "collecting_baseline"
  | "insufficient_reliable_data";

export interface MonitoringClassification {
  monitoringState: MonitoringState;
  rangeState: RangeState;
  noiseState: NoiseState;
  currentValue: number;
  referenceMean: number | null;
  referenceSd: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  referenceCount: number;
  /** baseline progress when collecting */
  baselineProgress: { have: number; need: number } | null;
  calcVersion: string;
  detail: string;
}

export interface ClassifyInputs {
  /** eligible session-best values STRICTLY BEFORE the current session, ascending */
  history: number[];
  currentValue: number;
  higherIsBetter: boolean;
  policy: MonitoringPolicyV1;
  /** configured-gate assessment of (current − reference mean); see reliability.assessChangeVsNoise */
  noise: NoiseAssessment;
  /** reliability availability for this metric ("eligible" required when the policy demands it) */
  reliabilityAvailability: "eligible" | "insufficient_history" | "poor_within_session_reliability" | "unsupported_by_policy" | "invalid_comparability";
  /** monitoring states of the immediately preceding sessions, most recent last */
  previousStates: MonitoringState[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sdOf = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : 0;
};

export function classifySession(inputs: ClassifyInputs): MonitoringClassification {
  const { history, currentValue, higherIsBetter, policy, noise, previousStates } = inputs;

  /* baseline phase: collect, show progress, NO automated signals or colors */
  if (history.length < policy.baselineSessions) {
    return {
      monitoringState: "collecting_baseline",
      rangeState: "insufficient_data",
      noiseState: noise.state,
      currentValue,
      referenceMean: null,
      referenceSd: null,
      bandLow: null,
      bandHigh: null,
      referenceCount: history.length,
      baselineProgress: { have: history.length + 1, need: policy.baselineSessions },
      calcVersion: MONITORING_CALC_VERSION,
      detail: `Collecting baseline: session ${history.length + 1} of ${policy.baselineSessions}. No automated monitoring signals are generated during baseline.`,
    };
  }

  const reference = history.slice(-policy.rollingWindow);
  const refMean = mean(reference);
  const refSd = sdOf(reference);
  const bandLow = refMean - policy.bandSdMultiplier * refSd;
  const bandHigh = refMean + policy.bandSdMultiplier * refSd;
  const rangeState: RangeState =
    currentValue > bandHigh ? "above_expected" : currentValue < bandLow ? "below_expected" : "within_expected";

  const base = {
    rangeState,
    noiseState: noise.state,
    currentValue,
    referenceMean: refMean,
    referenceSd: refSd,
    bandLow,
    bandHigh,
    referenceCount: reference.length,
    baselineProgress: null,
    calcVersion: MONITORING_CALC_VERSION,
  };

  /* reliability gate: when the policy requires eligibility and it's missing,
     the metric cannot generate signals — an explicit state, not a guess */
  if (policy.requireReliabilityEligible && inputs.reliabilityAvailability !== "eligible") {
    return {
      ...base,
      monitoringState: "insufficient_reliable_data",
      detail: `Monitoring signal withheld: reliability is '${inputs.reliabilityAvailability}' and this policy requires an eligible metric. Range position is shown for context only.`,
    };
  }

  /* direction-aware "low" = the WORSE side of the band */
  const worseBreach = higherIsBetter ? rangeState === "below_expected" : rangeState === "above_expected";

  /* the configured noise gate: with "none" configured, a range breach alone
     qualifies (and the UI must not claim noise exceedance); with a gate
     configured, the breach must also exceed the gate's threshold */
  const passesGate = policy.noiseGate === "none" ? true : noise.state === "exceeds_threshold";

  const qualifyingLow = worseBreach && passesGate;
  if (!qualifyingLow) {
    return {
      ...base,
      monitoringState: "within_expected_range",
      detail:
        rangeState === "within_expected"
          ? `Within the expected range (${bandLow.toFixed(2)}–${bandHigh.toFixed(2)}, previous ${reference.length} sessions).`
          : worseBreach
            ? `Outside the expected range in the worse direction, but the configured ${policy.noiseGate.toUpperCase()} gate was not exceeded — no signal.`
            : `Outside the expected range in the BETTER direction — not a low signal.`,
    };
  }

  /* consecutive qualifying low signals escalate */
  let consecutive = 1;
  for (let i = previousStates.length - 1; i >= 0; i--) {
    if (previousStates[i] === "review_suggested" || previousStates[i] === "repeated_low_signal") consecutive += 1;
    else break;
  }
  const repeated = consecutive >= policy.consecutiveLowCount;
  return {
    ...base,
    monitoringState: repeated ? "repeated_low_signal" : "review_suggested",
    detail: repeated
      ? `${consecutive} consecutive qualifying low signals (threshold ${policy.consecutiveLowCount}).`
      : `Current value is on the worse side of the expected range (${bandLow.toFixed(2)}–${bandHigh.toFixed(2)})${policy.noiseGate !== "none" ? ` and exceeds the configured ${policy.noiseGate.toUpperCase()} gate` : "; no noise gate is configured, so no measurement-noise claim is made"}.`,
  };
}

/** Merge policy layers: later layers override provided fields only. */
export function mergePolicyLayers(
  layers: Partial<MonitoringPolicyV1>[]
): MonitoringPolicyV1 {
  const merged: MonitoringPolicyV1 = { ...PRODUCT_DEFAULT_POLICY };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined && v !== null) (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

/** Stable fingerprint of an effective policy (stored on every result). */
export function policyFingerprint(policy: MonitoringPolicyV1, layerVersions: { scope: string; version: number }[]): string {
  const layers = layerVersions.map((l) => `${l.scope}:v${l.version}`).join("+") || "default";
  return `mon@${MONITORING_CALC_VERSION}|pol@${policy.schemaVersion}|${layers}|b${policy.baselineSessions}w${policy.rollingWindow}g${policy.noiseGate}k${policy.bandSdMultiplier}c${policy.consecutiveLowCount}`;
}
