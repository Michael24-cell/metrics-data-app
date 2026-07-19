/**
 * Reliability service — feeds validated per-session attempt values from the
 * database into the pure reliability engine. Facility-scoped like every
 * service. Attempts with quality flags are EXCLUDED with the reason kept.
 */

import { getDb } from "../db/db";
import { metricDef } from "../config/metrics";
import { statPolicyFor, MetricStatPolicy } from "../config/statPolicies";
import { computeReliability, ReliabilityResult } from "../calc/reliability";

export function reliabilityForMetric(
  facilityId: string,
  athleteId: string,
  metricKey: string,
  range: { from?: string; to?: string } = {},
  policyOverride?: MetricStatPolicy | null
): ReliabilityResult {
  const def = metricDef(metricKey);
  let sql = `
    SELECT s.session_date as date, m.value, m.quality_flag, m.method_version, m.trial_id
    FROM metric m JOIN session s ON s.id = m.session_id
    WHERE m.facility_id = ? AND m.athlete_id = ? AND m.metric_type = ? AND m.side = 'bilateral' AND m.trial_id IS NOT NULL`;
  const params: string[] = [facilityId, athleteId, metricKey];
  if (range.from) { sql += ` AND s.session_date >= ?`; params.push(range.from); }
  if (range.to) { sql += ` AND s.session_date <= ?`; params.push(range.to); }
  sql += ` ORDER BY s.session_date ASC`;
  const rows = getDb().prepare(sql).all(...params) as unknown as {
    date: string; value: number; quality_flag: string | null; method_version: string; trial_id: string;
  }[];

  const byDate = new Map<string, { valid: number[]; flagged: number }>();
  const methodVersions = new Set<string>();
  for (const r of rows) {
    methodVersions.add(r.method_version);
    const e = byDate.get(r.date) ?? { valid: [], flagged: 0 };
    if (r.quality_flag) e.flagged += 1;
    else e.valid.push(r.value);
    byDate.set(r.date, e);
  }

  const sessions: { date: string; sessionBest: number; attemptValues: number[] }[] = [];
  const excludedSessions: { date: string; reason: string }[] = [];
  for (const [date, e] of byDate) {
    if (e.valid.length === 0) {
      excludedSessions.push({ date, reason: `all ${e.flagged} attempt(s) quality-flagged` });
      continue;
    }
    sessions.push({ date, sessionBest: Math.max(...e.valid), attemptValues: e.valid });
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));

  const comparable = methodVersions.size <= 1;
  return computeReliability(
    {
      metricKey,
      testType: def.testType,
      unit: def.unit,
      sessions,
      excludedSessions,
      comparable,
      comparabilityReason: comparable ? undefined : `mixed calculation-method versions (${[...methodVersions].join(", ")})`,
    },
    policyOverride !== undefined ? policyOverride : statPolicyFor(metricKey)
  );
}
