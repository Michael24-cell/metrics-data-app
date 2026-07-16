/**
 * Metric registry — the single source of truth for what a metric IS.
 *
 * Everything that renders, validates, or explains a metric reads from this
 * config. Adding a new metric means adding an entry here plus a calculation
 * function; no UI or findings code should hardcode metric identity.
 *
 * Test-first registry: metrics carry `testType`; `metricsForTest()` and
 * friends derive test→metric groupings from that single field so no second,
 * hand-maintained metric list exists anywhere. Cross-cutting arrays that used
 * to be hand-maintained (e.g. asymmetry-eligible source metrics) are now
 * DERIVED from per-metric flags below — see `ASYMMETRY_SOURCE_METRICS`.
 */

export type MetricSide = "left" | "right" | "bilateral";
export type MetricVisibility = "primary" | "advanced";

export interface SanityRange {
  min: number;
  max: number;
}

export interface MetricDef {
  /** canonical metric_type key stored in the DB */
  key: string;
  label: string;
  shortLabel: string;
  unit: string;
  /** decimal places for display */
  precision: number;
  /** test type this metric is computed from */
  testType: string;
  /** whether higher values are better (drives trend/deviation direction) */
  higherIsBetter: boolean;
  /** plausible physiological range; values outside are quality-flagged, not silently dropped */
  sanity: SanityRange;
  /**
   * A REAL per-side (left/right) value is computed and stored for this
   * metric — not merely "could in principle be sided." This flag must only
   * be true when the calculation function actually inserts left/right rows;
   * see the registry-consistency test in metrics.test.ts.
   */
  sided: boolean;
  /** current calculation method version (semver, bumped on any formula change) */
  methodVersion: string;
  /** plain-language description shown in tooltips / methodology */
  description: string;
  /** trainability / interpretation note surfaced wherever the metric is displayed */
  interpretation?: string;
  /** implemented = real calculation; provisional = scaffolded, clearly labeled */
  status: "implemented" | "provisional";
  /** trainer-facing "primary" metrics appear in normal selectors; "advanced" ones (RFD, derived indices) do not */
  visibility: MetricVisibility;
  /**
   * This metric is offered for asymmetry analysis (magnitude, stronger side,
   * direction changes). Must imply `sided: true` — asymmetry can never be
   * computed from a metric with no real per-side calculation. Decoupled from
   * `sided` so a metric can be genuinely sided without necessarily being
   * asymmetry-eligible, though today every sided metric is.
   */
  asymmetryEligible: boolean;
  /** appears in longitudinal trend charts (session-best series over time) */
  trendEligible: boolean;
  /** eligible for future whole-team / cohort comparison (roster contract, not built this phase) */
  cohortComparable: boolean;
  /** for an absolute metric, the key of its body-mass-normalized counterpart, if one exists */
  normalizedKey?: string;
  /** groups this metric under one trainer-facing selector entry — see METRIC_GROUPS */
  group?: string;
}

/** Fixed-time IMTP force points (ms after onset) → their absolute metric key. NOT RFD. */
export const IMTP_FORCE_POINT_KEYS: Record<number, string> = {
  50: "imtp_force_at_50ms",
  100: "imtp_force_at_100ms",
  150: "imtp_force_at_150ms",
  200: "imtp_force_at_200ms",
  250: "imtp_force_at_250ms",
  300: "imtp_force_at_300ms",
};

