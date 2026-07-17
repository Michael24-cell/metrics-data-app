/**
 * Force-time curve workspace service — queries persisted trials, delegates
 * every curve decision (validity, selection, alignment, averaging) to
 * calc/curveWorkspace.ts, and attaches OFFICIAL annotation values from
 * persisted metric rows + full-rate-derived event markers. Nothing here (or
 * downstream in React) re-derives an official value from the display
 * waveform.
 */

import { getDb } from "../db/db";
import {
  AttemptRecord,
  ExcludedAttempt,
  PreparedCurve,
  classifyAttempts,
  parseCurveSelection,
  prepareCurve,
  selectionToken,
  MAX_OVERLAID_CURVES,
} from "../calc/curveWorkspace";
import { EventMarkers } from "../calc/curve";
import { compareCurves, CurveComparison } from "../calc/curveCompare";
import { IMTP_FORCE_POINT_KEYS } from "../config/metrics";

export interface CurveAttemptOption {
  trialId: string;
  date: string;
  trialNumber: number;
  hz: number;
  hasBilateral: boolean;
}

/** Official annotation values — persisted metric rows and stored markers only. */
export interface CurveAnnotations {
  /** CMJ: detected takeoff relative to movement onset (persisted markers) */
  takeoffRelMs?: number;
  /** IMTP: peak-force sample relative to force onset (persisted markers) */
  peakForceRelMs?: number;
  /** official per-trial metric rows */
  officialTimeToTakeoffMs?: number;
  officialPeakForceN?: number;
  officialTimeToPeakMs?: number;
  officialForcePoints?: { ms: number; forceN: number }[];
}

export interface WorkspaceCurve extends PreparedCurve {
  annotations: CurveAnnotations;
}

export interface CurveWorkspaceData {
  testType: "cmj" | "imtp";
  /** valid attempts, most recent first, for the attempt picker */
  options: CurveAttemptOption[];
  /** attempts unusable for curves, with reasons */
  excluded: ExcludedAttempt[];
  curves: WorkspaceCurve[];
  /** the selection token rendered in each of the three slots ("" = empty) */
  resolvedTokens: string[];
}

