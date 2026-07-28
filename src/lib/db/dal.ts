/**
 * Data access layer. EVERY function that touches athlete data requires a
 * facilityId and filters on it in SQL — facility scoping is enforced here,
 * not in the UI. Cross-facility reads are structurally impossible through
 * this module.
 */

import { getDb } from "./db";

export interface AthleteRow {
  id: string;
  facility_id: string;
  display_name: string;
  sport: string;
  position: string | null;
  team: string | null;
  sex: string | null;
  birth_year: number | null;
  height_cm: number | null;
  mass_kg: number | null;
  status: string;
}

export interface SessionRow {
  id: string;
  facility_id: string;
  athlete_id: string;
  device_id: string | null;
  import_batch_id: string | null;
  test_type: string;
  protocol_id: string | null;
  protocol_version: number | null;
  calculation_version: string | null;
  setup_variant: string | null;
  setup_metadata_json: string | null;
  session_date: string;
  notes: string | null;
}

export interface MetricRow {
  id: string;
  athlete_id: string;
  session_id: string;
  trial_id: string | null;
  metric_type: string;
  protocol_id: string | null;
  protocol_version: number | null;
  calculation_version: string | null;
  setup_variant: string | null;
  side: string;
  value: number;
  unit: string;
  method_version: string;
  quality_flag: string | null;
  source: string;
  session_date?: string;
}

export interface FindingRow {
  id: string;
  athlete_id: string;
  category: string;
  severity: string;
  headline: string;
  detail: string;
  refs_json: string;
  session_date: string | null;
  generated_at: string;
  engine_version: string;
}

export interface TrialRow {
  id: string;
  session_id: string;
  trial_number: number;
  protocol_id: string | null;
  protocol_version: number | null;
  calculation_version: string | null;
  setup_variant: string | null;
  waveform_json: string | null;
  event_markers_json: string | null;
  quality_flag: string | null;
  raw_meta_json: string | null;
}

const q = () => getDb();

export function listFacilities() {
  // insertion order: the primary demo facility is seeded first and is the default scope
  return q().prepare(`SELECT * FROM facility ORDER BY rowid`).all() as {
    id: string;
    name: string;
    short_name: string;
  }[];
}

export function getFacility(facilityId: string) {
  return q().prepare(`SELECT * FROM facility WHERE id = ?`).get(facilityId) as
    | { id: string; name: string; short_name: string }
    | undefined;
}

export function listAthletes(facilityId: string, team?: string): AthleteRow[] {
  if (team) {
    return q()
      .prepare(`SELECT * FROM athlete WHERE facility_id = ? AND team = ? ORDER BY display_name`)
      .all(facilityId, team) as unknown as AthleteRow[];
  }
  return q()
    .prepare(`SELECT * FROM athlete WHERE facility_id = ? ORDER BY display_name`)
    .all(facilityId) as unknown as AthleteRow[];
}

export function getAthlete(facilityId: string, athleteId: string): AthleteRow | undefined {
  return q()
    .prepare(`SELECT * FROM athlete WHERE facility_id = ? AND id = ?`)
    .get(facilityId, athleteId) as AthleteRow | undefined;
}

export function listTeams(facilityId: string): string[] {
  const rows = q()
    .prepare(`SELECT DISTINCT team FROM athlete WHERE facility_id = ? AND team IS NOT NULL ORDER BY team`)
    .all(facilityId) as { team: string }[];
  return rows.map((r) => r.team);
}

export function listSessions(
  facilityId: string,
  athleteId: string,
  opts: { testType?: string; from?: string; to?: string } = {}
): SessionRow[] {
  let sql = `SELECT * FROM session WHERE facility_id = ? AND athlete_id = ?`;
  const params: string[] = [facilityId, athleteId];
  if (opts.testType) {
    sql += ` AND test_type = ?`;
    params.push(opts.testType);
  }
  if (opts.from) {
    sql += ` AND session_date >= ?`;
    params.push(opts.from);
  }
  if (opts.to) {
    sql += ` AND session_date <= ?`;
    params.push(opts.to);
  }
  sql += ` ORDER BY session_date ASC`;
  return q().prepare(sql).all(...params) as unknown as SessionRow[];
}

export function getSession(facilityId: string, sessionId: string): SessionRow | undefined {
  return q()
    .prepare(`SELECT * FROM session WHERE facility_id = ? AND id = ?`)
    .get(facilityId, sessionId) as SessionRow | undefined;
}

export function listTrials(facilityId: string, sessionId: string): TrialRow[] {
  return q()
    .prepare(`SELECT * FROM trial WHERE facility_id = ? AND session_id = ? ORDER BY trial_number`)
    .all(facilityId, sessionId) as unknown as TrialRow[];
}

