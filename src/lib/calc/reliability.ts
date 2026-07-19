/**
 * Reliability statistics engine — pure, deterministic, versioned.
 *
 * Distinct concepts kept distinct:
 *  - Within-session CV: variation among valid comparable attempts in ONE
 *    session (SD/mean × 100).
 *  - Typical Error (TE): between-session measurement noise, estimated from
 *    consecutive eligible session pairs as SD(paired differences) ÷ √2.
 *  - SWC: the smallest change considered worthwhile — method is a POLICY
 *    decision (fraction of between-session SD, absolute, percent, or a
 *    facility-approved value); never silently chosen here.
 *  - MDC: the change detectable beyond noise at a configured confidence:
 *    z × √2 × TE. Only presented when TE and confidence are valid.
 *
 * Nothing here reads the database; services feed already-validated values.
 */

import { MetricStatPolicy, SwcMethod, STAT_POLICY_VERSION } from "../config/statPolicies";

export const RELIABILITY_CALC_VERSION = "1.0.0";

const Z: Record<number, number> = { 80: 1.282, 90: 1.645, 95: 1.96, 99: 2.576 };

const sd = (xs: number[], mean: number) => Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));

/* ---------------- within-session CV ---------------- */

export interface CvResult {
  available: boolean;
  reason: string | null;
  attemptCount: number;
  mean: number | null;
  sd: number | null;
  cvPct: number | null;
}

export function withinSessionCv(validAttemptValues: number[], policy: MetricStatPolicy): CvResult {
  const n = validAttemptValues.length;
  if (n < policy.minAttemptsPerSession) {
    return { available: false, reason: `only ${n} valid attempt(s); ${policy.minAttemptsPerSession} required`, attemptCount: n, mean: null, sd: null, cvPct: null };
  }
  const mean = validAttemptValues.reduce((a, b) => a + b, 0) / n;
  if (Math.abs(mean) < policy.minDenominator) {
    return { available: false, reason: "mean too close to zero for a valid CV", attemptCount: n, mean, sd: null, cvPct: null };
  }
  const s = sd(validAttemptValues, mean);
  return { available: true, reason: null, attemptCount: n, mean, sd: s, cvPct: (s / Math.abs(mean)) * 100 };
}

/* ---------------- typical error ---------------- */

export interface TeResult {
  available: boolean;
  reason: string | null;
  pairCount: number;
  te: number | null;
  pairingMethod: "consecutive_eligible_sessions";
}

/** Consecutive eligible session values → ordered pairs [earlier, later]. */
export function buildSessionPairs(values: number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 1; i < values.length; i++) pairs.push([values[i - 1], values[i]]);
  return pairs;
}

export function typicalError(pairs: [number, number][], policy: MetricStatPolicy): TeResult {
  if (policy.teMethod === "none") {
    return { available: false, reason: "TE not enabled by policy for this metric", pairCount: pairs.length, te: null, pairingMethod: "consecutive_eligible_sessions" };
  }
  if (pairs.length < 2) {
    return { available: false, reason: `only ${pairs.length} session pair(s); at least 2 required`, pairCount: pairs.length, te: null, pairingMethod: "consecutive_eligible_sessions" };
  }
  const diffs = pairs.map(([a, b]) => b - a);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const te = sd(diffs, mean) / Math.SQRT2;
  return { available: true, reason: null, pairCount: pairs.length, te, pairingMethod: "consecutive_eligible_sessions" };
}

/* ---------------- SWC ---------------- */

export interface SwcResult {
  available: boolean;
  reason: string | null;
  method: SwcMethod["kind"];
  value: number | null;
}

