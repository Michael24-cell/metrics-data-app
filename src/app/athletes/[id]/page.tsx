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
  imtpForceWindowSummary,
} from "@/lib/services/queries";
import { curveWorkspace } from "@/lib/services/curves";
import {
  TEST_TYPES,
  METRIC_GROUPS,
  BASELINE_MONITORED_METRICS,
  primaryMetricsForTest,
  advancedMetricsForTest,
  defaultMetricForTest,
  metricDef,
} from "@/lib/config/metrics";
import TrendChart from "@/components/charts/TrendChart";
import CurveWorkspace from "@/components/charts/CurveWorkspace";
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

  /* ---- test-first selection: the test determines everything below it ---- */
  const testsUsed = new Set(sessions.map((s) => s.test_type));
  const availableTests = Object.keys(TEST_TYPES).filter((k) => k !== "derived" && testsUsed.has(k));
  const selectedTest =
    sp.test && availableTests.includes(sp.test)
      ? sp.test
      : availableTests.includes("cmj")
        ? "cmj"
        : (availableTests[0] ?? null);

  const selectorEntries = selectedTest ? primaryMetricsForTest(selectedTest) : [];
  const configuredDefault = selectedTest ? defaultMetricForTest(selectedTest) : undefined;
  const defaultEntryKey =
    configuredDefault && selectorEntries.some((e) => e.key === configuredDefault)
      ? configuredDefault
      : selectorEntries[0]?.key;
  const selectedEntry =
    selectorEntries.find((e) => e.key === sp.metric) ??
    selectorEntries.find((e) => e.key === defaultEntryKey) ??
    null;

  /* ---- selected-metric data (single metric) ---- */
  const selDef = selectedEntry?.kind === "metric" ? metricDef(selectedEntry.key) : null;
  const trend = selDef ? metricTrend(facility.id, id, selDef.key, "bilateral", range) : null;
  const normDef = selDef?.normalizedKey ? metricDef(selDef.normalizedKey) : null;
  const normTrend = normDef ? metricTrend(facility.id, id, normDef.key, "bilateral", range) : null;
  const monitored = selDef ? BASELINE_MONITORED_METRICS.includes(selDef.key) : false;
  const baseline = selDef && monitored ? baselineSeries(facility.id, id, selDef.key, range) : null;
  const flaggedDates = baseline?.points.filter((p) => p.flag !== "none").map((p) => p.date) ?? [];
  const metricAsym =
    selDef?.asymmetryEligible ? asymmetryTrend(facility.id, id, selDef.key, range) : null;

  /* ---- selected-group data (IMTP Force 0–300 ms) ---- */
  const group = selectedEntry?.kind === "group" ? METRIC_GROUPS[selectedEntry.key] : null;
  const forceWindow = group ? imtpForceWindowSummary(facility.id, id, range) : null;
  const pointKey =
    group && sp.point && group.memberKeys.includes(sp.point) ? sp.point : group?.defaultMemberKey;
  const pointDef = pointKey ? metricDef(pointKey) : null;
  const pointTrend = pointDef ? metricTrend(facility.id, id, pointDef.key, "bilateral", range) : null;
  const pointRelDef = pointDef?.normalizedKey ? metricDef(pointDef.normalizedKey) : null;
  const pointRelTrend = pointRelDef ? metricTrend(facility.id, id, pointRelDef.key, "bilateral", range) : null;
  const pointAsym = pointDef ? asymmetryTrend(facility.id, id, pointDef.key, range) : null;

  /* ---- advanced metrics for this test (RFD etc), excluding grouped members ---- */
  const advanced = selectedTest
    ? advancedMetricsForTest(selectedTest).filter((m) => !m.group && m.trendEligible && m.status === "implemented")
    : [];
  const advancedTrends = advanced.map((d) => ({ def: d, trend: metricTrend(facility.id, id, d.key, "bilateral", range) }));

  /* ---- key numbers for the selected test (one per selector entry) ---- */
  const latestOf = (metricType: string) => {
    const t = metricTrend(facility.id, id, metricType, "bilateral", range);
    return t.points.length ? t.points[t.points.length - 1] : null;
  };
  const statTiles = selectorEntries.map((e) => {
    const key = e.kind === "group" ? METRIC_GROUPS[e.key].defaultMemberKey : e.key;
    const d = metricDef(key);
    return { entry: e, def: d, latest: latestOf(key), label: e.kind === "group" ? d.shortLabel : e.label };
  });

  /* ---- force-time curve workspace (CMJ/IMTP only) ---- */
  const curveData =
    selectedTest && TEST_TYPES[selectedTest].curveEligible
      ? curveWorkspace(facility.id, id, selectedTest as "cmj" | "imtp", [sp.c1, sp.c2, sp.c3], range)
      : null;

  const findings = findingsWithAnnotations(facility.id, id);
  const stageFinding = findings.find((f) => f.finding.category === "rts_stage_status");
  const stageRefs = stageFinding ? (JSON.parse(stageFinding.finding.refs_json) as FindingRefs) : null;

  const filteredSessions = sessions
    .filter((s) => !selectedTest || s.test_type === selectedTest)
    .filter((s) => (!sp.from || s.session_date >= sp.from) && (!sp.to || s.session_date <= sp.to));

  const trainingRecent = training.slice(-30);

  const href = (patch: Record<string, string | undefined>) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v != null && v !== "") next[k] = v;
    return `?${new URLSearchParams(next).toString()}`;
  };

  const fmt = (v: number | null, d: { precision: number; unit: string }) =>
    v == null ? "—" : v.toFixed(d.precision);

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
        <FilterBar options={{ athletes: options.athletes, show: ["athlete", "range"] }} />
      </Suspense>

      {availableTests.length === 0 && (
        <div className="callout">
          No test sessions recorded for this athlete yet. Analysis appears here once a testing session is imported.
        </div>
      )}

      {selectedTest && (
        <div className="panel" style={{ paddingBottom: 12 }}>
          <div className="chart-head" style={{ marginBottom: 6 }}>
            <h2 style={{ marginRight: "auto" }}>Analysis</h2>
            <div className="toggle no-print" aria-label="select test">
              {availableTests.map((t) => (
                <a key={t} href={href({ test: t, metric: undefined, point: undefined })}>
                  <button data-on={t === selectedTest}>{TEST_TYPES[t].label}</button>
                </a>
              ))}
            </div>
          </div>
          <p className="panel-sub" style={{ marginBottom: 8 }}>
            Pick the test first — the metrics, trends and side-to-side analysis below are the ones this test
            legitimately supports.
          </p>
          {selectorEntries.length > 0 ? (
            <div className="toggle no-print" aria-label="select metric" style={{ flexWrap: "wrap" }}>
              {selectorEntries.map((e) => (
                <a key={e.key} href={href({ metric: e.key, point: undefined })}>
                  <button data-on={selectedEntry?.key === e.key}>{e.label}</button>
                </a>
              ))}
            </div>
          ) : (
            <div className="callout">No trainer-facing metrics are registered for this test yet.</div>
          )}
        </div>
      )}

      {selectedTest && statTiles.length > 0 && (
        <div className="statrow" style={{ marginBottom: 16 }}>
          {statTiles.map(({ entry, def: d, latest, label }) => (
            <div className="stat" key={entry.key}>
              <div className="k">{label}</div>
              <div className="v">
                {latest ? latest.value.toFixed(d.precision) : "—"}
                {d.unit && <small>{d.unit}</small>}
              </div>
              <div className="d">{latest?.date ?? "no data"}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------- single-metric analysis ---------------- */}

      {selDef && (
        <div className="panel">
          <h2>Longitudinal trend — {selDef.label}</h2>
          <p className="panel-sub">
            Session-best values{monitored ? " with benchmark mean and rolling ±1 SD normal band" : ""}.
            {monitored ? " Red points mark sessions flagged by the deviation rule." : ""} Milestones from this
            athlete&apos;s record.
          </p>
          {trend && trend.points.length > 0 ? (
            <TrendChart
              points={trend.points}
              label={selDef.shortLabel}
              unit={selDef.unit}
              precision={selDef.precision}
              band={baseline?.points.map((p) => ({ date: p.date, low: p.bandLow, high: p.bandHigh }))}
              baselineMean={baseline?.baselineMean}
              thresholdLines={trend.thresholds}
              milestones={milestones}
              flaggedDates={flaggedDates}
              sessionLinkBase="/sessions"
              interpretation={selDef.interpretation}
              height={280}
            />
          ) : (
            <div className="callout">
              No {selDef.shortLabel} values in the selected date range. Widen the range or run a{" "}
              {TEST_TYPES[selectedTest!].label} session.
            </div>
          )}
          {baseline && !baseline.sufficientBaseline && trend && trend.points.length > 0 && (
            <div className="callout" style={{ marginTop: 10 }}>
              Baseline not yet established: {trend.points.length} of {baseline.config.minBenchmarkSessions} benchmark
              sessions. The normal band and deviation flags activate once the benchmark window is complete.
            </div>
          )}
        </div>
      )}

      {selDef && normDef && normTrend && normTrend.points.length > 0 && (
        <div className="panel">
          <h2>Body-mass normalized — {normDef.label}</h2>
          <p className="panel-sub">{normDef.description}</p>
          <TrendChart
            points={normTrend.points}
            label={normDef.shortLabel}
            unit={normDef.unit}
            precision={normDef.precision}
            thresholdLines={normTrend.thresholds}
            interpretation={normDef.interpretation}
            height={200}
          />
        </div>
      )}

      {selDef?.asymmetryEligible && metricAsym && (
        <div className="panel">
          <h2>Side-to-side — {selDef.shortLabel}</h2>
          <p className="panel-sub">
            {metricAsym.points.length > 0 ? (
              <>
                Latest asymmetry {metricAsym.points[metricAsym.points.length - 1].value.toFixed(1)}%
                {" · "}stronger side: {metricAsym.points[metricAsym.points.length - 1].strongerSide}
                {metricAsym.sideChanges != null && <>{" · "}stronger side changed {metricAsym.sideChanges}× in this range</>}
                {" · "}watch ≥{metricAsym.watchPct}% · flag ≥{metricAsym.flagPct}%
              </>
            ) : (
              "Side-to-side analysis needs dual-plate (left/right) data for this metric."
            )}
          </p>
          {metricAsym.points.length > 0 && (
            <AsymmetryChart
              points={metricAsym.points}
              watchPct={metricAsym.watchPct}
              flagPct={metricAsym.flagPct}
              sourceLabel={selDef.label}
            />
          )}
        </div>
      )}

      {/* ---------------- IMTP Force 0–300 ms group analysis ---------------- */}

      {group && forceWindow && (
        <div className="panel">
          <h2>Force 0–300 ms — early force production</h2>
          <p className="panel-sub">
            Absolute force at fixed instants after IMTP force onset, from persisted official metric values
            (not re-read from the display waveform).{" "}
            {forceWindow.latestDate
              ? `Latest session: ${forceWindow.latestDate}. Side values and asymmetry appear only where genuine left/right plate data exists.`
              : "No IMTP force-point data recorded in the selected range."}
          </p>
          {forceWindow.latestDate ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Time point</th>
                    <th className="num">Force (N)</th>
                    <th className="num">N/kg</th>
                    <th className="num">Left (N)</th>
                    <th className="num">Right (N)</th>
                    <th className="num">Asym %</th>
                    <th>Stronger side</th>
                    <th className="num">Side changes</th>
                  </tr>
                </thead>
                <tbody>
                  {forceWindow.rows.map((r) => (
                    <tr key={r.ms} style={r.metricKey === pointKey ? { background: "var(--panel-2, rgba(127,127,127,0.08))" } : undefined}>
                      <td>{r.ms} ms</td>
                      <td className="num">{fmt(r.absN, { precision: 0, unit: "N" })}</td>
                      <td className="num">{fmt(r.relNkg, { precision: 2, unit: "N/kg" })}</td>
                      <td className="num">{fmt(r.leftN, { precision: 0, unit: "N" })}</td>
                      <td className="num">{fmt(r.rightN, { precision: 0, unit: "N" })}</td>
                      <td className="num">{r.asymmetryPct == null ? "—" : r.asymmetryPct.toFixed(1)}</td>
                      <td>{r.strongerSide ?? "—"}</td>
                      <td className="num">{r.sideChanges == null ? "—" : r.sideChanges}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="callout">
              Force 0–300 ms values appear after an IMTP session with a detected force onset is imported.
            </div>
          )}
          {forceWindow.latestDate && (
            <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 8 }}>
              Side changes count how many times the stronger side flipped left↔right across the sessions in the
              selected range; “—” means fewer than two sessions with left/right data.
            </div>
          )}
        </div>
      )}

      {group && pointDef && pointTrend && (
        <div className="panel">
          <div className="chart-head" style={{ marginBottom: 2 }}>
            <h2 style={{ marginRight: "auto" }}>Trend — {pointDef.label}</h2>
            <div className="toggle no-print" aria-label="select time point">
              {forceWindow!.rows.map((r) => (
                <a key={r.ms} href={href({ point: r.metricKey })}>
                  <button data-on={r.metricKey === pointKey}>{r.ms}ms</button>
                </a>
              ))}
            </div>
          </div>
          <p className="panel-sub">{pointDef.description}</p>
          {pointTrend.points.length > 0 ? (
            <div className="grid2">
              <TrendChart
                points={pointTrend.points}
                label={pointDef.shortLabel}
                unit={pointDef.unit}
                precision={pointDef.precision}
                thresholdLines={pointTrend.thresholds}
                height={200}
              />
              {pointRelDef && pointRelTrend && pointRelTrend.points.length > 0 && (
                <TrendChart
                  points={pointRelTrend.points}
                  label={pointRelDef.shortLabel}
                  unit={pointRelDef.unit}
                  precision={pointRelDef.precision}
                  height={200}
                />
              )}
            </div>
          ) : (
            <div className="callout">No values for this time point in the selected range.</div>
          )}
        </div>
      )}

      {group && pointDef && pointAsym && pointAsym.points.length > 0 && (
        <div className="panel">
          <h2>Side-to-side — {pointDef.shortLabel}</h2>
          <p className="panel-sub">
            Latest asymmetry {pointAsym.points[pointAsym.points.length - 1].value.toFixed(1)}%
            {" · "}stronger side: {pointAsym.points[pointAsym.points.length - 1].strongerSide}
            {pointAsym.sideChanges != null && <>{" · "}stronger side changed {pointAsym.sideChanges}× in this range</>}
            {" · "}watch ≥{pointAsym.watchPct}% · flag ≥{pointAsym.flagPct}%
          </p>
          <AsymmetryChart
            points={pointAsym.points}
            watchPct={pointAsym.watchPct}
            flagPct={pointAsym.flagPct}
            sourceLabel={pointDef.label}
          />
        </div>
      )}

      {/* ---------------- force-time curve workspace ---------------- */}

      {curveData && (
        <div className="panel">
          <h2>Force–time curves — {TEST_TYPES[selectedTest!].label}</h2>
          <p className="panel-sub">
            Individual attempts and rolling / all-time averages of valid attempts, overlaid on a shared
            onset-aligned time axis (up to three at once).
          </p>
          <Suspense>
            <CurveWorkspace {...curveData} />
          </Suspense>
        </div>
      )}

      {/* ---------------- findings + protocol context ---------------- */}

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

      {advancedTrends.length > 0 && (
        <details className="panel">
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Advanced metrics — {TEST_TYPES[selectedTest!].label} ({advancedTrends.length})
          </summary>
          <p className="panel-sub" style={{ marginTop: 8 }}>
            Specialist measures kept out of the main selector. Windowed rate-of-force-development values carry
            different training meanings — shown with each chart.
          </p>
          <div className="grid3">
            {advancedTrends.map(({ def: d, trend: t }) => (
              <div key={d.key}>
                {t.points.length > 0 ? (
                  <TrendChart
                    points={t.points}
                    label={d.shortLabel}
                    unit={d.unit}
                    precision={d.precision}
                    thresholdLines={t.thresholds}
                    height={170}
                    interpretation={d.interpretation}
                  />
                ) : (
                  <div className="callout">{d.shortLabel}: no data in range.</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

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
        <p className="panel-sub">
          {filteredSessions.length} sessions{selectedTest ? ` · ${TEST_TYPES[selectedTest]?.label}` : ""}. Open a
          session for the trial-level drill-down.
        </p>
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