function trialMetrics(facilityId: string, trialId: string): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT metric_type, value FROM metric WHERE facility_id = ? AND trial_id = ? AND side = 'bilateral'`
    )
    .all(facilityId, trialId) as { metric_type: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.metric_type, r.value]));
}

function annotationsFor(
  facilityId: string,
  testType: "cmj" | "imtp",
  attempt: AttemptRecord
): CurveAnnotations {
  const m = attempt.markers as EventMarkers;
  const official = trialMetrics(facilityId, attempt.trialId);
  if (testType === "cmj" && m.kind === "cmj") {
    return {
      takeoffRelMs: m.takeoffMs - m.movementStartMs,
      officialTimeToTakeoffMs: official["cmj_time_to_takeoff"],
    };
  }
  if (testType === "imtp" && m.kind === "imtp") {
    const points = Object.entries(IMTP_FORCE_POINT_KEYS)
      .map(([ms, key]) => ({ ms: Number(ms), forceN: official[key] }))
      .filter((p) => p.forceN != null);
    return {
      peakForceRelMs: m.peakForceMs - m.onsetMs,
      officialPeakForceN: official["imtp_peak_force"],
      officialTimeToPeakMs: official["imtp_time_to_peak_force"],
      officialForcePoints: points,
    };
  }
  return {};
}

export function curveWorkspace(
  facilityId: string,
  athleteId: string,
  testType: "cmj" | "imtp",
  tokens: (string | undefined)[],
  range: { from?: string; to?: string } = {}
): CurveWorkspaceData {
  let sql = `
    SELECT t.id, t.session_id, t.trial_number, t.waveform_json, t.event_markers_json, t.quality_flag,
           s.session_date
    FROM trial t JOIN session s ON s.id = t.session_id
    WHERE t.facility_id = ? AND s.athlete_id = ? AND s.test_type = ?`;
  const params: string[] = [facilityId, athleteId, testType];
  if (range.from) { sql += ` AND s.session_date >= ?`; params.push(range.from); }
  if (range.to) { sql += ` AND s.session_date <= ?`; params.push(range.to); }
  sql += ` ORDER BY s.session_date ASC, t.trial_number ASC`;
  const rows = getDb().prepare(sql).all(...params) as unknown as {
    id: string;
    session_id: string;
    trial_number: number;
    waveform_json: string | null;
    event_markers_json: string | null;
    quality_flag: string | null;
    session_date: string;
  }[];

  const attempts: AttemptRecord[] = rows.map((r) => ({
    trialId: r.id,
    sessionId: r.session_id,
    date: r.session_date,
    trialNumber: r.trial_number,
    qualityFlag: r.quality_flag,
    waveform: r.waveform_json ? JSON.parse(r.waveform_json) : null,
    markers: r.event_markers_json ? (JSON.parse(r.event_markers_json) as EventMarkers) : null,
  }));

  const { valid, excluded } = classifyAttempts(testType, attempts);
  const byId = new Map(valid.map((a) => [a.trialId, a]));

  // Slot 1 defaults to the most recent valid individual attempt.
  const requested = tokens.slice(0, MAX_OVERLAID_CURVES).map((t) => parseCurveSelection(t));
  while (requested.length < MAX_OVERLAID_CURVES) requested.push(null);
  if (!requested[0] && valid.length > 0) {
    requested[0] = { mode: "attempt", trialId: valid[valid.length - 1].trialId };
  }

  const curves: WorkspaceCurve[] = [];
  const resolvedTokens: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_OVERLAID_CURVES; i++) {
    const sel = requested[i];
    if (!sel) { resolvedTokens.push(""); continue; }
    const token = selectionToken(sel);
    if (seen.has(token)) { resolvedTokens.push(""); continue; }
    const prepared = prepareCurve(valid, sel);
    if (!prepared) { resolvedTokens.push(""); continue; }
    seen.add(token);
    resolvedTokens.push(token);
    const annotations =
      prepared.kind === "individual" && prepared.trialId && byId.has(prepared.trialId)
        ? annotationsFor(facilityId, testType, byId.get(prepared.trialId)!)
        : {};
    curves.push({ ...prepared, annotations });
  }

  const options: CurveAttemptOption[] = [...valid].reverse().map((a) => ({
    trialId: a.trialId,
    date: a.date,
    trialNumber: a.trialNumber,
    hz: a.waveform!.hz,
    hasBilateral: !!(a.waveform!.left && a.waveform!.right),
  }));

  return { testType, options, excluded, curves, resolvedTokens };
}

/* ------------------------------------------------------------------ */
/* Deterministic curve comparison (Agent-facing)                       */
/* ------------------------------------------------------------------ */

export interface CurveComparisonResult {
  testType: "cmj" | "imtp";
  /** null when a selection could not be resolved (with the reason) */
  comparison: CurveComparison | null;
  unresolved: string | null;
  a: WorkspaceCurve | null;
  b: WorkspaceCurve | null;
  /** attempts unusable for curves at all, with reasons */
  excluded: ReturnType<typeof curveWorkspace>["excluded"];
}

/**
 * Resolve two selection tokens ("attempt:<id>" | "rolling:<n>" | "alltime" |
 * "latest" | "previous") and compare the prepared curves deterministically.
 * All alignment/averaging comes from curveWorkspace; all differencing from
 * calc/curveCompare. Nothing here re-reads waveforms.
 */
export function compareCurveSelections(
  facilityId: string,
  athleteId: string,
  testType: "cmj" | "imtp",
  tokenA: string,
  tokenB: string,
  range: { from?: string; to?: string } = {}
): CurveComparisonResult {
  // "latest"/"previous" convenience tokens resolve against the valid list.
  const base = curveWorkspace(facilityId, athleteId, testType, [], range);
  const recentFirst = base.options; // already most recent first
  const resolveToken = (t: string): string | null => {
    if (t === "latest") return recentFirst[0] ? `attempt:${recentFirst[0].trialId}` : null;
    if (t === "previous") return recentFirst[1] ? `attempt:${recentFirst[1].trialId}` : null;
    return t;
  };
  const ra = resolveToken(tokenA);
  const rb = resolveToken(tokenB);
  if (!ra || !rb) {
    return {
      testType,
      comparison: null,
      unresolved: `not enough valid attempts to resolve "${!ra ? tokenA : tokenB}"`,
      a: null,
      b: null,
      excluded: base.excluded,
    };
  }
  const ws = curveWorkspace(facilityId, athleteId, testType, [ra, rb], range);
  const a = ws.curves.find((c) => c.token === ra) ?? null;
  const b = ws.curves.find((c) => c.token === rb) ?? null;
  if (!a || !b) {
    return {
      testType,
      comparison: null,
      unresolved: `selection "${!a ? tokenA : tokenB}" could not be prepared (unknown attempt or no valid attempts)`,
      a,
      b,
      excluded: ws.excluded,
    };
  }
  return { testType, comparison: compareCurves(a, b), unresolved: null, a, b, excluded: ws.excluded };
}
