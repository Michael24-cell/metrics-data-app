/**
 * Force–velocity and load–velocity profiling — SCAFFOLDING.
 *
 * Status: PROVISIONAL (method versions 0.1.0-provisional).
 * What is implemented: deterministic least-squares fit + R², usable for
 * load–velocity progression display.
 * What is missing for full FV profiling: a multi-load jump protocol
 * (≥4 external loads), push-off distance measurement, and a validated
 * optimal-profile reference. Until those exist, results are labeled
 * provisional everywhere they appear and no training prescription is derived.
 */

export const PROFILE_METHOD_VERSION = "0.1.0-provisional";

/**
 * Planned force–velocity data-collection protocol (not yet implemented —
 * no adapter or calculation consumes this; it documents what a future
 * multi-load jump session would need to capture). Loads are percentages of
 * body weight added to the jump. Keep classification language (e.g.
 * force-deficient / velocity-deficient) provisional until a validated
 * reference profile is added — this platform does not derive or display
 * such classifications today.
 */
export const FV_PROFILE_PROTOCOL = {
  cmjLoadedSeriesPctBW: [0, 10, 20, 30, 40],
  squatJumpLoadedSeriesPctBW: [0, 20, 40, 60, 80],
  note:
    "Planned protocol only. Optimal-power-load and force-velocity profiling require this multi-load series plus a validated reference; neither is implemented in V1.",
} as const;

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

export function leastSquares(xs: number[], ys: number[]): LinearFit {
  const n = xs.length;
  if (n !== ys.length || n < 2) throw new Error("leastSquares requires ≥2 paired points.");
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) throw new Error("leastSquares: zero variance in x.");
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

export interface LoadVelocityProfile {
  methodVersion: string;
  exercise: string;
  fit: LinearFit;
  /** loads and mean velocities used */
  points: { loadKg: number; meanVelocityMs: number }[];
  provisional: true;
  provisionalNote: string;
}

/**
 * Planned VBT / load–velocity data-collection protocol (documentation only —
 * fitLoadVelocityProfile() below accepts whatever load/velocity pairs it is
 * given; it does not enforce this protocol). Loads are percentages of 1RM.
 * The 0.06 m/s progression threshold is deliberately set above the assumed
 * device standard error so a "velocity improved" reading isn't just noise —
 * do not lower it to 0.05 m/s without new evidence that the device error is
 * smaller than assumed.
 */
export const LVP_PROTOCOL = {
  loadsPctOf1RM: [30, 50, 70, 80],
  repsPerLoad: 3,
  progressionRule:
    "Increase load by 5% once mean velocity improves by ≥ 0.06 m/s for two consecutive sessions at the same load.",
  progressionThresholdMs: 0.06,
} as const;

export function fitLoadVelocityProfile(
  exercise: string,
  points: { loadKg: number; meanVelocityMs: number }[]
): LoadVelocityProfile {
  const fit = leastSquares(
    points.map((p) => p.loadKg),
    points.map((p) => p.meanVelocityMs)
  );
  return {
    methodVersion: PROFILE_METHOD_VERSION,
    exercise,
    fit,
    points,
    provisional: true,
    provisionalNote:
      "Load–velocity fit is provisional: no velocity-at-1RM anchor has been validated for this athlete/exercise, so no 1RM estimate or prescription is derived.",
  };
}
