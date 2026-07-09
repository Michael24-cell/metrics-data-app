/**
 * Practitioner report builder. The report is a projection of exactly the same
 * data + findings the dashboard reads — no separate calculation path.
 */

import { athleteDetail, metricTrend, asymmetryTrend, baselineSeries, findingsWithAnnotations } from "./queries";
import { getFacility, sessionBestSeries } from "../db/dal";
import { METRICS } from "../config/metrics";
import { FINDINGS_ENGINE_VERSION } from "../findings/engine";

export const SCOPE_STATEMENT =
  "This report describes measured data and trends. It does not diagnose, predict injury, or clear an athlete to return to play. Those decisions remain with the athlete's qualified clinical and performance team.";

export function buildReport(facilityId: string, athleteId: string, range: { from?: string; to?: string } = {}) {
  const facility = getFacility(facilityId);
  const detail = athleteDetail(facilityId, athleteId);
  if (!facility || !detail) return null;

  const jump = metricTrend(facilityId, athleteId, "cmj_jump_height", "bilateral", range);
  const mrsi = metricTrend(facilityId, athleteId, "cmj_mrsi", "bilateral", range);
  const imtpRel = metricTrend(facilityId, athleteId, "imtp_relative_force", "bilateral", range);
  const rfdSeries = (["imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250"] as const).map((k) => ({
    key: k,
    def: METRICS[k],
    points: sessionBestSeries(facilityId, athleteId, k, "bilateral", range),
  }));
  const asym = asymmetryTrend(facilityId, athleteId, "cmj_ecc_braking_impulse", range);
  const asymImtp = asymmetryTrend(facilityId, athleteId, "imtp_peak_force", range);
  const baseline = baselineSeries(facilityId, athleteId, "cmj_jump_height", range);
  const findings = findingsWithAnnotations(facilityId, athleteId);

  // per-session summary table (last 12 test sessions in range)
  const sessions = detail.sessions
    .filter((s) => (!range.from || s.session_date >= range.from) && (!range.to || s.session_date <= range.to))
    .slice(-12)
    .map((s) => {
      const best = (metricType: string) => {
        const rows = sessionBestSeries(facilityId, athleteId, metricType);
        return rows.find((r) => r.sessionId === s.id)?.value ?? null;
      };
      return {
        id: s.id,
        date: s.session_date,
        testType: s.test_type,
        jumpHeight: best("cmj_jump_height"),
        mrsiVal: best("cmj_mrsi"),
        imtpPeak: best("imtp_peak_force"),
        djRsi: best("dj_rsi"),
      };
    });

  const stageFinding = findings.find((f) => f.finding.category === "rts_stage_status");

  return {
    scopeStatement: SCOPE_STATEMENT,
    engineVersion: FINDINGS_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    facility,
    range,
    athlete: detail.athlete,
    protocol: detail.protocol,
    stages: detail.stages,
    stageFinding,
    injuries: detail.injuries,
    milestones: detail.milestones,
    assessments: detail.assessments,
    findings,
    charts: { jump, mrsi, imtpRel, rfdSeries, asym, asymImtp, baseline },
    sessions,
    methodVersions: Object.values(METRICS).map((m) => ({
      key: m.key,
      label: m.label,
      version: m.methodVersion,
      status: m.status,
    })),
  };
}

export type ReportPayload = NonNullable<ReturnType<typeof buildReport>>;