export function smallestWorthwhileChange(sessionValues: number[], method: SwcMethod): SwcResult {
  switch (method.kind) {
    case "none":
      return { available: false, reason: "no approved SWC method is configured for this metric", method: "none", value: null };
    case "absolute":
      return { available: true, reason: null, method: "absolute", value: method.value };
    case "facility_value":
      return { available: true, reason: null, method: "facility_value", value: method.value };
    case "percent": {
      if (sessionValues.length === 0) return { available: false, reason: "no sessions for a percent-based SWC", method: "percent", value: null };
      const mean = sessionValues.reduce((a, b) => a + b, 0) / sessionValues.length;
      if (Math.abs(mean) < 1e-9) return { available: false, reason: "mean too close to zero for a percent-based SWC", method: "percent", value: null };
      return { available: true, reason: null, method: "percent", value: Math.abs(mean) * (method.pct / 100) };
    }
    case "between_sd_fraction": {
      if (sessionValues.length < 3) return { available: false, reason: `only ${sessionValues.length} sessions; between-session SD needs at least 3`, method: "between_sd_fraction", value: null };
      const mean = sessionValues.reduce((a, b) => a + b, 0) / sessionValues.length;
      return { available: true, reason: null, method: "between_sd_fraction", value: sd(sessionValues, mean) * method.factor };
    }
  }
}

/* ---------------- MDC ---------------- */

export interface MdcResult {
  available: boolean;
  reason: string | null;
  confidence: number | null;
  mdc: number | null;
}

export function minimalDetectableChange(te: TeResult, confidence: MetricStatPolicy["mdcConfidence"]): MdcResult {
  if (confidence == null) return { available: false, reason: "no MDC confidence configured for this metric", confidence: null, mdc: null };
  if (!te.available || te.te == null) return { available: false, reason: te.reason ?? "TE unavailable", confidence, mdc: null };
  const z = Z[confidence];
  if (!z) return { available: false, reason: `unsupported confidence ${confidence}`, confidence, mdc: null };
  return { available: true, reason: null, confidence, mdc: z * Math.SQRT2 * te.te };
}

/* ---------------- observed change vs expected noise ---------------- */

export type NoiseState =
  | "exceeds_threshold"
  | "within_noise"
  | "reliability_unavailable"
  | "reliability_poor";

export interface NoiseAssessment {
  state: NoiseState;
  gate: "te" | "mdc" | "swc" | "none";
  threshold: number | null;
  observedChange: number;
  detail: string;
}

/**
 * Judge an observed change against the CONFIGURED noise gate. When no gate
 * is configured ("none"), the honest state is reliability_unavailable —
 * range information may still be shown, but no noise claim is allowed.
 */
export function assessChangeVsNoise(
  observedChange: number,
  gate: "te" | "mdc" | "swc" | "none",
  stats: { te?: TeResult; mdc?: MdcResult; swc?: SwcResult; cvPoor?: boolean }
): NoiseAssessment {
  if (stats.cvPoor) {
    return { state: "reliability_poor", gate, threshold: null, observedChange, detail: "within-session reliability is poor for this metric — interpret changes cautiously" };
  }
  const threshold =
    gate === "te" ? (stats.te?.available ? stats.te.te : null)
      : gate === "mdc" ? (stats.mdc?.available ? stats.mdc.mdc : null)
        : gate === "swc" ? (stats.swc?.available ? stats.swc.value : null)
          : null;
  if (gate === "none" || threshold == null) {
    return {
      state: "reliability_unavailable",
      gate,
      threshold: null,
      observedChange,
      detail: gate === "none" ? "no noise gate is configured — range position can be shown, but not whether the change exceeds measurement noise" : "the configured gate's statistic is unavailable",
    };
  }
  const exceeds = Math.abs(observedChange) > threshold;
  return {
    state: exceeds ? "exceeds_threshold" : "within_noise",
    gate,
    threshold,
    observedChange,
    detail: exceeds
      ? `|change| ${Math.abs(observedChange).toFixed(3)} exceeds the configured ${gate.toUpperCase()} threshold ${threshold.toFixed(3)}`
      : `|change| ${Math.abs(observedChange).toFixed(3)} is within the configured ${gate.toUpperCase()} threshold ${threshold.toFixed(3)}`,
  };
}

/* ---------------- eligibility + result contract ---------------- */

export type ReliabilityAvailability =
  | "eligible"
  | "insufficient_history"
  | "poor_within_session_reliability"
  | "unsupported_by_policy"
  | "invalid_comparability";

