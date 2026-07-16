import { notFound } from "next/navigation";
import { Suspense } from "react";
import { currentFacility } from "@/lib/facility";
import {
  athleteDetail,
  metricTrend,
  asymmetryTrend,
  baselineSeries,
  findingsWithAnnotations,
  facilityFilterOptions,
} from "@/lib/services/queries";
import { METRICS, TEST_TYPES, BASELINE_MONITORED_METRICS, ASYMMETRY_SOURCE_METRICS, metricDef } from "@/lib/config/metrics";
import TrendChart from "@/components/charts/TrendChart";
import AsymmetryChart from "@/components/charts/AsymmetryChart";
import FilterBar from "@/components/FilterBar";
import FindingCard from "@/components/FindingCard";
import StageCriteria from "@/components/StageCriteria";
import { FindingRefs } from "@/lib/findings/engine";

export const dynamic = "force-dynamic";

export default async function AthletePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const facility = await currentFacility();
  const detail = athleteDetail(facility.id, id);
  if (!detail) notFound();

  const { athlete, sessions, protocol, stages, assessments, milestones, training, lvProfiles } = detail;
  const options = facilityFilterOptions(facility.id);
  const range = { from: sp.from, to: sp.to };

  const selectedMetric = sp.metric && METRICS[sp.metric] ? sp.metric : "cmj_jump_height";
  const def = metricDef(selectedMetric);
  const trend = metricTrend(facility.id, id, selectedMetric, "bilateral", range);

  const monitored = BASELINE_MONITORED_METRICS.includes(selectedMetric);
  const baseline = monitored ? baselineSeries(facility.id, id, selectedMetric, range) : null;
  const flaggedDates = baseline?.points.filter((p) => p.flag !== "none").map((p) => p.date) ?? [];

  const asymSource = sp.asym && ASYMMETRY_SOURCE_METRICS.includes(sp.asym) ? sp.asym : ASYMMETRY_SOURCE_METRICS[0];
  const asym = asymmetryTrend(facility.id, id, asymSource, range);

  const findings = findingsWithAnnotations(facility.id, id);
  const stageFinding = findings.find((f) => f.finding.category === "rts_stage_status");
  const stageRefs = stageFinding ? (JSON.parse(stageFinding.finding.refs_json) as FindingRefs) : null;

  const rfd = (["imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250"] as const).map((k) => ({
    def: METRICS[k],
    trend: metricTrend(facility.id, id, k, "bilateral", range),
  }));

  const testTypesUsed = [...new Set(sessions.map((s) => s.test_type))];
  const filteredSessions = sessions
    .filter((s) => !sp.test || s.test_type === sp.test)
    .filter((s) => (!sp.from || s.session_date >= sp.from) && (!sp.to || s.session_date <= sp.to));

  const latest = (metricType: string) => {
    const t = metricTrend(facility.id, id, metricType);
    return t.points.length ? t.points[t.points.length - 1] : null;
  };
  const latestJump = latest("cmj_jump_height");
  const latestMrsi = latest("cmj_mrsi");
  const latestImtpRel = latest("imtp_relative_force");
  const latestDj = latest("dj_rsi");

  const trainingRecent = training.slice(-30);

  return (
    <main className="page">
      <div className="page-head" style={{ display: "flex", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div className="eyebrow">{facility.name} · Athlete Overview</div>
          <h1>{athlete.display_name}</h1>
          <div className="sub">
            {athlete.team} · {athlete.sport} — {athlete.position} · {athlete.mass_kg} kg
            {protocol && (
              <>
                {" "}· <span className="chip" data-tone="stage">
                  {protocol.name} — {stages.find((s) => s.status === "current") ? `Stage ${stages.find((s) => s.status === "current")!.stage_number}` : "active"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", gap: 8 }}>
          <a className="btn secondary" href={`/agent?athlete=${id}`}>Intelligence agent</a>
          <a className="btn secondary" href={`/athletes/${id}/progress`}>Athlete view</a>
          <a className="btn" href={`/athletes/${id}/report`}>Practitioner report</a>
        </div>
      </div>

      <Suspense>
        <FilterBar
          options={{
            athletes: options.athletes,
            metrics: options.metrics.filter((m) => m.status === "implemented"),
            testTypes: testTypesUsed.map((t) => TEST_TYPES[t]).filter(Boolean),
            show: ["athlete", "metric", "testType", "range"],
          }}
        />
      </Suspense>

      <div className="statrow" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="k">Jump height</div>
          <div className="v">{latestJump ? latestJump.value.toFixed(1) : "—"}<small>cm</small></div>
          <div className="d">{latestJump?.date ?? "no data"}</div>
        </div>
        <div className="stat">
          <div className="k">mRSI</div>
          <div className="v">{latestMrsi ? latestMrsi.value.toFixed(2) : "—"}<small>m/s</small></div>
          <div className="d">{latestMrsi?.date ?? "no data"}</div>
        </div>
        <div className="stat">
          <div className="k">IMTP rel. force</div>
          <div className="v">{latestImtpRel ? latestImtpRel.value.toFixed(1) : "—"}<small>N/kg</small></div>
          <div className="d">{latestImtpRel?.date ?? "no data"}</div>
        </div>
        <div className="stat">
          <div className="k">DJ RSI</div>
          <div className="v">{latestDj ? latestDj.value.toFixed(2) : "—"}</div>
          <div className="d">{latestDj?.date ?? "no data"}</div>
        </div>
        <div className="stat">
          <div className="k">Asymmetry ({METRICS[asymSource].shortLabel})</div>
          <div className="v">
            {asym.points.length ? asym.points[asym.points.length - 1].value.toFixed(1) : "—"}<small>%</small>
          </div>
          <div className="d">watch ≥{asym.watchPct}% · flag ≥{asym.flagPct}%</div>
        </div>
      </div>

      <div className="panel">
        <h2>What changed</h2>
        <p className="panel-sub">
          Deterministic findings from this athlete&apos;s computed metrics. Insufficient data appears as a
          data gap, never as a guess.{" "}
          <a className="no-print" href={`/agent?athlete=${id}&ask=why_finding`} style={{ color: "var(--accent)" }}>
            Ask the intelligence agent why →
          </a>
        </p>
        {findings.length === 0 && <div className="callout" data-tone="ok">No findings for this athlete.</div>}
        {findings.slice(0, 6).map(({ finding, annotations }) => (
          <FindingCard key={finding.id} finding={finding} annotations={annotations} />
        ))}
        {findings.length > 6 && (
          <div style={{ fontSize: 12, color: "var(--ink-mute)" }}>
            {findings.length - 6} earlier findings appear in the practitioner report.
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Longitudinal trend — {def.label}</h2>
        <p className="panel-sub">
          Session-best values{monitored ? " with benchmark mean and rolling ±1 SD normal band" : ""}. Red
          points mark sessions flagged by the deviation rule. Milestones from this athlete&apos;s record.
        </p>
        <TrendChart
          points={trend.points}
          label={def.shortLabel}
          unit={def.unit}
          precision={def.precision}
          band={baseline?.points.map((p) => ({ date: p.date, low: p.bandLow, high: p.bandHigh }))}
          baselineMean={baseline?.baselineMean}
          thresholdLines={trend.thresholds}
          milestones={milestones}
          flaggedDates={flaggedDates}
          sessionLinkBase="/sessions"
          interpretation={def.interpretation}
          height={280}
        />
        {baseline && !baseline.sufficientBaseline && (
          <div className="callout" style={{ marginTop: 10 }}>
            Baseline not yet established: {trend.points.length} of {baseline.config.minBenchmarkSessions} benchmark
            sessions. The normal band and deviation flags activate once the benchmark window is complete.
          </div>
        )}
      </div>

      <div className="panel">
        <div className="chart-head" style={{ marginBottom: 2 }}>
          <h2 style={{ marginRight: "auto" }}>Asymmetry over time</h2>
          <div className="toggle no-print">
            {ASYMMETRY_SOURCE_METRICS.map((m) => (
              <a key={m} href={`?${new URLSearchParams({ ...spClean(sp), asym: m }).toString()}`}>
                <button data-on={m === asymSource}>{METRICS[m].shortLabel.toUpperCase()}</button>
              </a>
            ))}
          </div>
        </div>
        <p className="panel-sub">
          {protocol
            ? "This athlete is on an active staged protocol: limb symmetry is assessed inside the stage criteria below (LSI vs involved side), separately from general asymmetry monitoring."
            : "General asymmetry monitoring against facility thresholds."}
        </p>
        <AsymmetryChart
          points={asym.points}
          watchPct={asym.watchPct}
          flagPct={asym.flagPct}
          sourceLabel={METRICS[asymSource].label}
        />
        {METRICS[asymSource].interpretation && (
          <div className="interpret-note">{METRICS[asymSource].interpretation}</div>
        )}
      </div>

      {protocol && stageRefs?.criteria && (
        <div className="panel">
          <h2>Progression criteria status — {protocol.name}</h2>
          <p className="panel-sub">
            {stageFinding!.finding.detail}
          </p>
          <StageCriteria criteria={stageRefs.criteria} />
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {stages.map((s) => (
              <span
                key={s.id}
                className="chip"
                data-tone={s.status === "completed" ? "ok" : s.status === "current" ? "stage" : undefined}
              >
                {s.stage_number}. {s.name}
                {s.status === "completed" ? " ✓" : s.status === "current" ? " · current" : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Rate of force development — IMTP phase windows</h2>
        <p className="panel-sub">
          Average slope of the force–time curve in each window after onset. The windows carry different
          training meanings — shown with each chart.
        </p>
        <div className="grid3">
          {rfd.map(({ def: d, trend: t }) => (
            <div key={d.key}>
              <TrendChart
                points={t.points}
                label={d.shortLabel}
                unit={d.unit}
                precision={d.precision}
                thresholdLines={t.thresholds}
                height={170}
                interpretation={d.interpretation}
              />
            </div>
          ))}
        </div>
      </div>

      {(trainingRecent.length > 0 || lvProfiles.length > 0) && (
        <div className="grid2">
          {trainingRecent.length > 0 && (
            <div className="panel">
              <h2>Training load (context)</h2>
              <p className="panel-sub">Session RPE × duration, arbitrary units. Context for findings — never a suppressor.</p>
              <TrendChart
                points={trainingRecent.map((t) => ({ date: t.session_date, value: t.load_au ?? 0 }))}
                label="Session load"
                unit="AU"
                precision={0}
                color="var(--stage)"
                height={170}
              />
            </div>
          )}
          {lvProfiles.length > 0 && (
            <div className="panel">
              <h2>
                Load–velocity profile{" "}
                <span className="chip" data-tone="provisional">provisional</span>
              </h2>
              <p className="panel-sub">
                {lvProfiles[0].exercise.replace("_", " ")} · fitted {lvProfiles[0].fitted_on} · R²{" "}
                {lvProfiles[0].r2.toFixed(3)} · method {lvProfiles[0].method_version}. No 1RM estimate or
                prescription is derived until the protocol is validated for this athlete.
              </p>
              <table className="data">
                <thead>
                  <tr><th className="num">Load (kg)</th><th className="num">Mean velocity (m/s)</th></tr>
                </thead>
                <tbody>
                  {(JSON.parse(lvProfiles[0].points_json) as { loadKg: number; meanVelocityMs: number }[]).map(
                    (p) => (
                      <tr key={p.loadKg}>
                        <td className="num">{p.loadKg}</td>
                        <td className="num">{p.meanVelocityMs.toFixed(2)}</td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 8, fontFamily: "var(--font-mono)" }}>
                slope {lvProfiles[0].slope.toFixed(4)} (m/s)/kg · intercept {lvProfiles[0].intercept.toFixed(2)} m/s
              </div>
            </div>
          )}
        </div>
      )}

      {assessments.length > 0 && (
        <div className="panel">
          <h2>Practitioner notes</h2>
          <p className="panel-sub">Human-authored context, displayed verbatim. The platform never generates these notes itself.</p>
          {assessments.map((a) => (
            <div key={a.id} className="finding" data-sev="info" style={{ borderLeftColor: "var(--ink-mute)" }}>
              <div className="f-head">
                <span className="f-title">{a.category.replace(/_/g, " ")}</span>
                <span className="f-date">{a.assessed_on} · {a.assessor}</span>
              </div>
              <div className="f-detail">{a.summary}</div>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Test sessions</h2>
        <p className="panel-sub">{filteredSessions.length} sessions{sp.test ? ` · ${TEST_TYPES[sp.test]?.label}` : ""}. Open a session for the trial-level drill-down.</p>
        <table className="data">
          <thead>
            <tr><th>Date</th><th>Test</th><th>Notes</th><th></th></tr>
          </thead>
          <tbody>
            {filteredSessions.slice().reverse().slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{s.session_date}</td>
                <td>{TEST_TYPES[s.test_type]?.label ?? s.test_type}</td>
                <td style={{ color: "var(--ink-dim)", fontSize: 12.5 }}>{s.notes ?? ""}</td>
                <td><a href={`/sessions/${s.id}`} style={{ color: "var(--accent)", fontSize: 12.5 }}>drill down →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/** carries existing filters through the asym-source toggle links */
function spClean(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (v != null && k !== "asym") out[k] = v;
  return out;
}
