/**
 * Application services — the single source for what dashboards, API routes,
 * and reports display. Everything here takes facilityId first.
 */

import {
  listAthletes,
  getAthlete,
  listSessions,
  listFindings,
  sessionBestSeries,
  listTrials,
  listSessionMetrics,
  getSession,
  listInjuries,
  getActiveProtocol,
  listStages,
  listClinicalAssessments,
  listTrainingSessions,
  listMilestones,
  getThreshold,
  listLoadVelocityProfiles,
  listTeams,
  FindingRow,
} from "../db/dal";
import { getDb } from "../db/db";
import {
  METRICS,
  metricDef,
  ASYMMETRY_SOURCE_METRICS,
  BASELINE_MONITORED_METRICS,
  IMTP_FORCE_POINT_KEYS,
} from "../config/metrics";
import { monitorBaseline, DEFAULT_BASELINE_CONFIG } from "../calc/baseline";
import { ASYM_METHOD_VERSION, directionChanges } from "../calc/asymmetry";
import { buildForceWindowRow, ForceWindowRow } from "../calc/forceWindow";

export interface RosterEntry {
  id: string;
  name: string;
  sport: string;
  position: string | null;
  team: string | null;
  status: string;
  lastTestDate: string | null;
  latestJumpHeight: number | null;
  jumpSpark: { date: string; value: number }[];
  topSeverity: "flag" | "watch" | "info" | null;
  findingCounts: { flag: number; watch: number; info: number };
  latestHeadline: string | null;
  stageLabel: string | null;
}

export function rosterSummary(facilityId: string, team?: string): RosterEntry[] {
  const athletes = listAthletes(facilityId, team);
  return athletes.map((a) => {
    const jumpSeries = sessionBestSeries(facilityId, a.id, "cmj_jump_height");
    const findings = listFindings(facilityId, { athleteId: a.id });
    const counts = { flag: 0, watch: 0, info: 0 };
    for (const f of findings) counts[f.severity as keyof typeof counts]++;
    const top = counts.flag > 0 ? "flag" : counts.watch > 0 ? "watch" : counts.info > 0 ? "info" : null;
    const nonInfo = findings.filter((f) => f.severity !== "info");
    const latestHeadline = (nonInfo[0] ?? findings[0])?.headline ?? null;

    let stageLabel: string | null = null;
    const protocol = getActiveProtocol(facilityId, a.id);
    if (protocol) {
      const current = listStages(facilityId, protocol.id).find((s) => s.status === "current");
      if (current) stageLabel = `Stage ${current.stage_number} · ${current.name}`;
    }

    const lastSession = getDb()
      .prepare(`SELECT MAX(session_date) as d FROM session WHERE facility_id = ? AND athlete_id = ?`)
      .get(facilityId, a.id) as { d: string | null };

    return {
      id: a.id,
      name: a.display_name,
      sport: a.sport,
      position: a.position,
      team: a.team,
      status: a.status,
      lastTestDate: lastSession.d,
      latestJumpHeight: jumpSeries.length ? jumpSeries[jumpSeries.length - 1].value : null,
      jumpSpark: jumpSeries.slice(-24).map((s) => ({ date: s.date, value: s.value })),
      topSeverity: top,
      findingCounts: counts,
      latestHeadline,
      stageLabel,
    };
  });
}

export interface TrendPoint {
  sessionId: string;
  date: string;
  value: number;
}

export interface MetricThresholdLine {
  value: number;
  label: string;
  tone?: "watch" | "alert" | "ok";
}

/**
 * Facility-configured reference lines for one metric_type, read from
 * threshold_setting. Purely config-driven: returns [] when the facility has
 * nothing configured for this metric, so callers never need metric-specific
 * logic and TrendChart never needs to know what a metric_type is.
 */
export function metricThresholdLines(facilityId: string, metricType: string): MetricThresholdLine[] {
  const rows = getDb()
    .prepare(
      `SELECT key, value FROM threshold_setting
       WHERE facility_id = ? AND metric_type = ? AND active = 1
       ORDER BY key`
    )
    .all(facilityId, metricType) as { key: string; value: number }[];
  return rows.map((r) => ({
    value: r.value,
    label: r.key.replace(/_/g, " "),
    tone: "watch" as const,
  }));
}

