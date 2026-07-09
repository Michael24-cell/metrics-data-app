/**
 * Signal utilities shared by force-time calculations.
 * All functions are pure and deterministic.
 */

export const GRAVITY = 9.80665; // m/s²

export interface ForceTimeSeries {
  /** sampling rate in Hz */
  hz: number;
  /** total vertical ground reaction force in N (sum of both plates for bilateral) */
  force: number[];
  /** optional per-side force for dual-plate trials */
  left?: number[];
  right?: number[];
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Estimate quiet-standing body weight (N) from the first `windowS` seconds.
 * Returns mean and SD of the quiet period.
 */
export function quietStanding(series: ForceTimeSeries, windowS = 1.0): { bw: number; sd: number } {
  const n = Math.min(Math.round(windowS * series.hz), series.force.length);
  const quiet = series.force.slice(0, n);
  return { bw: mean(quiet), sd: sd(quiet) };
}

/**
 * Onset detection: first sample where force exceeds (bw + k·SD of quiet standing)
 * and stays above it for `holdMs`. Deterministic; k=5 by default per methodology.
 */
export function detectOnset(
  series: ForceTimeSeries,
  bw: number,
  quietSd: number,
  k = 5,
  holdMs = 20
): number {
  const threshold = bw + k * quietSd;
  const hold = Math.max(1, Math.round((holdMs / 1000) * series.hz));
  const f = series.force;
  for (let i = 0; i < f.length - hold; i++) {
    if (f[i] > threshold) {
      let ok = true;
      for (let j = i; j < i + hold; j++) {
        if (f[j] <= threshold) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

/**
 * Integrate net force (F − bw) to velocity via trapezoidal rule.
 * Returns velocity (m/s) at each sample, starting from v=0 at index `from`.
 */
export function velocityFromForce(
  series: ForceTimeSeries,
  bw: number,
  from = 0,
  to?: number
): number[] {
  const massKg = bw / GRAVITY;
  const dt = 1 / series.hz;
  const end = to ?? series.force.length;
  const v: number[] = new Array(end - from).fill(0);
  for (let i = from + 1; i < end; i++) {
    const netPrev = series.force[i - 1] - bw;
    const netCur = series.force[i] - bw;
    v[i - from] = v[i - from - 1] + ((netPrev + netCur) / 2) * (dt / massKg);
  }
  return v;
}

/** Trapezoidal integral of (force − offset) over [from, to) in N·s. */
export function impulse(series: ForceTimeSeries, offset: number, from: number, to: number): number {
  const dt = 1 / series.hz;
  let acc = 0;
  for (let i = from + 1; i < to; i++) {
    acc += ((series.force[i - 1] - offset + (series.force[i] - offset)) / 2) * dt;
  }
  return acc;
}

/** Simple centered moving average used only for DISPLAY smoothing, never for calculation. */
export function movingAverage(xs: number[], window: number): number[] {
  if (window <= 1) return xs.slice();
  const half = Math.floor(window / 2);
  return xs.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(xs.length, i + half + 1);
    return mean(xs.slice(from, to));
  });
}

export interface SanityCheck {
  ok: boolean;
  reason?: string;
}

export function checkSanity(value: number, min: number, max: number): SanityCheck {
  if (!Number.isFinite(value)) return { ok: false, reason: "non-finite value" };
  if (value < min || value > max)
    return { ok: false, reason: `value ${value} outside plausible range [${min}, ${max}]` };
  return { ok: true };
}