function imtpForcePointMetric(ms: number): [string, MetricDef] {
  const key = IMTP_FORCE_POINT_KEYS[ms];
  const relKey = `${key}_rel`;
  return [
    key,
    {
      key,
      label: `IMTP Force at ${ms} ms`,
      shortLabel: `Force @${ms}ms`,
      unit: "N",
      precision: 0,
      testType: "imtp",
      higherIsBetter: true,
      // Provisional sanity band pending practitioner-sourced ranges for
      // each fixed time point; earlier points plausibly sit well below peak
      // force. Do not treat as validated — see docs/METHODOLOGY.md.
      sanity: { min: 100, max: 9000 },
      sided: true,
      methodVersion: "1.0.0",
      description: `Absolute vertical force ${ms} ms after IMTP force onset (onset from the existing validated detector). Not a rate — a force reading at a fixed instant.`,
      status: "implemented",
      visibility: "primary",
      asymmetryEligible: true,
      trendEligible: true,
      cohortComparable: true,
      normalizedKey: relKey,
      group: "imtp_force_window",
    },
  ];
}

function imtpForcePointRelativeMetric(ms: number): [string, MetricDef] {
  const key = IMTP_FORCE_POINT_KEYS[ms];
  const relKey = `${key}_rel`;
  return [
    relKey,
    {
      key: relKey,
      label: `IMTP Force at ${ms} ms (relative)`,
      shortLabel: `Force @${ms}ms (rel.)`,
      unit: "N/kg",
      precision: 2,
      testType: "imtp",
      higherIsBetter: true,
      sanity: { min: 1, max: 100 },
      sided: false, // bilateral-only; no per-side relative form is computed
      methodVersion: "1.0.0",
      description: `Force at ${ms} ms after IMTP onset, normalized to body mass (N/kg).`,
      status: "implemented",
      // Reachable via the absolute point's normalizedKey rather than
      // cluttering the primary selector with a second entry per time point.
      visibility: "advanced",
      asymmetryEligible: false,
      trendEligible: true,
      cohortComparable: true,
      group: "imtp_force_window",
    },
  ];
}

