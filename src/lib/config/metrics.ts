/**
 * Metric registry — the single source of truth for what a metric IS.
 *
 * Everything that renders, validates, or explains a metric reads from this
 * config. Adding a new metric means adding an entry here plus a calculation
 * function; no UI or findings code should hardcode metric identity.
 */

export type MetricSide = "left" | "right" | "bilateral";

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
  /** metrics reported per limb support asymmetry analysis */
  sided: boolean;
  /** current calculation method version (semver, bumped on any formula change) */
  methodVersion: string;
  /** plain-language description shown in tooltips / methodology */
  description: string;
  /** trainability / interpretation note surfaced wherever the metric is displayed */
  interpretation?: string;
  /** implemented = real calculation; provisional = scaffolded, clearly labeled */
  status: "implemented" | "provisional";
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
  },
  imtp_rfd_0_50: {
    key: "imtp_rfd_0_50",
    label: "RFD 0–50 ms",
    shortLabel: "RFD 0–50",
    unit: "N/s",
    precision: 0,
    testType: "imtp",
    higherIsBetter: true,
    sanity: { min: 500, max: 30000 },
    sided: true,
    methodVersion: "1.0.0",
    description: "Average rate of force development 0–50 ms after force onset.",
    interpretation:
      "0–50 ms RFD reflects neural recruitment speed — how quickly the nervous system switches force on. Trainable with ballistic and plyometric work.",
    status: "implemented",
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
    sided: true,
    methodVersion: "1.0.0",
    description: "Average rate of force development 50–150 ms after force onset.",
    interpretation:
      "50–150 ms RFD reflects mid-phase force development. It is influenced by neuromuscular qualities and fiber-type profile, but present this as interpretation, not a fixed ceiling — expect it to respond more slowly to training than the 0–50 ms window, not to be untrainable.",
    status: "implemented",
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
    sided: true,
    methodVersion: "1.0.0",
    description: "Average rate of force development 150–250 ms after force onset.",
    interpretation:
      "150–250 ms RFD depends on muscle cross-sectional area and maximal strength. Trainable with heavy resistance work.",
    status: "implemented",
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
  },
};

export function metricDef(key: string): MetricDef {
  const def = METRICS[key];
  if (!def) throw new Error(`Unknown metric_type: ${key}`);
  return def;
}

/** Metrics that participate in general asymmetry monitoring, in display order. */
export const ASYMMETRY_SOURCE_METRICS = [
  "cmj_ecc_braking_impulse",
  "cmj_peak_propulsive_force",
  "imtp_peak_force",
];

/** Default metric used for baseline-deviation monitoring per test type. */
export const BASELINE_MONITORED_METRICS = ["cmj_jump_height", "cmj_mrsi"];

export const TEST_TYPES: Record<string, { key: string; label: string }> = {
  cmj: { key: "cmj", label: "Countermovement Jump" },
  imtp: { key: "imtp", label: "Isometric Mid-Thigh Pull" },
  drop_jump: { key: "drop_jump", label: "Drop Jump" },
  vbt: { key: "vbt", label: "Velocity-Based Training" },
  fv_profile: { key: "fv_profile", label: "Force–Velocity Profile" },
  derived: { key: "derived", label: "Derived" },
};

export const DEVICE_TYPES: Record<string, { key: string; label: string }> = {
  dual_force_plate: { key: "dual_force_plate", label: "Dual Force Plate" },
  single_force_plate: { key: "single_force_plate", label: "Single Force Plate" },
  linear_transducer: { key: "linear_transducer", label: "Linear Position Transducer" },
  manual: { key: "manual", label: "Manual Entry" },
};
