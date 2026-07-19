/**
 * Statistical policy registry (versioned, client-safe).
 *
 * Defines, PER METRIC, which reliability methods apply and with what
 * parameters. Nothing here silently activates an unapproved method:
 *  - CV (within-session SD/mean) and TE (paired-diff SD ÷ √2) are enabled
 *    because their formulas are fixed by the product requirements.
 *  - SWC has NO universal default: `swc.kind = "none"` until a facility-
 *    approved method is configured (supported kinds are implemented).
 *  - MDC requires an explicitly configured confidence; the registry ships
 *    entries with confidence 95 marked PROVISIONAL — facilities must approve
 *    before treating MDC as decision-grade (see docs/METHODOLOGY.md).
 *  - cvWarnPct values are PROVISIONAL defaults (10% unless noted) pending
 *    facility-approved, metric-specific thresholds. They gate a warning
 *    label only — never silent removal of a metric.
 *
 * Absolute and body-mass-normalized metrics keep SEPARATE entries — their
 * variability profiles are not interchangeable.
 */

export const STAT_POLICY_VERSION = "1.0.0";

export type SwcMethod =
  | { kind: "none" }
  | { kind: "between_sd_fraction"; factor: number } // e.g. 0.2 × between-session SD
  | { kind: "absolute"; value: number }
  | { kind: "percent"; pct: number }
  | { kind: "facility_value"; value: number; approvedBy: string };

export interface MetricStatPolicy {
  metricKey: string;
  /** minimum valid comparable attempts within a session for CV */
  minAttemptsPerSession: number;
  /** minimum eligible sessions before between-session statistics exist */
  minSessions: number;
  cvMethod: "within_session_sd_over_mean";
  teMethod: "paired_diff_sd_div_sqrt2" | "none";
  swc: SwcMethod;
  /** null = MDC not presented for this metric */
  mdcConfidence: 80 | 90 | 95 | 99 | null;
  /** PROVISIONAL warning threshold: within-session CV above this warns coaches */
  cvWarnPct: number;
  /** |mean| below this makes CV meaningless (near-zero denominator) */
  minDenominator: number;
  provisional: boolean;
}

const entry = (metricKey: string, overrides: Partial<MetricStatPolicy> = {}): MetricStatPolicy => ({
  metricKey,
  minAttemptsPerSession: 2,
  minSessions: 5,
  cvMethod: "within_session_sd_over_mean",
  teMethod: "paired_diff_sd_div_sqrt2",
  swc: { kind: "none" }, // no universal SWC definition is silently selected
  mdcConfidence: 95, // PROVISIONAL — requires facility approval to be decision-grade
  cvWarnPct: 10,
  minDenominator: 1e-3,
  provisional: true,
  ...overrides,
});

/** Monitoring-eligible metrics with configured statistical policies. */
export const STAT_POLICIES: Record<string, MetricStatPolicy> = Object.fromEntries(
  [
    entry("cmj_jump_height"),
    entry("cmj_mrsi"),
    entry("cmj_time_to_takeoff"),
    entry("cmj_ecc_braking_impulse"),
    entry("cmj_peak_propulsive_force"),
    entry("imtp_peak_force"),
    entry("imtp_relative_force"),
    entry("imtp_time_to_peak_force"),
    entry("imtp_force_at_50ms"),
    entry("imtp_force_at_100ms"),
    entry("imtp_force_at_150ms"),
    entry("imtp_force_at_200ms"),
    entry("imtp_force_at_250ms"),
    entry("imtp_force_at_300ms"),
    entry("imtp_force_at_50ms_rel"),
    entry("imtp_force_at_100ms_rel"),
    entry("imtp_force_at_150ms_rel"),
    entry("imtp_force_at_200ms_rel"),
    entry("imtp_force_at_250ms_rel"),
    entry("imtp_force_at_300ms_rel"),
    entry("dj_rsi", { minAttemptsPerSession: 2 }),
  ].map((p) => [p.metricKey, p])
);

export function statPolicyFor(metricKey: string): MetricStatPolicy | null {
  return STAT_POLICIES[metricKey] ?? null;
}