export const METRICS: Record<string, MetricDef> = {
  cmj_jump_height: {
    key: "cmj_jump_height",
    label: "CMJ Jump Height (Impulse–Momentum)",
    shortLabel: "Jump Height",
    unit: "cm",
    precision: 1,
    testType: "cmj",
    higherIsBetter: true,
    sanity: { min: 5, max: 70 },
    sided: false,
    methodVersion: "1.0.0",
    description:
      "Jump height derived from net vertical impulse during propulsion (takeoff velocity via impulse–momentum, h = v²/2g). Not flight-time based.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  cmj_mrsi: {
    key: "cmj_mrsi",
    label: "Modified Reactive Strength Index",
    shortLabel: "mRSI",
    unit: "m/s",
    precision: 2,
    testType: "cmj",
    higherIsBetter: true,
    sanity: { min: 0.1, max: 1.2 },
    sided: false,
    methodVersion: "1.0.0",
    description:
      "Jump height (m) divided by time to takeoff (s). Reveals jump strategy, not just output.",
    interpretation:
      "mRSI reveals strategy: a lower mRSI with normal jump height suggests a deep, force-reliant countermovement; a higher mRSI suggests a reflexive, stretch-shortening-reliant strategy. Track the strategy, not just the height.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  cmj_time_to_takeoff: {
    key: "cmj_time_to_takeoff",
    label: "CMJ Time to Takeoff",
    shortLabel: "Time to Takeoff",
    unit: "ms",
    precision: 0,
    testType: "cmj",
    higherIsBetter: false,
    // Provisional band pending practitioner-sourced ranges.
    sanity: { min: 200, max: 2000 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Detected movement onset to detected takeoff, from the full-rate signal.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  cmj_ecc_braking_impulse: {
    key: "cmj_ecc_braking_impulse",
    label: "Eccentric Braking Impulse",
    shortLabel: "Ecc. Braking Impulse",
    unit: "N·s",
    precision: 1,
    testType: "cmj",
    higherIsBetter: true,
    sanity: { min: 10, max: 400 },
    sided: true,
    methodVersion: "1.0.0",
    description:
      "Net impulse absorbed during the braking phase of the countermovement (peak negative velocity → zero velocity).",
    interpretation:
      "A force-absorption / deceleration measure relevant to change-of-direction capacity — the ability to absorb force rapidly. It is a capacity measure, not a movement-quality assessment, and not a diagnosis, injury-prediction, or clearance metric.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: true,
    trendEligible: true,
    cohortComparable: true,
  },
  cmj_peak_propulsive_force: {
    key: "cmj_peak_propulsive_force",
    label: "CMJ Peak Propulsive Force",
    shortLabel: "Peak Prop. Force",
    unit: "N",
    precision: 0,
    testType: "cmj",
    higherIsBetter: true,
    sanity: { min: 500, max: 8000 },
    sided: true,
    methodVersion: "1.0.0",
    description: "Peak vertical ground reaction force during the propulsive phase.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: true,
    trendEligible: true,
    cohortComparable: true,
  },
  imtp_peak_force: {
    key: "imtp_peak_force",
    label: "IMTP Peak Force",
    shortLabel: "Peak Force",
    unit: "N",
    precision: 0,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 800, max: 9000 },
    sided: true,
    methodVersion: "1.0.0",
    description:
      "Highest net vertical force produced during the isometric mid-thigh pull, after onset detection.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: true,
    trendEligible: true,
    cohortComparable: true,
    normalizedKey: "imtp_relative_force",
  },
  imtp_relative_force: {
    key: "imtp_relative_force",
    label: "IMTP Relative Peak Force",
    shortLabel: "Rel. Force",
    unit: "N/kg",
    precision: 2,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 10, max: 70 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Peak force normalized to body mass (N/kg).",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  imtp_time_to_peak_force: {
    key: "imtp_time_to_peak_force",
    label: "IMTP Time to Peak Force",
    shortLabel: "Time to Peak Force",
    unit: "ms",
    precision: 0,
    testType: "imtp",
    higherIsBetter: false,
    // Provisional band pending practitioner-sourced ranges.
    sanity: { min: 50, max: 4000 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Detected force onset to the peak-force sample, from the full-rate signal.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  ...Object.fromEntries(Object.keys(IMTP_FORCE_POINT_KEYS).map((ms) => imtpForcePointMetric(Number(ms)))),
  ...Object.fromEntries(Object.keys(IMTP_FORCE_POINT_KEYS).map((ms) => imtpForcePointRelativeMetric(Number(ms)))),
  imtp_rfd_0_50: {
    key: "imtp_rfd_0_50",
    label: "RFD 0–50 ms",
    shortLabel: "RFD 0–50",
    unit: "N/s",
    precision: 0,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 500, max: 30000 },
    // Corrected: no per-side RFD is computed anywhere in the pipeline today.
    // This was previously flagged sided:true without a real calculation path.
    sided: false,
    methodVersion: "1.0.0",
    description: "Average rate of force development 0–50 ms after force onset.",
    interpretation:
      "0–50 ms RFD reflects neural recruitment speed — how quickly the nervous system switches force on. Trainable with ballistic and plyometric work.",
    status: "implemented",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: false,
  },
  imtp_rfd_50_150: {
    key: "imtp_rfd_50_150",
    label: "RFD 50–150 ms",
    shortLabel: "RFD 50–150",
    unit: "N/s",
    precision: 0,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 500, max: 30000 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Average rate of force development 50–150 ms after force onset.",
    interpretation:
      "50–150 ms RFD reflects mid-phase force development. It is influenced by neuromuscular qualities and fiber-type profile, but present this as interpretation, not a fixed ceiling — expect it to respond more slowly to training than the 0–50 ms window, not to be untrainable.",
    status: "implemented",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: false,
  },
  imtp_rfd_150_250: {
    key: "imtp_rfd_150_250",
    label: "RFD 150–250 ms",
    shortLabel: "RFD 150–250",
    unit: "N/s",
    precision: 0,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 300, max: 25000 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Average rate of force development 150–250 ms after force onset.",
    interpretation:
      "150–250 ms RFD depends on muscle cross-sectional area and maximal strength. Trainable with heavy resistance work.",
    status: "implemented",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: false,
  },
  dj_rsi: {
    key: "dj_rsi",
    label: "Drop Jump Reactive Strength Index",
    shortLabel: "DJ RSI",
    unit: "",
    precision: 2,
    testType: "drop_jump",
    higherIsBetter: true,
    sanity: { min: 0.3, max: 4.0 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Flight time divided by ground contact time for a drop jump.",
    interpretation:
      "Distinct from CMJ mRSI: RSI here is flight time ÷ ground contact time (a drop-jump measure), while mRSI is jump height ÷ time to takeoff (a countermovement-jump measure). They reflect different jump strategies and should not be collapsed into the same number or compared directly.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: true,
  },
  asymmetry_index: {
    key: "asymmetry_index",
    label: "Asymmetry Index",
    shortLabel: "Asymmetry",
    unit: "%",
    precision: 1,
    testType: "derived",
    higherIsBetter: false,
    sanity: { min: 0, max: 60 },
    sided: false,
    methodVersion: "1.0.0",
    description:
      "abs(stronger − weaker) / (0.5 × (stronger + weaker)) × 100, computed per source metric per session.",
    status: "implemented",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: false,
  },
  fv_profile_slope: {
    key: "fv_profile_slope",
    label: "Force–Velocity Profile Slope",
    shortLabel: "F–V Slope",
    unit: "N·s/m/kg",
    precision: 2,
    testType: "fv_profile",
    higherIsBetter: false,
    sanity: { min: -60, max: 0 },
    sided: false,
    methodVersion: "0.1.0-provisional",
    description:
      "PROVISIONAL — linear F–V relationship fitted across loaded jumps. Requires multi-load jump testing; scaffolded pending protocol data.",
    status: "provisional",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: false,
    cohortComparable: false,
  },
  lv_mean_velocity: {
    key: "lv_mean_velocity",
    label: "Mean Concentric Velocity",
    shortLabel: "Mean Velocity",
    unit: "m/s",
    precision: 2,
    testType: "vbt",
    higherIsBetter: true,
    sanity: { min: 0.05, max: 3.0 },
    sided: false,
    methodVersion: "1.0.0",
    description: "Mean concentric barbell velocity per rep, from a linear transducer or equivalent.",
    status: "implemented",
    visibility: "primary",
    asymmetryEligible: false,
    trendEligible: true,
    cohortComparable: false,
  },
  lv_profile_slope: {
    key: "lv_profile_slope",
    label: "Load–Velocity Profile Slope",
    shortLabel: "L–V Slope",
    unit: "(m/s)/kg",
    precision: 4,
    testType: "vbt",
    higherIsBetter: false,
    sanity: { min: -0.05, max: 0 },
    sided: false,
    methodVersion: "0.1.0-provisional",
    description:
      "PROVISIONAL — least-squares slope of load vs mean velocity per exercise. Estimated 1RM extrapolation intentionally not surfaced in V1.",
    status: "provisional",
    visibility: "advanced",
    asymmetryEligible: false,
    trendEligible: false,
    cohortComparable: false,
  },
};

export function metricDef(key: string): MetricDef {
  const def = METRICS[key];
  if (!def) throw new Error(`Unknown metric_type: ${key}`);
  return def;
}

/**
 * Metrics that participate in general asymmetry monitoring, DERIVED from
 * each metric's `asymmetryEligible` flag — not a second hand-maintained
 * list. Order follows registry insertion order.
 */
export const ASYMMETRY_SOURCE_METRICS: string[] = Object.values(METRICS)
  .filter((m) => m.asymmetryEligible)
  .map((m) => m.key);

/** Default metric used for baseline-deviation monitoring per test type. */
export const BASELINE_MONITORED_METRICS = ["cmj_jump_height", "cmj_mrsi"];

export interface TestTypeDef {
  key: string;
  label: string;
  /** metric shown when a trainer picks this test with no explicit metric selected */
  defaultMetric?: string;
  /** this test produces a force-time waveform eligible for the future curve workspace */
  curveEligible: boolean;
}

export const TEST_TYPES: Record<string, TestTypeDef> = {
  cmj: { key: "cmj", label: "Countermovement Jump", defaultMetric: "cmj_jump_height", curveEligible: true },
  imtp: { key: "imtp", label: "Isometric Mid-Thigh Pull", defaultMetric: "imtp_peak_force", curveEligible: true },
  drop_jump: { key: "drop_jump", label: "Drop Jump", defaultMetric: "dj_rsi", curveEligible: false },
  vbt: { key: "vbt", label: "Velocity-Based Training", defaultMetric: "lv_mean_velocity", curveEligible: false },
  fv_profile: { key: "fv_profile", label: "Force–Velocity Profile", defaultMetric: "fv_profile_slope", curveEligible: false },
  derived: { key: "derived", label: "Derived", curveEligible: false },
};

export const DEVICE_TYPES: Record<string, { key: string; label: string }> = {
  dual_force_plate: { key: "dual_force_plate", label: "Dual Force Plate" },
  single_force_plate: { key: "single_force_plate", label: "Single Force Plate" },
  linear_transducer: { key: "linear_transducer", label: "Linear Position Transducer" },
  manual: { key: "manual", label: "Manual Entry" },
};

/* ------------------------------------------------------------------ */
/* Metric groups — bundle several metric keys under one trainer-facing */
/* selector entry (e.g. the six IMTP fixed-time-force points).          */
/* ------------------------------------------------------------------ */

export interface MetricGroupDef {
  key: string;
  label: string;
  testType: string;
  /** ordered member metric keys (the absolute forms; relative forms are reachable via normalizedKey) */
  memberKeys: string[];
  defaultMemberKey: string;
}

export const METRIC_GROUPS: Record<string, MetricGroupDef> = {
  imtp_force_window: {
    key: "imtp_force_window",
    label: "Force 0–300 ms",
    testType: "imtp",
    memberKeys: Object.values(IMTP_FORCE_POINT_KEYS),
    defaultMemberKey: IMTP_FORCE_POINT_KEYS[100],
  },
};

/* ------------------------------------------------------------------ */
/* Test-first registry helpers                                         */
/* ------------------------------------------------------------------ */

/** All metrics belonging to one test type (including advanced/grouped ones). */
export function metricsForTest(testType: string): MetricDef[] {
  return Object.values(METRICS).filter((m) => m.testType === testType);
}

export interface PrimarySelectorEntry {
  key: string;
  label: string;
  kind: "metric" | "group";
}

/**
 * Trainer-facing selector list for a test: primary, ungrouped metrics plus
 * one entry per metric group (not its individual members). This is what a
 * test-first metric dropdown should render — RFD and other advanced/derived
 * metrics never appear here.
 */
export function primaryMetricsForTest(testType: string): PrimarySelectorEntry[] {
  const seenGroups = new Set<string>();
  const out: PrimarySelectorEntry[] = [];
  for (const m of metricsForTest(testType)) {
    if (m.visibility !== "primary") continue;
    if (m.group) {
      if (seenGroups.has(m.group)) continue;
      seenGroups.add(m.group);
      const g = METRIC_GROUPS[m.group];
      out.push({ key: g.key, label: g.label, kind: "group" });
    } else {
      out.push({ key: m.key, label: m.shortLabel, kind: "metric" });
    }
  }
  return out;
}

/** Advanced/derived metrics for a test (RFD, asymmetry_index, provisional profile slopes, etc). */
export function advancedMetricsForTest(testType: string): MetricDef[] {
  return metricsForTest(testType).filter((m) => m.visibility === "advanced");
}

/** Default metric key for a test, if one is configured. */
export function defaultMetricForTest(testType: string): string | undefined {
  return TEST_TYPES[testType]?.defaultMetric;
}
