/**
 * Alert generation + lifecycle (server-only, outside React).
 *
 * Generation is an idempotent job: alerts derive ONLY from persisted
 * monitoring results and validated analytics, carry the policy fingerprint
 * and calc versions they were generated under, and deduplicate on a
 * deterministic key — the same source event can never spawn duplicates.
 *
 * Lifecycle: new → acknowledged → resolved | dismissed (with reason).
 * No readiness, injury, or medical alerts exist; alert types are
 * measured-performance events for coach review.
 */

import { getDb, newId, nowIso } from "../db/db";
import { listAthletes } from "../db/dal";
import { METRICS } from "../config/metrics";
import { ASYMMETRY_SOURCE_METRICS } from "../config/metrics";
import { asymmetryTrend } from "./queries";
import { effectivePolicy } from "./monitoringPolicy";
import { evaluateAthlete, listMonitoringResults, MonitoringResultRow } from "./monitoringEngine";
import { reliabilityForMetric } from "./reliability";
import { recordAudit } from "../audit";

export type AlertType =
  | "review_suggested"
  | "repeated_low_signal"
  | "new_pr"
  | "asymmetry_crossing"
  | "reliability_concern"
  | "monitoring_data_gap"
  | "baseline_completed";

export type AlertStatus = "new" | "acknowledged" | "resolved" | "dismissed";

export interface AlertRow {
  id: string;
  facility_id: string;
  athlete_id: string;
  test_type: string | null;
  metric_key: string | null;
  session_id: string | null;
  session_date: string | null;
  alert_type: AlertType;
  severity: "info" | "review" | "high";
  monitoring_result_id: string | null;
  policy_fingerprint: string | null;
  calc_version: string | null;
  evidence_json: string;
  dedupe_key: string;
  status: AlertStatus;
  created_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  close_reason: string | null;
  coach_note: string | null;
}

interface Candidate {
  athleteId: string;
  testType?: string;
  metricKey?: string;
  sessionId?: string;
  sessionDate?: string;
  type: AlertType;
  severity: "info" | "review" | "high";
  monitoringResultId?: string;
  policyFingerprint?: string;
  calcVersion?: string;
  evidence: Record<string, unknown>;
  dedupeSuffix: string;
}

function insertCandidate(facilityId: string, c: Candidate): number {
  const dedupe = `${facilityId}:${c.athleteId}:${c.metricKey ?? "-"}:${c.dedupeSuffix}:${c.type}`;
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO alert
       (id, facility_id, athlete_id, test_type, metric_key, session_id, session_date, alert_type, severity,
        monitoring_result_id, policy_fingerprint, calc_version, evidence_json, dedupe_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    )
    .run(
      newId(), facilityId, c.athleteId, c.testType ?? null, c.metricKey ?? null, c.sessionId ?? null,
      c.sessionDate ?? null, c.type, c.severity, c.monitoringResultId ?? null, c.policyFingerprint ?? null,
      c.calcVersion ?? null, JSON.stringify(c.evidence), dedupe, nowIso()
    );
  return Number(res.changes);
}

