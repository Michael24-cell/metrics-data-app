/**
 * Recent-versus-normal — pure comparison of the latest value against the
 * athlete's own preceding reference window. Deliberately DESCRIPTIVE:
 * until the monitoring/reliability engine gates a change, this never claims
 * a difference is meaningful, fatigue-related, or beyond measurement noise.
 *
 * The reference window NEVER includes the value being judged.
 */

export interface RvnPoint {
  date: string;
  value: number;
}

export interface RecentVsNormal {
  latest: RvnPoint | null;
  /** mean of the preceding `window` values (latest excluded) */
  referenceMean: number | null;
  referenceCount: number;
  windowRequested: number;
  diff: number | null;
  /** null when the reference mean is too close to zero for a valid % */
  pctDiff: number | null;
  insufficient: string | null;
}

export function recentVsNormal(points: RvnPoint[], window = 5): RecentVsNormal {
  if (points.length === 0) {
    return { latest: null, referenceMean: null, referenceCount: 0, windowRequested: window, diff: null, pctDiff: null, insufficient: "no valid sessions" };
  }
  const latest = points[points.length - 1];
  const reference = points.slice(0, -1).slice(-window);
  if (reference.length === 0) {
    return { latest, referenceMean: null, referenceCount: 0, windowRequested: window, diff: null, pctDiff: null, insufficient: "no prior sessions to compare against" };
  }
  const referenceMean = reference.reduce((a, p) => a + p.value, 0) / reference.length;
  const diff = latest.value - referenceMean;
  const pctDiff = Math.abs(referenceMean) > 1e-6 ? (diff / Math.abs(referenceMean)) * 100 : null;
  return {
    latest,
    referenceMean,
    referenceCount: reference.length,
    windowRequested: window,
    diff,
    pctDiff,
    insufficient: reference.length < window ? `only ${reference.length} of ${window} requested reference sessions available` : null,
  };
}
