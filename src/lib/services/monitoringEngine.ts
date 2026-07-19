/**
 * Monitoring engine — walk-forward evaluation of an athlete's eligible
 * sessions against the effective policy, persisting one immutable
 * monitoring_result row per (athlete, metric, session, policy fingerprint).
 *
 * Idempotent by construction: re-running with the same policy fingerprint
 * inserts nothing new; recomputing under a CHANGED policy writes new rows
 * while all prior-version rows (and their audit trail) are preserved.
 *
 * Every session is classified against ONLY the eligible history before it —
 * a result never participates in the reference window that judges it.
 */

import { getDb, newId, nowIso } from "../db/db";
import { sessionBestSeries } from "../db/dal";
import { metricDef } from "../config/metrics";
import { statPolicyFor } from "../config/statPolicies";
import {
  assessChangeVsNoise,
  buildSessionPairs,
  minimalDetectableChange,
  smallestWorthwhileChange,
  typicalError,
} from "../calc/reliability";
import { reliabilityForMetric } from "./reliability";
import { classifySession, MonitoringClassification, MonitoringState, MonitoringPolicyV1 } from "../calc/monitoring";
import { EffectivePolicy, effectivePolicy } from "./monitoringPolicy";

export interface MonitoringResultRow {
  id: string;
  facility_id: string;
  athlete_id: string;
  metric_key: string;
  session_id: string;
  session_date: string;
  monitoring_state: MonitoringState;
  range_state: string;
  noise_state: string;
  current_value: number;
  reference_mean: number | null;
  reference_sd: number | null;
  band_low: number | null;
  band_high: number | null;
  reference_count: number;
  policy_fingerprint: string;
  policy_snapshot_json: string;
  calc_version: string;
  created_at: string;
}

/** Classify every eligible session for one metric (pure walk over DB series). */
export function evaluateAthleteMetric(
  facilityId: string,
  athleteId: string,
  metricKey: string,
  effective: EffectivePolicy
): { inserted: number; results: MonitoringClassification[] } {
  const db = getDb();
  const def = metricDef(metricKey);
  const series = sessionBestSeries(facilityId, athleteId, metricKey, "bilateral");
  const statPolicy = statPolicyFor(metricKey);
  const reliability = reliabilityForMetric(facilityId, athleteId, metricKey);

  const results: MonitoringClassification[] = [];
  const states: MonitoringState[] = [];
  let inserted = 0;

  for (let i = 0; i < series.length; i++) {
    const current = series[i];
    const history = series.slice(0, i).map((p) => p.value);

    /* noise statistics from the PRECEDING history only */
    const te = statPolicy ? typicalError(buildSessionPairs(history), statPolicy) : { available: false as const, reason: "no policy", pairCount: 0, te: null, pairingMethod: "consecutive_eligible_sessions" as const };
    const mdc = statPolicy ? minimalDetectableChange(te, statPolicy.mdcConfidence) : { available: false as const, reason: "no policy", confidence: null, mdc: null };
    const swc = statPolicy ? smallestWorthwhileChange(history, statPolicy.swc) : { available: false as const, reason: "no policy", method: "none" as const, value: null };
    const refWindow = history.slice(-effective.policy.rollingWindow);
    const refMean = refWindow.length ? refWindow.reduce((a, b) => a + b, 0) / refWindow.length : current.value;
    const noise = assessChangeVsNoise(current.value - refMean, effective.policy.noiseGate, {
      te,
      mdc,
      swc,
      cvPoor: reliability.availability === "poor_within_session_reliability",
    });

    const cls = classifySession({
      history,
      currentValue: current.value,
      higherIsBetter: def.higherIsBetter,
      policy: effective.policy,
      noise,
      reliabilityAvailability: reliability.availability,
      previousStates: states,
    });
    results.push(cls);
    states.push(cls.monitoringState);

    const res = db
      .prepare(
        `INSERT OR IGNORE INTO monitoring_result
         (id, facility_id, athlete_id, metric_key, session_id, session_date, monitoring_state, range_state, noise_state,
          current_value, reference_mean, reference_sd, band_low, band_high, reference_count,
          policy_fingerprint, policy_snapshot_json, calc_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId(), facilityId, athleteId, metricKey, current.sessionId, current.date,
        cls.monitoringState, cls.rangeState, cls.noiseState,
        cls.currentValue, cls.referenceMean, cls.referenceSd, cls.bandLow, cls.bandHigh, cls.referenceCount,
        effective.fingerprint, JSON.stringify(effective.policy), cls.calcVersion, nowIso()
      );
    inserted += Number(res.changes);
  }
  return { inserted, results };
}

/** Evaluate every selected metric of the athlete's effective policy. */
export function evaluateAthlete(facilityId: string, athleteId: string, coachUserId?: string | null) {
  const effective = effectivePolicy(facilityId, athleteId, coachUserId);
  const out: Record<string, { inserted: number }> = {};
  for (const metricKey of effective.policy.metricKeys) {
    try {
      const { inserted } = evaluateAthleteMetric(facilityId, athleteId, metricKey, effective);
      out[metricKey] = { inserted };
    } catch {
      out[metricKey] = { inserted: 0 };
    }
  }
  return { effective, metrics: out };
}

export function listMonitoringResults(
  facilityId: string,
  athleteId: string,
  metricKey?: string,
  policyFingerprint?: string
): MonitoringResultRow[] {
  let sql = `SELECT * FROM monitoring_result WHERE facility_id = ? AND athlete_id = ?`;
  const params: string[] = [facilityId, athleteId];
  if (metricKey) { sql += ` AND metric_key = ?`; params.push(metricKey); }
  if (policyFingerprint) { sql += ` AND policy_fingerprint = ?`; params.push(policyFingerprint); }
  sql += ` ORDER BY session_date ASC`;
  return getDb().prepare(sql).all(...params) as unknown as MonitoringResultRow[];
}

export type { MonitoringPolicyV1 };
