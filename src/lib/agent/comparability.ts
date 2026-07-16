/**
 * Comparability gate (pure, client-safe).
 *
 * Before the agent may narrate a longitudinal comparison, the sessions in
 * the window must be comparable: same test type, compatible device
 * configuration, same units, same calculation-method version, acceptable
 * data quality, consistent aggregation mode, and a sufficient baseline.
 * If they are not, the agent must say so — it must not compute or narrate
 * a misleading trend.
 */

export interface SessionDescriptor {
  sessionId: string;
  date: string;
  testType: string;
  deviceId: string | null;
  unit: string;
  methodVersion: string;
  qualityFlagged: boolean;
  /** always "session_best_raw" in V1 — smoothing never feeds comparisons */
  aggregation: string;
}

export interface ComparabilityResult {
  comparable: boolean;
  reasons: string[];
  checked: {
    testTypes: string[];
    deviceIds: (string | null)[];
    units: string[];
    methodVersions: string[];
    qualityFlaggedCount: number;
    aggregationModes: string[];
    sessionCount: number;
  };
}

export function checkComparability(
  sessions: SessionDescriptor[],
  opts: { minSessions?: number; maxQualityFlaggedShare?: number } = {}
): ComparabilityResult {
  const minSessions = opts.minSessions ?? 2;
  const maxFlaggedShare = opts.maxQualityFlaggedShare ?? 0.34;
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];

  const checked = {
    testTypes: uniq(sessions.map((s) => s.testType)),
    deviceIds: uniq(sessions.map((s) => s.deviceId)),
    units: uniq(sessions.map((s) => s.unit)),
    methodVersions: uniq(sessions.map((s) => s.methodVersion)),
    qualityFlaggedCount: sessions.filter((s) => s.qualityFlagged).length,
    aggregationModes: uniq(sessions.map((s) => s.aggregation)),
    sessionCount: sessions.length,
  };

  const reasons: string[] = [];
  if (sessions.length < minSessions) {
    reasons.push(`only ${sessions.length} session(s) in the window — at least ${minSessions} comparable observations are required`);
  }
  if (checked.testTypes.length > 1) {
    reasons.push(`mixed test types (${checked.testTypes.join(", ")}) — values from different tests are never compared as one trend`);
  }
  if (checked.units.length > 1) {
    reasons.push(`mixed units (${checked.units.join(", ")})`);
  }
  if (checked.methodVersions.length > 1) {
    reasons.push(`mixed calculation-method versions (${checked.methodVersions.join(", ")}) — values are only comparable within one method version`);
  }
  if (checked.deviceIds.length > 1) {
    reasons.push(`mixed devices/configurations (${checked.deviceIds.length} distinct) — cross-device comparison requires an explicit review`);
  }
  if (checked.aggregationModes.length > 1) {
    reasons.push(`mixed aggregation modes (${checked.aggregationModes.join(", ")})`);
  }
  if (sessions.length > 0 && checked.qualityFlaggedCount / sessions.length > maxFlaggedShare) {
    reasons.push(`${checked.qualityFlaggedCount} of ${sessions.length} sessions are quality-flagged — too many to support a trend statement`);
  }

  return { comparable: reasons.length === 0, reasons, checked };
}