/** Generate alerts for one athlete from CURRENT monitoring results. Idempotent. */
export function generateAlertsForAthlete(facilityId: string, athleteId: string, coachUserId?: string | null): number {
  const { effective } = evaluateAthlete(facilityId, athleteId, coachUserId);
  let created = 0;

  for (const metricKey of effective.policy.metricKeys) {
    const def = METRICS[metricKey];
    if (!def) continue;
    const rows: MonitoringResultRow[] = listMonitoringResults(facilityId, athleteId, metricKey, effective.fingerprint);
    if (rows.length === 0) continue;
    const latest = rows[rows.length - 1];

    /* one alert per qualifying RESULT EVENT — historical events included on
       first enable; the dedupe key makes every rerun a no-op */
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const prior = rows.slice(0, i);
      const base = {
        athleteId,
        testType: def.testType,
        metricKey,
        sessionId: r.session_id,
        sessionDate: r.session_date,
        monitoringResultId: r.id,
        policyFingerprint: r.policy_fingerprint,
        calcVersion: r.calc_version,
      };

      if (r.monitoring_state === "review_suggested") {
        created += insertCandidate(facilityId, {
          ...base, type: "review_suggested", severity: "review",
          evidence: { value: r.current_value, bandLow: r.band_low, bandHigh: r.band_high, referenceMean: r.reference_mean, referenceCount: r.reference_count, noiseState: r.noise_state },
          dedupeSuffix: `${r.session_id}:${r.policy_fingerprint}`,
        });
      }
      if (r.monitoring_state === "repeated_low_signal") {
        created += insertCandidate(facilityId, {
          ...base, type: "repeated_low_signal", severity: "high",
          evidence: { value: r.current_value, bandLow: r.band_low, bandHigh: r.band_high, referenceMean: r.reference_mean, consecutiveRule: effective.policy.consecutiveLowCount },
          dedupeSuffix: `${r.session_id}:${r.policy_fingerprint}`,
        });
      }
      if (r.monitoring_state === "insufficient_reliable_data" && i === rows.length - 1) {
        created += insertCandidate(facilityId, {
          ...base, type: "monitoring_data_gap", severity: "info",
          evidence: { noiseState: r.noise_state, detail: "monitoring signal withheld — reliability requirement not met" },
          dedupeSuffix: `${r.session_id}:${r.policy_fingerprint}`,
        });
      }

      /* new PR: best-direction record vs ALL prior monitored sessions (active phase only) */
      if (prior.length > 0 && r.monitoring_state !== "collecting_baseline") {
        const priorVals = prior.map((p) => p.current_value);
        const isPr = def.higherIsBetter ? r.current_value > Math.max(...priorVals) : r.current_value < Math.min(...priorVals);
        if (isPr) {
          created += insertCandidate(facilityId, {
            ...base, type: "new_pr", severity: "info",
            evidence: { value: r.current_value, previousBest: def.higherIsBetter ? Math.max(...priorVals) : Math.min(...priorVals), sessions: i + 1 },
            dedupeSuffix: `${r.session_id}`,
          });
        }
      }

      /* baseline completed: the FIRST non-baseline result */
      if (r.monitoring_state !== "collecting_baseline" && prior.length > 0 && prior[prior.length - 1].monitoring_state === "collecting_baseline") {
        created += insertCandidate(facilityId, {
          ...base, type: "baseline_completed", severity: "info",
          evidence: { baselineSessions: effective.policy.baselineSessions },
          dedupeSuffix: `${r.session_id}:${r.policy_fingerprint}`,
        });
      }
    }

    const metricBase = {
      athleteId,
      testType: def.testType,
      metricKey,
      policyFingerprint: latest.policy_fingerprint,
      calcVersion: latest.calc_version,
    };

    /* reliability concern: once per metric + policy fingerprint */
    const rel = reliabilityForMetric(facilityId, athleteId, metricKey);
    if (rel.availability === "poor_within_session_reliability") {
      created += insertCandidate(facilityId, {
        ...metricBase, sessionDate: latest.session_date, type: "reliability_concern", severity: "info",
        evidence: { meanSessionCvPct: rel.meanSessionCvPct, warnThresholdNote: rel.availabilityReason },
        dedupeSuffix: `${latest.policy_fingerprint}`,
      });
    }

    /* asymmetry threshold crossing (only for monitored, asymmetry-eligible metrics) */
    if ((ASYMMETRY_SOURCE_METRICS as string[]).includes(metricKey)) {
      const asym = asymmetryTrend(facilityId, athleteId, metricKey);
      const pts = asym.points;
      if (pts.length >= 2) {
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        if (last.value >= asym.flagPct && prev.value < asym.flagPct) {
          created += insertCandidate(facilityId, {
            ...metricBase, sessionId: last.sessionId, sessionDate: last.date, type: "asymmetry_crossing", severity: "review",
            evidence: { asymmetryPct: last.value, previousPct: prev.value, flagPct: asym.flagPct, strongerSide: last.strongerSide },
            dedupeSuffix: `${last.sessionId}`,
          });
        }
      }
    }
  }
  return created;
}