export function listMetrics(
  facilityId: string,
  athleteId: string,
  opts: { metricType?: string; side?: string; from?: string; to?: string; sessionId?: string } = {}
): MetricRow[] {
  let sql = `
    SELECT m.*, s.session_date FROM metric m
    JOIN session s ON s.id = m.session_id
    WHERE m.facility_id = ? AND m.athlete_id = ?`;
  const params: string[] = [facilityId, athleteId];
  if (opts.metricType) {
    sql += ` AND m.metric_type = ?`;
    params.push(opts.metricType);
  }
  if (opts.side) {
    sql += ` AND m.side = ?`;
    params.push(opts.side);
  }
  if (opts.sessionId) {
    sql += ` AND m.session_id = ?`;
    params.push(opts.sessionId);
  }
  if (opts.from) {
    sql += ` AND s.session_date >= ?`;
    params.push(opts.from);
  }
  if (opts.to) {
    sql += ` AND s.session_date <= ?`;
    params.push(opts.to);
  }
  sql += ` ORDER BY s.session_date ASC, m.trial_id`;
  return q().prepare(sql).all(...params) as unknown as MetricRow[];
}

export function listSessionMetrics(facilityId: string, sessionId: string): MetricRow[] {
  return q()
    .prepare(
      `SELECT m.*, s.session_date FROM metric m JOIN session s ON s.id = m.session_id
       WHERE m.facility_id = ? AND m.session_id = ? ORDER BY m.trial_id, m.metric_type, m.side`
    )
    .all(facilityId, sessionId) as unknown as MetricRow[];
}

/** Session-level best value per session for a metric (max across trials), ordered by date. */
export function sessionBestSeries(
  facilityId: string,
  athleteId: string,
  metricType: string,
  side = "bilateral",
  opts: { from?: string; to?: string } = {}
): { sessionId: string; date: string; value: number }[] {
  let sql = `
    SELECT m.session_id as sessionId, s.session_date as date, MAX(m.value) as value
    FROM metric m JOIN session s ON s.id = m.session_id
    WHERE m.facility_id = ? AND m.athlete_id = ? AND m.metric_type = ? AND m.side = ?`;
  const params: string[] = [facilityId, athleteId, metricType, side];
  if (opts.from) {
    sql += ` AND s.session_date >= ?`;
    params.push(opts.from);
  }
  if (opts.to) {
    sql += ` AND s.session_date <= ?`;
    params.push(opts.to);
  }
  sql += ` GROUP BY m.session_id ORDER BY s.session_date ASC`;
  const rows = q().prepare(sql).all(...params) as unknown as {
    sessionId: string;
    date: string;
    value: number;
  }[];
  // node:sqlite rows are null-prototype objects; charts receive these in
  // client components, which requires plain objects.
  return rows.map((r) => ({ sessionId: r.sessionId, date: r.date, value: r.value }));
}

export function listFindings(
  facilityId: string,
  opts: { athleteId?: string; category?: string; severity?: string; limit?: number } = {}
): FindingRow[] {
  let sql = `SELECT * FROM finding WHERE facility_id = ?`;
  const params: (string | number)[] = [facilityId];
  if (opts.athleteId) {
    sql += ` AND athlete_id = ?`;
    params.push(opts.athleteId);
  }
  if (opts.category) {
    sql += ` AND category = ?`;
    params.push(opts.category);
  }
  if (opts.severity) {
    sql += ` AND severity = ?`;
    params.push(opts.severity);
  }
  sql += ` ORDER BY session_date DESC, generated_at DESC`;
  if (opts.limit) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }
  return q().prepare(sql).all(...params) as unknown as FindingRow[];
}

