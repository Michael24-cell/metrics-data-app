/**
 * Compute stage of the pipeline: canonical trials → metric rows.
 * Used identically by every adapter (synthetic, CSV, manual, demo) so all data
 * paths produce the same metrics through the same versioned functions.
 */

import { getDb, newId, nowIso } from "../db/db";
import { ForceTimeSeries } from "../calc/signal";
import { computeDropJumpRsi } from "../calc/cmj";
import { asymmetryIndex, ASYM_METHOD_VERSION } from "../calc/asymmetry";
import { metricDef, ASYMMETRY_SOURCE_METRICS, IMTP_FORCE_POINT_KEYS } from "../config/metrics";
import { checkSanity } from "../calc/signal";
import { isValidSide, VALID_SIDES } from "./adapter";
import { calculateProtocolAttempt, protocolForTestType } from "../protocols/registry";

/**
 * Persist the event markers (ms from recording start) used to align this
 * trial's official metrics — derived from the SAME full-rate detection run
 * above, never recomputed later from the lower-rate display waveform.
 * Historical trials imported before this existed keep a NULL value; they are
 * never backfilled (see docs/METHODOLOGY.md future curve-workspace notes).
 */
function setTrialEventMarkers(facilityId: string, trialId: string, markers: unknown): void {
  getDb()
    .prepare(`UPDATE trial SET event_markers_json = ? WHERE facility_id = ? AND id = ?`)
    .run(JSON.stringify(markers), facilityId, trialId);
}

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
  const db = getDb();
  const lineage = db
    .prepare(
      `SELECT protocol_id, protocol_version, setup_variant
       FROM session WHERE facility_id = ? AND id = ?`
    )
    .get(facilityId, sessionId) as
    | { protocol_id: string | null; protocol_version: number | null; setup_variant: string | null }
    | undefined;
  if (!lineage) throw new Error("Refusing to write a metric without a tenant-scoped parent session.");
  db
    .prepare(
      `INSERT INTO metric
       (id, facility_id, athlete_id, session_id, trial_id, metric_type,
        protocol_id, protocol_version, calculation_version, setup_variant,
        side, value, unit, method_version, quality_flag, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      facilityId,
      athleteId,
      sessionId,
      m.trialId,
      m.metricType,
      lineage.protocol_id,
      lineage.protocol_version,
      m.methodVersion,
      lineage.setup_variant,
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

  const protocol = protocolForTestType(testType);
  const calculated = protocol ? calculateProtocolAttempt(protocol, series) : null;

  if (calculated?.testType === "cmj") {
    const r = calculated.result;
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
    put({ metricType: "cmj_time_to_takeoff", side: "bilateral", value: r.timeToTakeoffS * 1000, trialId, methodVersion: v });
    setTrialEventMarkers(facilityId, trialId, calculated.markers);
  } else if (calculated?.testType === "imtp") {
    const r = calculated.result;
    const v = r.methodVersion;
    put({ metricType: "imtp_peak_force", side: "bilateral", value: r.peakForceN, trialId, methodVersion: v });
    put({ metricType: "imtp_relative_force", side: "bilateral", value: r.relativeForceNkg, trialId, methodVersion: v });
    put({ metricType: "imtp_time_to_peak_force", side: "bilateral", value: r.timeToPeakForceMs, trialId, methodVersion: v });
    put({ metricType: "imtp_rfd_0_50", side: "bilateral", value: r.rfd0_50, trialId, methodVersion: v });
    put({ metricType: "imtp_rfd_50_150", side: "bilateral", value: r.rfd50_150, trialId, methodVersion: v });
    if (Number.isFinite(r.rfd150_250)) {
      put({ metricType: "imtp_rfd_150_250", side: "bilateral", value: r.rfd150_250, trialId, methodVersion: v });
    }
    if (r.peakForceLeftN !== undefined && r.peakForceRightN !== undefined) {
      put({ metricType: "imtp_peak_force", side: "left", value: r.peakForceLeftN, trialId, methodVersion: v });
      put({ metricType: "imtp_peak_force", side: "right", value: r.peakForceRightN, trialId, methodVersion: v });
    }
    // Fixed-time force points — absolute force AT each time point (never a
    // slope/RFD). Bilateral + relative always inserted when the point falls
    // within the trial; per-side rows only when dual-plate data exists.
    for (const point of r.forcePoints) {
      const key = IMTP_FORCE_POINT_KEYS[point.ms];
      put({ metricType: key, side: "bilateral", value: point.forceN, trialId, methodVersion: v });
      put({ metricType: `${key}_rel`, side: "bilateral", value: point.forceN / r.bodyMassKg, trialId, methodVersion: v });
      if (point.forceLeftN !== undefined && point.forceRightN !== undefined) {
        put({ metricType: key, side: "left", value: point.forceLeftN, trialId, methodVersion: v });
        put({ metricType: key, side: "right", value: point.forceRightN, trialId, methodVersion: v });
      }
    }
    setTrialEventMarkers(facilityId, trialId, calculated.markers);
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
