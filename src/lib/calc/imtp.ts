/**
 * IMTP (Isometric Mid-Thigh Pull) calculations.
 * Method version: imtp@1.0.0
 *
 * Protocol assumptions (documented in METHODOLOGY.md):
 * - Trial begins with ≥1 s quiet standing at test posture for BW estimation.
 * - Onset = force > BW + 5·SD(quiet) sustained ≥20 ms.
 * - RFD windows are average slopes: (F(t₂) − F(onset)) / (t₂ − t₁) over the window,
 *   using net force above baseline.
 */

import { ForceTimeSeries, quietStanding, detectOnset, GRAVITY } from "./signal";

export const IMTP_METHOD_VERSION = "1.0.0";

/** Fixed time points (ms after onset) reported as absolute force — NOT RFD. */
export const IMTP_FORCE_POINTS_MS = [50, 100, 150, 200, 250, 300] as const;

export interface ImtpForcePoint {
  ms: number;
  /** absolute force at onset+ms, N */
  forceN: number;
  forceLeftN?: number;
  forceRightN?: number;
}

export interface ImtpResult {
  methodVersion: string;
  bodyWeightN: number;
  bodyMassKg: number;
  onsetIndex: number;
  /** absolute peak force, N */
  peakForceN: number;
  /** peak force normalized to body mass, N/kg */
  relativeForceNkg: number;
  /** sample index of the peak-force instant (absolute index into series.force) */
  peakForceIndex: number;
  /** onset → peak-force sample, ms */
  timeToPeakForceMs: number;
  /** average RFD over each window, N/s (net of baseline) */
  rfd0_50: number;
  rfd50_150: number;
  rfd150_250: number;
  /** per-side peak force when dual-plate data present */
  peakForceLeftN?: number;
  peakForceRightN?: number;
  /** absolute force at each fixed time point after onset; short trials omit later points (see warnings) */
  forcePoints: ImtpForcePoint[];
  warnings: string[];
}

function windowRfd(
  series: ForceTimeSeries,
  onset: number,
  baseline: number,
  fromMs: number,
  toMs: number
): number {
  const i1 = onset + Math.round((fromMs / 1000) * series.hz);
  const i2 = onset + Math.round((toMs / 1000) * series.hz);
  if (i2 >= series.force.length) return NaN;
  const f1 = series.force[i1] - baseline;
  const f2 = series.force[i2] - baseline;
  return (f2 - f1) / ((toMs - fromMs) / 1000);
}

export function computeImtp(series: ForceTimeSeries): ImtpResult {
  const warnings: string[] = [];
  const { bw, sd: qsd } = quietStanding(series, 1.0);
  const onset = detectOnset(series, bw, qsd, 5, 20);
  if (onset < 0) {
    throw new Error("IMTP onset not detected — trial cannot be scored (quiet period too noisy or no pull).");
  }
  const massKg = bw / GRAVITY;

  const active = series.force.slice(onset);
  const peakForceN = Math.max(...active);
  // Peak-force sample index is always computed (not gated on dual-plate
  // presence) so time-to-peak-force is available for every scoreable trial.
  const peakForceIndex = onset + active.indexOf(peakForceN);
  const timeToPeakForceMs = ((peakForceIndex - onset) / series.hz) * 1000;

  const rfd0_50 = windowRfd(series, onset, bw, 0, 50);
  const rfd50_150 = windowRfd(series, onset, bw, 50, 150);
  const rfd150_250 = windowRfd(series, onset, bw, 150, 250);
  if (!Number.isFinite(rfd150_250)) warnings.push("Trial too short for 150–250 ms RFD window.");

  let peakForceLeftN: number | undefined;
  let peakForceRightN: number | undefined;
  if (series.left && series.right) {
    // Per-side peak taken at the instant of total peak force, so sides are comparable.
    peakForceLeftN = series.left[peakForceIndex];
    peakForceRightN = series.right[peakForceIndex];
  }

  // Fixed-time force points — absolute force AT each time point, never a
  // slope. Computed from the full-rate signal at import/reprocess time only;
  // points beyond the trial's length are omitted with a warning, never
  // fabricated. Per-side values require dual-plate data; missing sides are
  // never imputed.
  const forcePoints: ImtpForcePoint[] = [];
  for (const ms of IMTP_FORCE_POINTS_MS) {
    const idx = onset + Math.round((ms / 1000) * series.hz);
    if (idx >= series.force.length) {
      warnings.push(`Trial too short for force-at-${ms}ms.`);
      continue;
    }
    const point: ImtpForcePoint = { ms, forceN: series.force[idx] };
    if (series.left && series.right) {
      point.forceLeftN = series.left[idx];
      point.forceRightN = series.right[idx];
    }
    forcePoints.push(point);
  }

  return {
    methodVersion: IMTP_METHOD_VERSION,
    bodyWeightN: bw,
    bodyMassKg: massKg,
    onsetIndex: onset,
    peakForceN,
    relativeForceNkg: peakForceN / massKg,
    peakForceIndex,
    timeToPeakForceMs,
    rfd0_50,
    rfd50_150,
    rfd150_250,
    peakForceLeftN,
    peakForceRightN,
    forcePoints,
    warnings,
  };
}