export function getThreshold(facilityId: string, key: string, metricType?: string) {
  // metric-specific threshold wins over general
  const specific = q()
    .prepare(
      `SELECT * FROM threshold_setting WHERE facility_id = ? AND key = ? AND metric_type = ? AND active = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(facilityId, key, metricType ?? "") as { value: number; version: number } | undefined;
  if (specific) return specific;
  return q()
    .prepare(
      `SELECT * FROM threshold_setting WHERE facility_id = ? AND key = ? AND metric_type IS NULL AND active = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(facilityId, key) as { value: number; version: number } | undefined;
}

export function listInjuries(facilityId: string, athleteId: string) {
  return q()
    .prepare(`SELECT * FROM injury_record WHERE facility_id = ? AND athlete_id = ? ORDER BY occurred_on DESC`)
    .all(facilityId, athleteId) as unknown as {
    id: string;
    label: string;
    involved_side: string | null;
    occurred_on: string;
    resolved_on: string | null;
    entered_by: string;
    notes: string | null;
  }[];
}

export function getActiveProtocol(facilityId: string, athleteId: string) {
  return q()
    .prepare(
      `SELECT * FROM rts_protocol WHERE facility_id = ? AND athlete_id = ? AND status = 'active' LIMIT 1`
    )
    .get(facilityId, athleteId) as
    | {
        id: string;
        name: string;
        version: number;
        injury_record_id: string | null;
        defined_by: string;
      }
    | undefined;
}

export function listStages(facilityId: string, protocolId: string) {
  return q()
    .prepare(`SELECT * FROM rts_stage WHERE facility_id = ? AND protocol_id = ? ORDER BY stage_number`)
    .all(facilityId, protocolId) as unknown as {
    id: string;
    stage_number: number;
    name: string;
    description: string | null;
    criteria_json: string;
    status: string;
    entered_on: string | null;
    completed_on: string | null;
  }[];
}

export function listClinicalAssessments(facilityId: string, athleteId: string) {
  return q()
    .prepare(
      `SELECT * FROM clinical_assessment WHERE facility_id = ? AND athlete_id = ? ORDER BY assessed_on DESC`
    )
    .all(facilityId, athleteId) as unknown as {
    id: string;
    assessed_on: string;
    assessor: string;
    category: string;
    summary: string;
  }[];
}

export function listTrainingSessions(
  facilityId: string,
  athleteId: string,
  opts: { from?: string; to?: string } = {}
) {
  let sql = `SELECT * FROM training_session WHERE facility_id = ? AND athlete_id = ?`;
  const params: string[] = [facilityId, athleteId];
  if (opts.from) {
    sql += ` AND session_date >= ?`;
    params.push(opts.from);
  }
  if (opts.to) {
    sql += ` AND session_date <= ?`;
    params.push(opts.to);
  }
  sql += ` ORDER BY session_date ASC`;
  return q().prepare(sql).all(...params) as unknown as {
    id: string;
    session_date: string;
    session_type: string;
    duration_min: number | null;
    rpe: number | null;
    load_au: number | null;
    notes: string | null;
  }[];
}

export function listMilestones(facilityId: string, athleteId: string) {
  return q()
    .prepare(`SELECT * FROM milestone WHERE facility_id = ? AND athlete_id = ? ORDER BY milestone_date`)
    .all(facilityId, athleteId) as unknown as {
    id: string;
    milestone_date: string;
    label: string;
    kind: string;
  }[];
}

export function listImportBatches(facilityId: string) {
  return q()
    .prepare(
      `SELECT b.*, d.label as source_label, d.adapter_key FROM import_batch b
       JOIN data_source d ON d.id = b.data_source_id
       WHERE b.facility_id = ? ORDER BY b.created_at DESC`
    )
    .all(facilityId) as unknown as {
    id: string;
    status: string;
    filename: string | null;
    row_count: number | null;
    summary_json: string | null;
    error_json: string | null;
    created_at: string;
    completed_at: string | null;
    source_label: string;
    adapter_key: string;
  }[];
}

export function getImportBatch(facilityId: string, batchId: string) {
  return q()
    .prepare(
      `SELECT b.*, d.label as source_label, d.adapter_key FROM import_batch b
       JOIN data_source d ON d.id = b.data_source_id
       WHERE b.facility_id = ? AND b.id = ?`
    )
    .get(facilityId, batchId) as
    | {
        id: string;
        status: string;
        filename: string | null;
        row_count: number | null;
        summary_json: string | null;
        error_json: string | null;
        created_at: string;
        completed_at: string | null;
        source_label: string;
        adapter_key: string;
      }
    | undefined;
}

export function listDataSources(facilityId: string) {
  return q()
    .prepare(`SELECT * FROM data_source WHERE facility_id = ? ORDER BY label`)
    .all(facilityId) as unknown as {
    id: string;
    adapter_key: string;
    label: string;
    kind: string;
  }[];
}

export function listDevices(facilityId: string) {
  return q()
    .prepare(`SELECT * FROM device WHERE facility_id = ? ORDER BY device_type`)
    .all(facilityId) as unknown as {
    id: string;
    device_type: string;
    make: string | null;
    model: string | null;
    sampling_hz: number | null;
  }[];
}

export function listVelocityData(facilityId: string, athleteId: string) {
  return q()
    .prepare(
      `SELECT es.exercise, es.load_kg, es.set_number, ts.session_date, vr.rep_number, vr.mean_velocity_ms
       FROM velocity_rep vr
       JOIN exercise_set es ON es.id = vr.exercise_set_id
       JOIN training_session ts ON ts.id = es.training_session_id
       WHERE vr.facility_id = ? AND ts.athlete_id = ?
       ORDER BY ts.session_date, es.exercise, es.set_number, vr.rep_number`
    )
    .all(facilityId, athleteId) as unknown as {
    exercise: string;
    load_kg: number;
    set_number: number;
    session_date: string;
    rep_number: number;
    mean_velocity_ms: number;
  }[];
}

export function listLoadVelocityProfiles(facilityId: string, athleteId: string) {
  return q()
    .prepare(
      `SELECT * FROM load_velocity_profile WHERE facility_id = ? AND athlete_id = ? ORDER BY fitted_on DESC`
    )
    .all(facilityId, athleteId) as unknown as {
    id: string;
    exercise: string;
    slope: number;
    intercept: number;
    r2: number;
    n_points: number;
    method_version: string;
    provisional: number;
    fitted_on: string;
    points_json: string;
  }[];
}

export function listPermissions(facilityId: string, athleteId: string) {
  return q()
    .prepare(
      `SELECT * FROM permission_record WHERE facility_id = ? AND athlete_id = ? AND revoked_at IS NULL`
    )
    .all(facilityId, athleteId) as unknown as {
    id: string;
    scope: string;
    granted_by: string;
    granted_at: string;
  }[];
}
