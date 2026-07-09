import { notFound } from "next/navigation";
import { currentFacility } from "@/lib/facility";
import { buildReport } from "@/lib/services/report";
import { METRICS, TEST_TYPES } from "@/lib/config/metrics";
import TrendChart from "@/components/charts/TrendChart";
import AsymmetryChart from "@/components/charts/AsymmetryChart";
import StageCriteria from "@/components/StageCriteria";
import FindingCard from "@/components/FindingCard";
import PrintButton from "@/components/PrintButton";
import { FindingRefs } from "@/lib/findings/engine";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const facility = await currentFacility();
  const report = buildReport(facility.id, id, { from: sp.from, to: sp.to });
  if (!report) notFound();

  const { athlete, charts, sessions, findings, stageFinding, protocol, milestones, assessments } = report;
  const stageRefs = stageFinding ? (JSON.parse(stageFinding.finding.refs_json) as FindingRefs) : null;
  const attention = findings.filter((f) => f.finding.severity !== "info").slice(0, 8);
  const currentStage = report.stages.find((s) => s.status === "current");

  const latestJump = charts.jump.points[charts.jump.points.length - 1];
  const latestAsym = charts.asym.points[charts.asym.points.length - 1];

  return (
    <main className="page report-page">
      {/* cover / header */}
      <div className="report-cover report-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div className="eyebrow">Practitioner Report · {report.facility.name}</div>
            <h1 style={{ fontSize: 34, marginTop: 4 }}>{athlete.display_name}</h1>
            <div style={{ color: "var(--ink-dim)", fontSize: 13.5 }}>
              {athlete.team} · {athlete.sport} — {athlete.position} · {athlete.mass_kg} kg
            </div>
          </div>
          <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-mute)" }}>
            <div>generated {report.generatedAt.slice(0, 10)}</div>
            <div>findings engine v{report.engineVersion}</div>
            {report.range.from || report.range.to ? (
              <div>window {report.range.from ?? "…"} → {report.range.to ?? "…"}</div>
            ) : (
              <div>full history</div>
            )}
            <div className="no-print" style={{ marginTop: 10 }}>
              <PrintButton />
            </div>
          </div>
        </div>
        <div className="scope-note" style={{ marginTop: 16 }}>
          {report.scopeStatement}
        </div>
      </div>

      {/* summary */}
      <div className="panel report-section">
        <h2>Summary</h2>
        <div className="statrow" style={{ margin: "10px 0" }}>
          <div className="stat">
            <div className="k">Latest jump height</div>
            <div className="v">{latestJump ? latestJump.value.toFixed(1) : "—"}<small>cm</small></div>
            <div className="d">{latestJump?.date}</div>
          </div>
          <div className="stat">
            <div className="k">Benchmark mean</div>
            <div className="v">
              {charts.baseline.baselineMean ? charts.baseline.baselineMean.toFixed(1) : "—"}<small>cm</small>
            </div>
            <div className="d">{charts.baseline.sufficientBaseline ? "established" : "not yet established"}</div>
          </div>
          <div className="stat">
            <div className="k">Braking asymmetry</div>
            <div className="v">{latestAsym ? latestAsym.value.toFixed(1) : "—"}<small>%</small></div>
            <div className="d">{latestAsym ? `${latestAsym.strongerSide} stronger` : "no per-side data"}</div>
          </div>
          {protocol && currentStage && (
            <div className="stat">
              <div className="k">Protocol stage</div>
              <div className="v" style={{ fontSize: 15 }}>Stage {currentStage.stage_number} of {report.stages.length}</div>
              <div className="d">{currentStage.name}</div>
            </div>
          )}
        </div>
        {attention.length > 0 ? (
          <>
            <p className="panel-sub" style={{ marginTop: 8 }}>
              Active watch/flag findings (identical to the dashboard — same data, same engine):
            </p>
            {attention.map(({ finding, annotations }) => (
              <FindingCard key={finding.id} finding={finding} annotations={annotations} showRefs={false} />
            ))}
          </>
        ) : (
          <div className="callout" data-tone="ok">No active watch or flag findings.</div>
        )}
      </div>

      {/* longitudinal charts */}
      <div className="panel report-section">
        <h2>Longitudinal trends</h2>
        <p className="panel-sub">Session-best values; shaded band = rolling ±1 SD normal range where a benchmark exists.</p>
        <TrendChart
          points={charts.jump.points}
          label={charts.jump.def.shortLabel}
          unit={charts.jump.def.unit}
          precision={charts.jump.def.precision}
          band={charts.baseline.points.map((p) => ({ date: p.date, low: p.bandLow, high: p.bandHigh }))}
          baselineMean={charts.baseline.baselineMean}
          milestones={milestones}
          flaggedDates={charts.baseline.points.filter((p) => p.flag !== "none").map((p) => p.date)}
          height={240}
        />
        <div className="grid2" style={{ marginTop: 14 }}>
          <TrendChart points={charts.mrsi.points} label={charts.mrsi.def.shortLabel} unit={charts.mrsi.def.unit} precision={2} height={180} interpretation={charts.mrsi.def.interpretation} />
          <TrendChart points={charts.imtpRel.points} label={charts.imtpRel.def.shortLabel} unit={charts.imtpRel.def.unit} precision={2} height={180} />
        </div>
        <div className="grid3" style={{ marginTop: 14 }}>
          {charts.rfdSeries.map((r) => (
            <TrendChart key={r.key} points={r.points} label={r.def.shortLabel} unit={r.def.unit} precision={0} height={150} interpretation={r.def.interpretation} />
          ))}
        </div>
      </div>

      {/* asymmetry */}
      <div className="panel report-section">
        <h2>Asymmetry</h2>
        <p className="panel-sub">
          Asymmetry Index = |stronger − weaker| ÷ mean of both sides × 100 (method v1.0.0). Facility
          thresholds shown; colors follow the platform-wide left/right convention.
        </p>
        <AsymmetryChart
          points={charts.asym.points}
          watchPct={charts.asym.watchPct}
          flagPct={charts.asym.flagPct}
          sourceLabel={METRICS[charts.asym.sourceMetric].label}
        />
        {charts.asymImtp.points.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <AsymmetryChart
              points={charts.asymImtp.points}
              watchPct={charts.asymImtp.watchPct}
              flagPct={charts.asymImtp.flagPct}
              sourceLabel={METRICS[charts.asymImtp.sourceMetric].label}
              height={160}
            />
          </div>
        )}
      </div>

      {/* criteria status */}
      {protocol && stageRefs?.criteria && currentStage && (
        <div className="panel report-section">
          <h2>Criteria status — {protocol.name} · Stage {currentStage.stage_number}: {currentStage.name}</h2>
          <p className="panel-sub">
            Practitioner-defined targets with measured evidence. Status is shown per criterion — this report
            does not aggregate them into a readiness verdict.
          </p>
          <StageCriteria criteria={stageRefs.criteria} />
        </div>
      )}

      {/* clinical notes */}
      {assessments.length > 0 && (
        <div className="panel report-section">
          <h2>Practitioner-entered context</h2>
          {assessments.map((a) => (
            <div key={a.id} style={{ borderBottom: "1px solid var(--line)", padding: "8px 0", fontSize: 12.5 }}>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-mute)", marginRight: 10 }}>
                {a.assessed_on}
              </span>
              <strong>{a.category.replace(/_/g, " ")}</strong> ({a.assessor}): <span style={{ color: "var(--ink-dim)" }}>{a.summary}</span>
            </div>
          ))}
        </div>
      )}

      {/* per-session table */}
      <div className="panel report-section">
        <h2>Recent test sessions</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Date</th><th>Test</th>
              <th className="num">JH (cm)</th><th className="num">mRSI</th>
              <th className="num">IMTP peak (N)</th><th className="num">DJ RSI</th>
            </tr>
          </thead>
          <tbody>
            {sessions.slice().reverse().map((s) => (
              <tr key={s.id}>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{s.date}</td>
                <td>{TEST_TYPES[s.testType]?.label ?? s.testType}</td>
                <td className="num">{s.jumpHeight != null ? s.jumpHeight.toFixed(1) : "·"}</td>
                <td className="num">{s.mrsiVal != null ? s.mrsiVal.toFixed(2) : "·"}</td>
                <td className="num">{s.imtpPeak != null ? s.imtpPeak.toFixed(0) : "·"}</td>
                <td className="num">{s.djRsi != null ? s.djRsi.toFixed(2) : "·"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* methodology footer */}
      <div className="panel report-section">
        <h2>Methodology &amp; versions</h2>
        <p className="panel-sub">
          All values computed deterministically from captured signals or labeled imports; full definitions in
          the platform methodology document. Smoothing, where shown, is display-only.
        </p>
        <table className="data">
          <thead>
            <tr><th>Metric</th><th>Method version</th><th>Status</th></tr>
          </thead>
          <tbody>
            {report.methodVersions
              .filter((m) => ["cmj_jump_height", "cmj_mrsi", "cmj_ecc_braking_impulse", "imtp_peak_force", "imtp_relative_force", "imtp_rfd_0_50", "imtp_rfd_50_150", "imtp_rfd_150_250", "dj_rsi", "asymmetry_index"].includes(m.key))
              .map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{m.version}</td>
                  <td>{m.status === "implemented" ? "operational" : <span className="chip" data-tone="provisional">provisional</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="scope-note" style={{ marginTop: 14 }}>
          {report.scopeStatement}
        </div>
      </div>
    </main>
  );
}