export interface ReliabilityResult {
  metricKey: string;
  testType: string;
  calcVersion: string;
  policyVersion: string;
  sourceSessionCount: number;
  sourceAttemptCount: number;
  dateRange: { from: string | null; to: string | null };
  unit: string;
  availability: ReliabilityAvailability;
  availabilityReason: string | null;
  /** warn (do not remove): within-session CV above the policy threshold */
  reliabilityWarning: boolean;
  latestSessionCv: CvResult | null;
  /** mean of per-session CVs across the window (context, not a gate) */
  meanSessionCvPct: number | null;
  te: TeResult;
  swc: SwcResult;
  mdc: MdcResult;
  excludedSessions: { date: string; reason: string }[];
}

export interface ReliabilityInputs {
  metricKey: string;
  testType: string;
  unit: string;
  /** eligible sessions ascending; attemptValues are VALID attempts only */
  sessions: { date: string; sessionBest: number; attemptValues: number[] }[];
  excludedSessions: { date: string; reason: string }[];
  /** false when the comparability gate failed for the window */
  comparable: boolean;
  comparabilityReason?: string;
}

export function computeReliability(inputs: ReliabilityInputs, policy: MetricStatPolicy | null): ReliabilityResult {
  const base: Omit<ReliabilityResult, "availability" | "availabilityReason"> = {
    metricKey: inputs.metricKey,
    testType: inputs.testType,
    calcVersion: RELIABILITY_CALC_VERSION,
    policyVersion: STAT_POLICY_VERSION,
    sourceSessionCount: inputs.sessions.length,
    sourceAttemptCount: inputs.sessions.reduce((a, s) => a + s.attemptValues.length, 0),
    dateRange: { from: inputs.sessions[0]?.date ?? null, to: inputs.sessions[inputs.sessions.length - 1]?.date ?? null },
    unit: inputs.unit,
    reliabilityWarning: false,
    latestSessionCv: null,
    meanSessionCvPct: null,
    te: { available: false, reason: "not computed", pairCount: 0, te: null, pairingMethod: "consecutive_eligible_sessions" },
    swc: { available: false, reason: "not computed", method: "none", value: null },
    mdc: { available: false, reason: "not computed", confidence: null, mdc: null },
    excludedSessions: inputs.excludedSessions,
  };

  if (!policy) {
    return { ...base, availability: "unsupported_by_policy", availabilityReason: "no statistical policy is registered for this metric" };
  }
  if (!inputs.comparable) {
    return { ...base, availability: "invalid_comparability", availabilityReason: inputs.comparabilityReason ?? "sessions in the window are not comparable" };
  }

  const cvs = inputs.sessions.map((s) => withinSessionCv(s.attemptValues, policy));
  const availableCvs = cvs.filter((c) => c.available);
  const latestSessionCv = cvs.length ? cvs[cvs.length - 1] : null;
  const meanSessionCvPct = availableCvs.length
    ? availableCvs.reduce((a, c) => a + c.cvPct!, 0) / availableCvs.length
    : null;
  const bests = inputs.sessions.map((s) => s.sessionBest);
  const te = typicalError(buildSessionPairs(bests), policy);
  const swc = smallestWorthwhileChange(bests, policy.swc);
  const mdc = minimalDetectableChange(te, policy.mdcConfidence);
  const reliabilityWarning = meanSessionCvPct != null && meanSessionCvPct > policy.cvWarnPct;

  const availability: ReliabilityAvailability =
    inputs.sessions.length < policy.minSessions
      ? "insufficient_history"
      : reliabilityWarning
        ? "poor_within_session_reliability"
        : "eligible";

  return {
    ...base,
    latestSessionCv,
    meanSessionCvPct,
    te,
    swc,
    mdc,
    reliabilityWarning,
    availability,
    availabilityReason:
      availability === "insufficient_history"
        ? `${inputs.sessions.length} of ${policy.minSessions} required eligible sessions`
        : availability === "poor_within_session_reliability"
          ? `mean within-session CV ${meanSessionCvPct!.toFixed(1)}% exceeds the ${policy.cvWarnPct}% warning threshold — do not overinterpret this metric`
          : null,
  };
}
