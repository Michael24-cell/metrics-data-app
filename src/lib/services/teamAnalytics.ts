/**
 * Test-first team analytics — the roster's cohort comparison view.
 *
 * One metric at a time: the selected test determines which metrics are
 * offered; the selected metric drives EVERY number in the view (summary,
 * per-athlete values, normalized values, trends, diffs, z-scores) so a
 * metric change updates them all consistently.
 *
 * Cohorts follow calc/cohort.ts: population SD, athlete included, whole-team
 * default plus position groups. An athlete's comparison value is their most
 * recent session-best inside the selected window. Athletes with no value in
 * the window appear listed but excluded from the cohort (shown as such).
 */

import { listAthletes, sessionBestSeries } from "../db/dal";
import { getDb } from "../db/db";
import { METRICS, MetricDef, metricDef } from "../config/metrics";
import { CohortStats, cohortStats, diffFromMean, zScore } from "../calc/cohort";
import { summarizeSeries } from "../calc/seriesSummary";

/** Test types any athlete on this team has actually recorded, registry order not guaranteed. */
export function teamTestTypes(facilityId: string, team: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT s.test_type t FROM session s JOIN athlete a ON a.id = s.athlete_id
       WHERE s.facility_id = ? AND a.team = ? ORDER BY t`
    )
    .all(facilityId, team) as { t: string }[];
  return rows.map((r) => r.t);
}

export interface TeamAnalyticsRow {
  athleteId: string;
  name: string;
  position: string | null;
  /** highest valid value in the selected window */
  peak: number | null;
  /** arithmetic mean of valid values in the selected window */
  average: number | null;
  /** most recent session-best inside the window; null = no data (excluded from cohort) */
  mostRecent: number | null;
  mostRecentDate: string | null;
  /** value of the registered normalized counterpart on the SAME date as mostRecent, if any */
  normalized: number | null;
  /** chronological valid values for this metric within the selected window */
  trend: { date: string; value: number }[];
  /** latest minus previous session-best inside the window */
  recentDelta: number | null;
  teamDiff: number | null;
  teamZ: number | null;
  positionDiff: number | null;
  positionZ: number | null;
}

export interface TeamAnalyticsResult {
  def: MetricDef;
  normalizedDef: MetricDef | null;
  team: CohortStats;
  positions: { position: string; stats: CohortStats }[];
  rows: TeamAnalyticsRow[];
  /** athletes on the team with no value for this metric in the window */
  excludedCount: number;
}

export function teamAnalytics(
  facilityId: string,
  team: string,
  metricKey: string,
  range: { from?: string; to?: string } = {}
): TeamAnalyticsResult {
  const def = metricDef(metricKey);
  const normalizedDef = def.normalizedKey ? METRICS[def.normalizedKey] : null;
  const athletes = listAthletes(facilityId, team);

  const prelim = athletes.map((a) => {
    const series = sessionBestSeries(facilityId, a.id, metricKey, "bilateral", range);
    const summary = summarizeSeries(series);
    let normalized: number | null = null;
    if (summary.mostRecentDate && normalizedDef) {
      const normSeries = sessionBestSeries(facilityId, a.id, normalizedDef.key, "bilateral", range);
      const normLatest = normSeries.length ? normSeries[normSeries.length - 1] : null;
      normalized = normLatest && normLatest.date === summary.mostRecentDate ? normLatest.value : null;
    }
    return {
      athlete: a,
      series,
      summary,
      normalized,
      recentDelta: series.length >= 2 ? series[series.length - 1].value - series[series.length - 2].value : null,
    };
  });

  // Cohorts compare current standing — the most recent value per athlete.
  const withValue = prelim.filter((p) => p.summary.mostRecent != null);
  const team_ = cohortStats(withValue.map((p) => p.summary.mostRecent!));

  const positionNames = [...new Set(athletes.map((a) => a.position).filter((p): p is string => !!p))];
  const positionStats = new Map<string, CohortStats>(
    positionNames.map((pos) => [
      pos,
      cohortStats(withValue.filter((p) => p.athlete.position === pos).map((p) => p.summary.mostRecent!)),
    ])
  );

  const rows: TeamAnalyticsRow[] = prelim.map((p) => {
    const v = p.summary.mostRecent;
    const posStats = p.athlete.position ? positionStats.get(p.athlete.position) : undefined;
    return {
      athleteId: p.athlete.id,
      name: p.athlete.display_name,
      position: p.athlete.position,
      peak: p.summary.peak,
      average: p.summary.average,
      mostRecent: v,
      mostRecentDate: p.summary.mostRecentDate,
      normalized: p.normalized,
      trend: p.series.map((s) => ({ date: s.date, value: s.value })),
      recentDelta: p.recentDelta,
      teamDiff: v == null ? null : diffFromMean(v, team_),
      teamZ: v == null ? null : zScore(v, team_),
      positionDiff: v == null || !posStats ? null : diffFromMean(v, posStats),
      positionZ: v == null || !posStats ? null : zScore(v, posStats),
    };
  });

  // sort: athletes with values by most-recent value (best first per higherIsBetter), no-data last
  rows.sort((a, b) => {
    if (a.mostRecent == null && b.mostRecent == null) return a.name.localeCompare(b.name);
    if (a.mostRecent == null) return 1;
    if (b.mostRecent == null) return -1;
    return def.higherIsBetter ? b.mostRecent - a.mostRecent : a.mostRecent - b.mostRecent;
  });

  return {
    def,
    normalizedDef,
    team: team_,
    positions: positionNames.map((position) => ({ position, stats: positionStats.get(position)! })),
    rows,
    excludedCount: prelim.length - withValue.length,
  };
}