/** Idempotent facility-wide monitoring job (queue/scheduler boundary). */
export function runMonitoringJob(facilityId: string, triggeredBy?: string | null): { athletes: number; alertsCreated: number } {
  const athletes = listAthletes(facilityId);
  let alertsCreated = 0;
  for (const a of athletes) {
    try {
      alertsCreated += generateAlertsForAthlete(facilityId, a.id);
    } catch {
      /* one athlete's failure never blocks the job; error-monitoring hook point */
    }
  }
  recordAudit({ facilityId, userId: triggeredBy ?? null, action: "monitoring.job_run", outcome: "ok", metadata: { athletes: athletes.length, alertsCreated } });
  return { athletes: athletes.length, alertsCreated };
}

/* ---------------- lifecycle ---------------- */

export function listAlerts(
  facilityId: string,
  filters: { status?: AlertStatus; athleteId?: string; type?: AlertType; sinceDays?: number } = {}
): AlertRow[] {
  let sql = `SELECT * FROM alert WHERE facility_id = ?`;
  const params: (string | number)[] = [facilityId];
  if (filters.status) { sql += ` AND status = ?`; params.push(filters.status); }
  if (filters.athleteId) { sql += ` AND athlete_id = ?`; params.push(filters.athleteId); }
  if (filters.type) { sql += ` AND alert_type = ?`; params.push(filters.type); }
  sql += ` ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, created_at DESC LIMIT 200`;
  return getDb().prepare(sql).all(...params) as unknown as AlertRow[];
}

export function getAlert(facilityId: string, alertId: string): AlertRow | null {
  return (getDb().prepare(`SELECT * FROM alert WHERE facility_id = ? AND id = ?`).get(facilityId, alertId) as AlertRow | undefined) ?? null;
}

export function transitionAlert(
  facilityId: string,
  alertId: string,
  action: "acknowledge" | "resolve" | "dismiss" | "note",
  userId: string | null,
  opts: { reason?: string; note?: string } = {}
): AlertRow | { error: string } {
  const db = getDb();
  const alert = getAlert(facilityId, alertId);
  if (!alert) return { error: "Alert not found in the authorized facility." };
  const now = nowIso();
  if (action === "acknowledge") {
    if (alert.status !== "new") return { error: `Cannot acknowledge an alert in status '${alert.status}'.` };
    db.prepare(`UPDATE alert SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`).run(userId, now, alertId);
  } else if (action === "resolve" || action === "dismiss") {
    if (alert.status === "resolved" || alert.status === "dismissed") return { error: `Alert already ${alert.status}.` };
    if (action === "dismiss" && !opts.reason) return { error: "Dismissal requires a reason." };
    db.prepare(`UPDATE alert SET status = ?, closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?`).run(
      action === "resolve" ? "resolved" : "dismissed", userId, now, opts.reason ?? null, alertId
    );
  } else if (action === "note") {
    db.prepare(`UPDATE alert SET coach_note = ? WHERE id = ?`).run(opts.note ?? null, alertId);
  }
  recordAudit({
    facilityId, userId, action: `alert.${action}`, resourceType: "alert", resourceId: alertId,
    versions: alert.policy_fingerprint ? { policy: alert.policy_fingerprint } : undefined,
    metadata: { alertType: alert.alert_type, reason: opts.reason ?? null },
  });
  return getAlert(facilityId, alertId)!;
}

/* ---------------- digest ---------------- */

export function coachDigest(facilityId: string, sinceDays: 1 | 7) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const rows = getDb()
    .prepare(`SELECT * FROM alert WHERE facility_id = ? AND created_at >= ? ORDER BY created_at DESC`)
    .all(facilityId, since) as unknown as AlertRow[];
  const closed = getDb()
    .prepare(`SELECT * FROM alert WHERE facility_id = ? AND closed_at >= ? ORDER BY closed_at DESC`)
    .all(facilityId, since) as unknown as AlertRow[];
  const group = (type: AlertType) => rows.filter((r) => r.alert_type === type);
  return {
    windowDays: sinceDays,
    newReview: group("review_suggested"),
    repeatedLow: group("repeated_low_signal"),
    newPrs: group("new_pr"),
    asymmetryCrossings: group("asymmetry_crossing"),
    reliabilityConcerns: group("reliability_concern"),
    baselineCompleted: group("baseline_completed"),
    dataGaps: group("monitoring_data_gap"),
    resolved: closed,
    totals: { created: rows.length, open: rows.filter((r) => r.status === "new").length },
  };
}