export function metricTrend(
  facilityId: string,
  athleteId: string,
  metricType: string,
  side = "bilateral",
  range: { from?: string; to?: string } = {}
): { def: (typeof METRICS)[string]; points: TrendPoint[]; thresholds: MetricThresholdLine[] } {
  return {
    def: metricDef(metricType),
    points: sessionBestSeries(facilityId, athleteId, metricType, side, range),
    thresholds: metricThresholdLines(facilityId, metricType),
  };
}

export interface AsymmetryPoint {
  sessionId: string;
  date: string;
  value: number;
  strongerSide: "left" | "right" | "equal";
}

export function asymmetryTrend(
  facilityId: string,
  athleteId: string,
  sourceMetric: string,
  range: { from?: string; to?: string } = {}
): {
  sourceMetric: string;
  watchPct: number;
  flagPct: number;
  points: AsymmetryPoint[];
  /** left↔right flips across the returned history; null when < 2 points */
  sideChanges: number | null;
} {
  let sql = `
    SELECT m.session_id as sessionId, s.session_date as date, m.value
    FROM metric m JOIN session s ON s.id = m.session_id
    WHERE m.facility_id = ? AND m.athlete_id = ? AND m.metric_type = 'asymmetry_index' AND m.method_version = ?`;
  const params: string[] = [facilityId, athleteId, `${ASYM_METHOD_VERSION}:${sourceMetric}`];
  if (range.from) { sql += ` AND s.session_date >= ?`; params.push(range.from); }
  if (range.to) { sql += ` AND s.session_date <= ?`; params.push(range.to); }
  sql += ` ORDER BY s.session_date ASC`;
  const rows = getDb().prepare(sql).all(...params) as unknown as {
    sessionId: string;
    date: string;
    value: number;
  }[];

  // stronger side per session from source metric side values
  const points: AsymmetryPoint[] = rows.map((r) => {
    const sides = getDb()
      .prepare(
        `SELECT side, MAX(value) as v FROM metric WHERE facility_id = ? AND session_id = ? AND metric_type = ? AND side IN ('left','right') GROUP BY side`
      )
      .all(facilityId, r.sessionId, sourceMetric) as { side: string; v: number }[];
    const left = sides.find((s) => s.side === "left")?.v;
    const right = sides.find((s) => s.side === "right")?.v;
    const strongerSide =
      left == null || right == null || left === right ? "equal" : left > right ? "left" : "right";
    return { ...r, strongerSide };
  });

  return {
    sourceMetric,
    watchPct: getThreshold(facilityId, "asymmetry_watch_pct")?.value ?? 10,
    flagPct: getThreshold(facilityId, "asymmetry_flag_pct")?.value ?? 15,
    points,
    sideChanges: points.length >= 2 ? directionChanges(points) : null,
  };
}

/**
 * IMTP Force 0–300 ms window summary — one row per fixed time point, built
 * from persisted official metric rows (absolute, relative, per-side and
 * asymmetry-index series). Cross-series alignment rules live in
 * calc/forceWindow.ts; this service only queries and delegates.
 */
export function imtpForceWindowSummary(
  facilityId: string,
  athleteId: string,
  range: { from?: string; to?: string } = {}
): { rows: ForceWindowRow[]; latestDate: string | null; watchPct: number; flagPct: number } {
  const rows = Object.entries(IMTP_FORCE_POINT_KEYS).map(([msStr, key]) => {
    const asym = asymmetryTrend(facilityId, athleteId, key, range);
    return buildForceWindowRow({
      ms: Number(msStr),
      metricKey: key,
      abs: sessionBestSeries(facilityId, athleteId, key, "bilateral", range),
      rel: sessionBestSeries(facilityId, athleteId, `${key}_rel`, "bilateral", range),
      left: sessionBestSeries(facilityId, athleteId, key, "left", range),
      right: sessionBestSeries(facilityId, athleteId, key, "right", range),
      asymmetry: asym.points,
    });
  });
  const latestDate = rows.reduce<string | null>(
    (acc, r) => (r.latestDate && (!acc || r.latestDate > acc) ? r.latestDate : acc),
    null
  );
  return {
    rows,
    latestDate,
    watchPct: getThreshold(facilityId, "asymmetry_watch_pct")?.value ?? 10,
    flagPct: getThreshold(facilityId, "asymmetry_flag_pct")?.value ?? 15,
  };
}

