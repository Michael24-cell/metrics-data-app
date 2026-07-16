/**
 * Live load–velocity profiling — rebuilt from stored rep data every time.
 *
 * Contract:
 *  - Input is the athlete's stored velocity reps (one session × exercise),
 *    NOT pre-authored profile points. Each point = mean velocity of the
 *    VALID reps at one distinct load.
 *  - Reps are excluded ONLY via an explicit quality flag (with the reason
 *    carried through). Statistical outliers are never auto-discarded.
 *  - Minimum 2 distinct loads. Exactly 2 → linear two-point method.
 *    3+ → least-squares fit; 4 loads is the standard fuller profile.
 *  - R² is not meaningful for 2 points and is reported only with ≥3
 *    distinct loads.
 *  - Two-point protocol guidance (light ~40% / heavy ≥80% of max) is
 *    GUIDANCE text only — never presented as measured unless a real
 *    reference max exists (none does in this build).
 *  - No 1RM prediction, no extrapolation beyond the observed load range.
 */

import { leastSquares } from "./profiles";

export const LV_LIVE_METHOD_VERSION = "1.0.0";

export interface RepObservation {
  loadKg: number;
  meanVelocityMs: number;
  /** explicit exclusion reason; null/undefined = valid */
  qualityFlag?: string | null;
}

export interface LoadPoint {
  loadKg: number;
  /** mean velocity of the valid reps at this load */
  meanVelocityMs: number;
  repCount: number;
}

export interface ExcludedRep {
  loadKg: number;
  meanVelocityMs: number;
  reason: string;
}

export interface LiveLoadVelocityProfile {
  methodVersion: string;
  status: "fitted" | "insufficient";
  /** how the line was derived; null when insufficient */
  method: "two_point" | "least_squares" | null;
  aggregation: "mean of valid reps per distinct load";
  points: LoadPoint[];
  distinctLoads: number;
  validReps: number;
  excludedReps: ExcludedRep[];
  slope: number | null;
  intercept: number | null;
  /** reported only with ≥3 distinct loads — meaningless for a two-point line */
  r2: number | null;
  /** trainer-facing data-quality and protocol notes */
  notes: string[];
}

export const TWO_POINT_GUIDANCE =
  "Two-point guidance: ideally one light load (~40% of max) and one heavy load (≥80% of max). No reference max is recorded for this athlete, so load placement is guidance only — not a measured percentage.";

export function buildLoadVelocityProfile(reps: RepObservation[]): LiveLoadVelocityProfile {
  const excludedReps: ExcludedRep[] = [];
  const valid: RepObservation[] = [];
  for (const r of reps) {
    if (r.qualityFlag) excludedReps.push({ loadKg: r.loadKg, meanVelocityMs: r.meanVelocityMs, reason: r.qualityFlag });
    else valid.push(r);
  }

  const byLoad = new Map<number, number[]>();
  for (const r of valid) {
    const arr = byLoad.get(r.loadKg) ?? [];
    arr.push(r.meanVelocityMs);
    byLoad.set(r.loadKg, arr);
  }
  const points: LoadPoint[] = [...byLoad.entries()]
    .map(([loadKg, vs]) => ({
      loadKg,
      meanVelocityMs: vs.reduce((a, b) => a + b, 0) / vs.length,
      repCount: vs.length,
    }))
    .sort((a, b) => a.loadKg - b.loadKg);

  const notes: string[] = [];
  if (excludedReps.length > 0) {
    notes.push(`${excludedReps.length} rep${excludedReps.length === 1 ? "" : "s"} excluded by explicit quality flag; no rep is ever auto-discarded as an outlier.`);
  }

  const base = {
    methodVersion: LV_LIVE_METHOD_VERSION,
    aggregation: "mean of valid reps per distinct load" as const,
    points,
    distinctLoads: points.length,
    validReps: valid.length,
    excludedReps,
  };

  if (points.length < 2) {
    notes.push(
      points.length === 0
        ? "No valid reps recorded — a profile needs at least 2 distinct loads."
        : "Only 1 distinct load recorded — a load–velocity profile needs at least 2 distinct loads."
    );
    return { ...base, status: "insufficient", method: null, slope: null, intercept: null, r2: null, notes };
  }

  if (points.length === 2) {
    const [p1, p2] = points;
    const slope = (p2.meanVelocityMs - p1.meanVelocityMs) / (p2.loadKg - p1.loadKg);
    const intercept = p1.meanVelocityMs - slope * p1.loadKg;
    notes.push("Two-point linear method: the line passes exactly through both observed points. R² is not meaningful for 2 points and is not shown.");
    notes.push(TWO_POINT_GUIDANCE);
    return { ...base, status: "fitted", method: "two_point", slope, intercept, r2: null, notes };
  }

  const fit = leastSquares(points.map((p) => p.loadKg), points.map((p) => p.meanVelocityMs));
  if (points.length === 3) {
    notes.push("3 distinct loads is a minimal multi-point profile; 4 loads is the standard fuller protocol.");
  }
  return { ...base, status: "fitted", method: "least_squares", slope: fit.slope, intercept: fit.intercept, r2: fit.r2, notes };
}
