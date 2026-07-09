/**
 * Compute stage of the pipeline: canonical trials → metric rows.
 * Used identically by every adapter (synthetic, CSV, manual, demo) so all data
 * paths produce the same metrics through the same versioned functions.
 */

import { getDb, newId, nowIso } from "../db/db";
import { ForceTimeSeries } from "../calc/signal";
import { computeCmj, computeDropJumpRsi } from "../calc/cmj";
import { computeImtp } from "../calc/imtp";
import { asymmetryIndex, ASYM_METHOD_VERSION } from "../calc/asymmetry";
import { metricDef, ASYMMETRY_SOURCE_METRICS } from "../config/metrics";
import { checkSanity } from "../calc/signal";
import { isValidSide, VALID_SIDES } from "./adapter";

export interface MetricInsert {
  metricType: string;
  side: "left" | "right" | "bilateral";
  value: number;
  trialId: string | null;
  methodVersion: string;
  source?: "computed" | "imported" | "manual";
  qualityFlag?: string | null;
}

export function insertMetric(
  facilityId: string,
  athleteId: string,
  sessionId: string,
  m: MetricInsert
): string {
  // Defense in depth: validateCanonical() already rejects invalid side/value
  // for every import path, but this guarantees no caller can ever write
  // unscoped/invalid data to the metric table, even if it bypasses validation.
  if (!isValidSide(m.side)) {
    throw new Error(`Refusing to write invalid side '${m.side}' for metric '${m.metricType}' — must be one of ${VALID_SIDES.join(", ")}.`);
  }
  if (!Number.isFinite(m.value)) {
    throw new Error(`Refusing to write non-finite value for metric '${m.metricType}'.`);
  }
  const def = metricDef(m.metricType);
  const sanity = checkSanity(m.value, def.sanity.min, def.sanity.max);
  const quality = m.qualityFlag ?? (sanity.ok ? null : `sanity: ${sanity.reason}`);
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO metric (id, facility_id, athlete_id, session_id, trial_id, metric_type, side, value, unit, method_version, quality_flag, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      facilityId,
      athleteId,
      sessionId,
      m.trialId,
      m.metricType,
      m.side,
      m.value,
      def.unit,
      m.methodVersion,
      quality,
      m.source ?? "computed",
      nowIso()
    );
  return id;
}

/**
 * Compute all metrics for one trial waveform and insert them.
 * Returns inserted metric count. Throws only for unscoreable trials —
 * callers record the failure on the trial instead of inventing values.
 */
export function computeTrialMetrics(
  facilityId: string,
  athleteId: string,
  sessionId: string,
  trialId: string,
  testType: string,
  series: ForceTimeSeries
): number {
  let count = 0;
  const put = (m: MetricInsert) => {
    insertMetric(facilityId, athleteId, sessionId, m);
    count++;
  };

  if (testType === "cmj") {
    const r = computeCmj(series);
    const v = r.methodVersion;
    put({ metricType: "cmj_jump_height", side: "bilateral", value: r.jumpHeightCm, trialId, methodVersion: v });
    put({ metricType: "cmj_mrsi", side: "bilateral", value: r.mrsi, trialId, methodVersion: v });
    put({ metricType: "cmj_ecc_braking_impulse", side: "bilateral", value: r.eccBrakingImpulseNs, trialId, methodVersion: v });
    put({ metricType: "cmj_peak_propulsive_force", side: "bilateral", value: r.peakPropulsiveForceN, trialId, methodVersion: v });
    if (r.eccBrakingImpulseLeftNs !== undefined && r.eccBrakingImpulseRightNs !== undefined) {
      put({ metricType: "cmj_ecc_braking_impulse", side: "left", value: r.eccBrakingImpulseLeftNs, trialId, methodVersion: v });
      put({ metricType: "cmj_ecc_braking_impulse", side: "right", value: r.eccBrakingImpulseRightNs, trialId, methodVersion: v });
    }
    if (r.peakPropulsiveForceLeftN !== undefined && r.peakPropulsiveForceRightN !== undefined) {
      put({ metricType: "cmj_peak_propulsive_force", side: "left", value: r.peakPropulsiveForceLeftN, trialId, methodVersion: v });
      put({ metricType: "cmj_peak_propulsive_force", side: "right", value: r.peakPropulsiveForceRightN, trialId, methodVersion: v });
    }
  } else if (testType === "imtp") {
    const r = computeImtp(series);
    const v = r.methodVersion;
    put({ metricType: "imtp_peak_force", side: "bilateral", value: r.peakForceN, trialId, methodVersion: v });
    put({ metricType: "imtp_relative_force", side: "bilateral", value: r.relativeForceNkg, trialId, methodVersion: v });
    put({ metricType: "imtp_rfd_0_50", side: "bilateral", value: r.rfd0_50, trialId, methodVersion: v });
    put({ metricType: "imtp_rfd_50_150", side: "bilateral", value: r.rfd50_150, trialId, methodVersion: v });
    if (Number.isFinite(r.rfd150_250)) {
      put({ metricType: "imtp_rfd_150_250", side: "bilateral", value: r.rfd150_250, trialId, methodVersion: v });
    }
    if (r.peakForceLeftN !== undefined && r.peakForceRightN !== undefined) {
      put({ metricType: "imtp_peak_force", side: "left", value: r.peakForceLeftN, trialId, methodVersion: v });
      put({ metricType: "imtp_peak_force", side: "right", value: r.peakForceRightN, trialId, methodVersion: v });
    }
  } else if (testType === "drop_jump") {
    const r = computeDropJumpRsi(series);
    put({ metricType: "dj_rsi", side: "bilateral", value: r.rsi, trialId, methodVersion: r.methodVersion });
  } else {
    throw new Error(`No waveform computation defined for test type '${testType}'.`);
  }
  return count;
}

/**
 * Derive per-session asymmetry_index metrics from sided source metrics.
 * Uses the session-best value per side across trials.
 */
export function computeSessionAsymmetry(
  facilityId: string,
  athleteId: string,
  sessionId: string
): number {
  const db = getDb();
  let count = 0;
  for (const metricType of ASYMMETRY_SOURCE_METRICS) {
    const bySide = (side: string) =>
      (
        db
          .prepare(
            `SELECT MAX(value) as v FROM metric WHERE facility_id = ? AND session_id = ? AND metric_type = ? AND side = ?`
          )
          .get(facilityId, sessionId, metricType, side) as { v: number | null }
      ).v;
    const left = bySide("left");
    const right = bySide("right");
    if (left == null || right == null) continue;
    const r = asymmetryIndex(left, right);
    // One asymmetry row per source metric; the source metric key rides in
    // method_version as "<asym-version>:<source_metric_type>".
    insertMetric(facilityId, athleteId, sessionId, {
      metricType: "asymmetry_index",
      side: "bilateral",
      value: r.asymmetryIndexPct,
      trialId: null,
      methodVersion: `${ASYM_METHOD_VERSION}:${metricType}`,
      source: "computed",
    });
    count++;
  }
  return count;
}

/** Convenience: parse asymmetry source metric back out of method_version. */
export function asymmetrySource(methodVersion: string): string {
  const i = methodVersion.indexOf(":");
  return i >= 0 ? methodVersion.slice(i + 1) : "";
}