export function baselineSeries(
  facilityId: string,
  athleteId: string,
  metricType: string,
  range: { from?: string; to?: string } = {}
) {
  const def = metricDef(metricType);
  // baseline is computed over the FULL history (deterministic), then windowed for display
  const all = sessionBestSeries(facilityId, athleteId, metricType);
  const result = monitorBaseline(all, def.higherIsBetter, DEFAULT_BASELINE_CONFIG);
  const points = result.points.filter(
    (p) => (!range.from || p.date >= range.from) && (!range.to || p.date <= range.to)
  );
  return { def, ...result, points };
}

export function athleteDetail(facilityId: string, athleteId: string) {
  const athlete = getAthlete(facilityId, athleteId);
  if (!athlete) return null;
  const sessions = listSessions(facilityId, athleteId);
  const findings = listFindings(facilityId, { athleteId });
  const injuries = listInjuries(facilityId, athleteId);
  const protocol = getActiveProtocol(facilityId, athleteId);
  const stages = protocol ? listStages(facilityId, protocol.id) : [];
  const assessments = listClinicalAssessments(facilityId, athleteId);
  const milestones = listMilestones(facilityId, athleteId).map((m) => ({
    id: m.id,
    date: m.milestone_date,
    label: m.label,
    kind: m.kind,
  }));
  const training = listTrainingSessions(facilityId, athleteId);
  const lvProfiles = listLoadVelocityProfiles(facilityId, athleteId);
  return { athlete, sessions, findings, injuries, protocol, stages, assessments, milestones, training, lvProfiles };
}

export function sessionDetail(facilityId: string, sessionId: string) {
  const session = getSession(facilityId, sessionId);
  if (!session) return null;
  const athlete = getAthlete(facilityId, session.athlete_id);
  const trials = listTrials(facilityId, sessionId);
  const metrics = listSessionMetrics(facilityId, sessionId);
  const batch = session.import_batch_id
    ? (getDb()
        .prepare(
          `SELECT b.id, b.status, b.created_at, d.label as source_label, d.adapter_key
           FROM import_batch b JOIN data_source d ON d.id = b.data_source_id
           WHERE b.facility_id = ? AND b.id = ?`
        )
        .get(facilityId, session.import_batch_id) as
        | { id: string; status: string; created_at: string; source_label: string; adapter_key: string }
        | undefined)
    : undefined;
  const device = session.device_id
    ? (getDb()
        .prepare(`SELECT * FROM device WHERE facility_id = ? AND id = ?`)
        .get(facilityId, session.device_id) as
        | { make: string; model: string; device_type: string; sampling_hz: number | null }
        | undefined)
    : undefined;
  return { session, athlete, trials, metrics, batch, device };
}

/** Grouped finding list with training-context annotations attached to their targets. */
export function findingsWithAnnotations(facilityId: string, athleteId?: string, limit?: number) {
  const findings = listFindings(facilityId, { athleteId });
  const notes = findings.filter((f) => f.category === "training_context_note");
  const rest = findings.filter((f) => f.category !== "training_context_note");
  const noteByTarget = new Map<string, FindingRow[]>();
  for (const n of notes) {
    const refs = JSON.parse(n.refs_json) as { annotates?: string };
    if (refs.annotates) {
      const arr = noteByTarget.get(refs.annotates) ?? [];
      arr.push(n);
      noteByTarget.set(refs.annotates, arr);
    }
  }
  const result = rest.map((f) => ({ finding: f, annotations: noteByTarget.get(f.id) ?? [] }));
  return limit ? result.slice(0, limit) : result;
}

export function facilityFilterOptions(facilityId: string) {
  return {
    teams: listTeams(facilityId),
    athletes: listAthletes(facilityId).map((a) => ({ id: a.id, name: a.display_name, team: a.team })),
    metrics: Object.values(METRICS)
      .filter((m) => m.testType !== "derived")
      .map((m) => ({ key: m.key, label: m.shortLabel, testType: m.testType, status: m.status })),
    monitoredMetrics: BASELINE_MONITORED_METRICS,
    asymmetrySources: ASYMMETRY_SOURCE_METRICS,
  };
}
