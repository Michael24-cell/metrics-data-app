import { notFound } from "next/navigation";
import { currentFacility } from "@/lib/facility";
import { athleteDetail, metricTrend, baselineSeries, findingsWithAnnotations } from "@/lib/services/queries";
import { METRICS } from "@/lib/config/metrics";
import TrendChart from "@/components/charts/TrendChart";
import StageCriteria from "@/components/StageCriteria";
import { FindingRefs } from "@/lib/findings/engine";

export const dynamic = "force-dynamic";

/**
 * Athlete-facing progress view: the athlete's own data in plain language.
 * Same data layer as the practitioner surfaces — simplified, never sugarcoated,
 * and free of clinical detail beyond what practitioners entered for sharing.
 */
export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facility = await currentFacility();
  const detail = athleteDetail(facility.id, id);
  if (!detail) notFound();
  const { athlete, protocol, stages, milestones } = detail;

  const jump = metricTrend(facility.id, id, "cmj_jump_height");
  const baseline = baselineSeries(facility.id, id, "cmj_jump_height");
  const findings = findingsWithAnnotations(facility.id, id);
  const stageFinding = findings.find((f) => f.finding.category === "rts_stage_status");
  const stageRefs = stageFinding ? (JSON.parse(stageFinding.finding.refs_json) as FindingRefs) : null;
  const currentStage = stages.find((s) => s.status === "current");

  const latest = jump.points[jump.points.length - 1];
  const first = jump.points[0];
  const vsBaseline =
    latest && baseline.baselineMean ? ((latest.value / baseline.baselineMean) * 100).toFixed(0) : null;

  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div className="eyebrow">{facility.short_name} · Your progress</div>
        <h1>{athlete.display_name}</h1>
        <div className="sub">
          This page shows your measured test results and how they are trending. Your coaching and medical
          team interprets them with you — the numbers themselves never make decisions.
        </div>
      </div>

      <div className="statrow" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="k">Latest jump height</div>
          <div className="v">{latest ? latest.value.toFixed(1) : "—"}<small>cm</small></div>
          <div className="d">{latest?.date ?? ""}</div>
        </div>
        {vsBaseline && (
          <div className="stat">
            <div className="k">vs your benchmark</div>
            <div className="v">{vsBaseline}<small>%</small></div>
            <div className="d">benchmark {baseline.baselineMean!.toFixed(1)} cm</div>
          </div>
        )}
        {first && latest && (
          <div className="stat">
            <div className="k">Tracked since</div>
            <div className="v" style={{ fontSize: 15 }}>{first.date}</div>
            <div className="d">{jump.points.length} test sessions</div>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Your jump height over time</h2>
        <p className="panel-sub">
          Each point is your best jump of the session, measured from the force plates. The shaded band is
          your recent normal range.
        </p>
        <TrendChart
          points={jump.points}
          label="Jump height"
          unit="cm"
          precision={1}
          band={baseline.points.map((p) => ({ date: p.date, low: p.bandLow, high: p.bandHigh }))}
          baselineMean={baseline.baselineMean}
          milestones={milestones}
          height={260}
        />
      </div>

      {protocol && currentStage && stageRefs?.criteria && (
        <div className="panel">
          <h2>Where you are in your return plan</h2>
          <p className="panel-sub">
            You are in stage {currentStage.stage_number} of {stages.length}: “{currentStage.name}”. These are
            the measured targets your team set for this stage — your team decides when to progress, using
            these numbers plus everything else they know about you.
          </p>
          <StageCriteria criteria={stageRefs.criteria} />
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {stages.map((s) => (
              <span key={s.id} className="chip" data-tone={s.status === "completed" ? "ok" : s.status === "current" ? "stage" : undefined}>
                {s.stage_number}. {s.name}{s.status === "completed" ? " ✓" : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="scope-note">
        These charts describe measured performance only. They do not diagnose anything, predict injury, or
        decide when you return to play — those calls belong to you and your qualified clinical and
        performance team.
      </div>
    </main>
  );
}
