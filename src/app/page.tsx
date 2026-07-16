import { currentFacility } from "@/lib/facility";
import { rosterSummary, facilityFilterOptions, findingsWithAnnotations } from "@/lib/services/queries";
import { teamAnalytics, teamTestTypes } from "@/lib/services/teamAnalytics";
import {
  TEST_TYPES,
  METRIC_GROUPS,
  METRICS,
  primaryMetricsForTest,
  defaultMetricForTest,
} from "@/lib/config/metrics";
import { SMALL_SAMPLE_N } from "@/lib/calc/cohort";
import Sparkline from "@/components/charts/Sparkline";
import FilterBar from "@/components/FilterBar";
import FindingCard from "@/components/FindingCard";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function RosterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const facility = await currentFacility();
  const options = facilityFilterOptions(facility.id);
  let roster = rosterSummary(facility.id, sp.team);

  // severity triage order: flag > watch > info > clear, then most recent test first
  const rank = { flag: 0, watch: 1, info: 2 } as const;
  roster = roster.sort((a, b) => {
    const ra = a.topSeverity ? rank[a.topSeverity] : 3;
    const rb = b.topSeverity ? rank[b.topSeverity] : 3;
    if (ra !== rb) return ra - rb;
    return (b.lastTestDate ?? "").localeCompare(a.lastTestDate ?? "");
  });

  /* ---- test-first team analytics ---- */
  // Default team: the largest squad at the facility (cohort comparisons need a real group).
  const teamSizes = new Map<string, number>();
  for (const a of roster) if (a.team) teamSizes.set(a.team, (teamSizes.get(a.team) ?? 0) + 1);
  const defaultTeam = [...teamSizes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const team = sp.team && options.teams.includes(sp.team) ? sp.team : defaultTeam;

  const range = { from: sp.from, to: sp.to };
  const testsUsed = team ? teamTestTypes(facility.id, team) : [];
  const availableTests = Object.keys(TEST_TYPES).filter((k) => k !== "derived" && testsUsed.includes(k));
  const selectedTest =
    sp.test && availableTests.includes(sp.test)
      ? sp.test
      : availableTests.includes("cmj")
        ? "cmj"
        : (availableTests[0] ?? null);

  // Only cohort-comparable primary entries are offered for team comparison.
  const selectorEntries = selectedTest
    ? primaryMetricsForTest(selectedTest).filter((e) =>
        e.kind === "group"
          ? METRIC_GROUPS[e.key].memberKeys.some((k) => METRICS[k].cohortComparable)
          : METRICS[e.key].cohortComparable
      )
    : [];
  const configuredDefault = selectedTest ? defaultMetricForTest(selectedTest) : undefined;
  const selectedEntry =
    selectorEntries.find((e) => e.key === sp.metric) ??
    selectorEntries.find((e) => e.key === configuredDefault) ??
    selectorEntries[0] ??
    null;
  const group = selectedEntry?.kind === "group" ? METRIC_GROUPS[selectedEntry.key] : null;
  const pointKey = group
    ? group.memberKeys.includes(sp.point ?? "")
      ? sp.point!
      : group.defaultMemberKey
    : null;
  const effectiveMetric = group ? pointKey! : (selectedEntry?.key ?? null);

  const analytics = team && effectiveMetric ? teamAnalytics(facility.id, team, effectiveMetric, range) : null;

  const attention = findingsWithAnnotations(facility.id).filter(
    (f) => f.finding.severity !== "info"
  );
  const athleteName = new Map(options.athletes.map((a) => [a.id, a.name]));

  const href = (patch: Record<string, string | undefined>) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v != null && v !== "") next[k] = v;
    return `?${new URLSearchParams(next).toString()}`;
  };

  const num = (v: number | null, precision: number, signed = false) =>
    v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(precision)}`;

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">{facility.name}</div>
        <h1>Roster &amp; Team Analytics</h1>
        <div className="sub">
          Measured performance data and practitioner-defined criteria status. Nothing here diagnoses,
          predicts injury, or clears an athlete — those decisions stay with your clinical and performance team.
        </div>
      </div>

      <Suspense>
        <FilterBar options={{ teams: options.teams, athletes: options.athletes, show: ["team", "athlete", "range"] }} />
      </Suspense>

      {analytics && team && selectedTest && (
        <div className="panel">
          <div className="chart-head" style={{ marginBottom: 6 }}>
            <h2 style={{ marginRight: "auto" }}>Team analytics — {team}</h2>
            <div className="toggle no-print" aria-label="select test">
              {availableTests.map((t) => (
                <a key={t} href={href({ test: t, metric: undefined, point: undefined })}>
                  <button data-on={t === selectedTest}>{TEST_TYPES[t].label}</button>
                </a>
              ))}
            </div>
          </div>
          <p className="panel-sub" style={{ marginBottom: 8 }}>
            Test first, then metric, then time window. Every value below — team summary, athlete values,
            trends, diffs and z-scores — follows the selected metric. Comparison baseline is the whole team;
            position groups are shown alongside. Athlete-vs-own-baseline comparison lives on the athlete
            profile, not here.
          </p>
          <div className="toggle no-print" aria-label="select metric" style={{ flexWrap: "wrap", marginBottom: 8 }}>
            {selectorEntries.map((e) => (
              <a key={e.key} href={href({ metric: e.key, point: undefined })}>
                <button data-on={selectedEntry?.key === e.key}>{e.label}</button>
              </a>
            ))}
          </div>
          {group && (
            <div className="toggle no-print" aria-label="select time point" style={{ marginBottom: 8 }}>
              {group.memberKeys.map((k) => (
                <a key={k} href={href({ point: k })}>
                  <button data-on={k === pointKey}>{k.match(/(\d+)ms/)?.[1]}ms</button>
                </a>
              ))}
            </div>
          )}

          {/* ---- cohort summary above the athlete list ---- */}
          <div className="statrow" style={{ marginBottom: 12 }}>
            <div className="stat">
              <div className="k">Team mean — {analytics.def.shortLabel}</div>
              <div className="v">
                {num(analytics.team.mean, analytics.def.precision)}
                {analytics.def.unit && <small>{analytics.def.unit}</small>}
              </div>
              <div className="d">latest session-best per athlete in window</div>
            </div>
            <div className="stat">
              <div className="k">Median</div>
              <div className="v">
                {num(analytics.team.median, analytics.def.precision)}
                {analytics.def.unit && <small>{analytics.def.unit}</small>}
              </div>
              <div className="d">
                range {num(analytics.team.min, analytics.def.precision)}–{num(analytics.team.max, analytics.def.precision)}
              </div>
            </div>
            <div className="stat">
              <div className="k">Spread (population SD)</div>
              <div className="v">
                {num(analytics.team.populationSd, analytics.def.precision)}
                {analytics.def.unit && <small>{analytics.def.unit}</small>}
              </div>
              <div className="d">athlete included in own cohort</div>
            </div>
            <div className="stat">
              <div className="k">Cohort size</div>
              <div className="v">{analytics.team.n}</div>
              <div className="d">
                {analytics.excludedCount > 0 ? `${analytics.excludedCount} without data in window` : "all athletes have data"}
                {analytics.team.smallSample && analytics.team.n > 0 ? ` · small sample (n<${SMALL_SAMPLE_N})` : ""}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {analytics.positions.map(({ position, stats }) => (
              <span key={position} className="chip">
                {position}: {num(stats.mean, analytics.def.precision)} {analytics.def.unit} · n={stats.n}
              </span>
            ))}
          </div>

          {/* ---- desktop/tablet: dense table, Peak/Average/Most recent left of Trend ---- */}
          <div className="ta-table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th className="num">Peak</th>
                  <th className="num">Average</th>
                  <th className="num">Most recent</th>
                  <th>Trend</th>
                  <th className="num" style={{ borderLeft: "1px solid var(--line-strong)", color: "var(--ink-mute)" }}>Recent Δ</th>
                  <th className="num" style={{ color: "var(--ink-mute)" }}>Δ team</th>
                  <th className="num" style={{ color: "var(--ink-mute)" }}>z team</th>
                  <th className="num" style={{ color: "var(--ink-mute)" }}>Δ position</th>
                  <th className="num" style={{ color: "var(--ink-mute)" }}>z position</th>
                </tr>
              </thead>
              <tbody>
                {analytics.rows.map((r) => (
                  <tr key={r.athleteId}>
                    <td>
                      <a href={`/athletes/${r.athleteId}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name}</a>
                      <div style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>
                        {r.position ?? "—"}{r.mostRecentDate ? ` · ${r.mostRecentDate}` : ""}
                      </div>
                    </td>
                    {r.mostRecent == null ? (
                      <td colSpan={9} style={{ color: "var(--ink-mute)", fontSize: 12.5 }}>
                        No {analytics.def.shortLabel} data in the selected window — excluded from cohort statistics.
                      </td>
                    ) : (
                      <>
                        <td className="num">{num(r.peak, analytics.def.precision)}</td>
                        <td className="num">{num(r.average, analytics.def.precision)}</td>
                        <td className="num">
                          {r.mostRecent.toFixed(analytics.def.precision)}
                          {analytics.normalizedDef && (
                            <div style={{ fontSize: 11, color: "var(--ink-mute)", fontWeight: 400 }}>
                              {r.normalized == null ? "—" : r.normalized.toFixed(analytics.normalizedDef.precision)} {analytics.normalizedDef.unit}
                            </div>
                          )}
                        </td>
                        <td>{r.trend.length >= 2 ? <Sparkline values={r.trend.map((p) => p.value)} /> : <span style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>{r.trend.length} session{r.trend.length === 1 ? "" : "s"}</span>}</td>
                        <td className="num" style={{ borderLeft: "1px solid var(--line-strong)", color: "var(--ink-dim)" }}>{num(r.recentDelta, analytics.def.precision, true)}</td>
                        <td className="num" style={{ color: "var(--ink-dim)" }}>{num(r.teamDiff, analytics.def.precision, true)}</td>
                        <td className="num" style={{ color: "var(--ink-dim)" }} title={r.teamZ == null ? "z-score unavailable: cohort has n<2 or zero variance" : undefined}>
                          {num(r.teamZ, 2, true)}
                        </td>
                        <td className="num" style={{ color: "var(--ink-dim)" }}>{num(r.positionDiff, analytics.def.precision, true)}</td>
                        <td className="num" style={{ color: "var(--ink-dim)" }} title={r.positionZ == null ? "z-score unavailable: position cohort has n<2 or zero variance" : undefined}>
                          {num(r.positionZ, 2, true)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- narrow screens: one card per athlete, comparisons deprioritized below ---- */}
          <div className="ta-cards">
            {analytics.rows.map((r) => (
              <div className="ta-card" key={r.athleteId}>
                <div className="ta-card-head">
                  <div>
                    <a href={`/athletes/${r.athleteId}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name}</a>
                    <div style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>
                      {r.position ?? "—"}{r.mostRecentDate ? ` · ${r.mostRecentDate}` : ""}
                    </div>
                  </div>
                </div>
                {r.mostRecent == null ? (
                  <div style={{ color: "var(--ink-mute)", fontSize: 12.5 }}>
                    No {analytics.def.shortLabel} data in the selected window — excluded from cohort statistics.
                  </div>
                ) : (
                  <>
                    <div className="statrow">
                      <div className="stat">
                        <div className="k">Peak</div>
                        <div className="v">{num(r.peak, analytics.def.precision)}<small>{analytics.def.unit}</small></div>
                      </div>
                      <div className="stat">
                        <div className="k">Average</div>
                        <div className="v">{num(r.average, analytics.def.precision)}<small>{analytics.def.unit}</small></div>
                      </div>
                      <div className="stat">
                        <div className="k">Most recent</div>
                        <div className="v">{r.mostRecent.toFixed(analytics.def.precision)}<small>{analytics.def.unit}</small></div>
                        {analytics.normalizedDef && (
                          <div className="d">{r.normalized == null ? "—" : r.normalized.toFixed(analytics.normalizedDef.precision)} {analytics.normalizedDef.unit}</div>
                        )}
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      {r.trend.length >= 2 ? <Sparkline values={r.trend.map((p) => p.value)} /> : <span style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>{r.trend.length} session{r.trend.length === 1 ? "" : "s"}</span>}
                    </div>
                    <div className="ta-card-compare">
                      <span>Recent Δ {num(r.recentDelta, analytics.def.precision, true)}</span>
                      <span>Δ team {num(r.teamDiff, analytics.def.precision, true)}</span>
                      <span title={r.teamZ == null ? "z-score unavailable: cohort has n<2 or zero variance" : undefined}>z team {num(r.teamZ, 2, true)}</span>
                      <span>Δ position {num(r.positionDiff, analytics.def.precision, true)}</span>
                      <span title={r.positionZ == null ? "z-score unavailable: position cohort has n<2 or zero variance" : undefined}>z position {num(r.positionZ, 2, true)}</span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 8 }}>
            Peak, average and most recent all reflect valid {analytics.def.shortLabel} values within the selected
            window. z = (value − cohort mean) ÷ population SD, athlete included in the cohort. “—” means the
            cohort can&apos;t support a z-score (fewer than 2 athletes, or zero variance); raw values and
            differences are still shown.
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Athletes — attention triage</h2>
        <p className="panel-sub">
          Ordered by attention level, then testing recency. Sparkline: CMJ jump height, last 24 sessions.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Athlete</th>
              <th>Team / Sport</th>
              <th>Status</th>
              <th>Jump height trend</th>
              <th className="num">Latest JH</th>
              <th>Last test</th>
              <th>Attention</th>
              <th>Latest signal</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((a) => (
              <tr key={a.id}>
                <td>
                  <a href={`/athletes/${a.id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>
                    {a.name}
                  </a>
                  <div style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>{a.position}</div>
                </td>
                <td style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>
                  {a.team}
                  <div style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>{a.sport}</div>
                </td>
                <td>
                  {a.stageLabel ? (
                    <span className="chip" data-tone="stage">{a.stageLabel}</span>
                  ) : (
                    <span className="chip">{a.status === "active" ? "monitoring" : a.status}</span>
                  )}
                </td>
                <td><Sparkline values={a.jumpSpark.map((p) => p.value)} /></td>
                <td className="num">
                  {a.latestJumpHeight != null ? `${a.latestJumpHeight.toFixed(1)} cm` : "—"}
                </td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{a.lastTestDate ?? "—"}</td>
                <td>
                  {a.topSeverity ? (
                    <span className="sev" data-sev={a.topSeverity}>
                      {a.findingCounts.flag > 0 && `${a.findingCounts.flag} flag`}
                      {a.findingCounts.flag > 0 && a.findingCounts.watch > 0 && " · "}
                      {a.findingCounts.watch > 0 && `${a.findingCounts.watch} watch`}
                      {a.findingCounts.flag === 0 && a.findingCounts.watch === 0 && "info only"}
                    </span>
                  ) : (
                    <span className="sev" data-sev="ok">clear</span>
                  )}
                </td>
                <td style={{ fontSize: 12, color: "var(--ink-dim)", maxWidth: 260 }}>
                  {a.latestHeadline ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>What changed — active watch &amp; flag findings</h2>
        <p className="panel-sub">
          Deterministic findings generated from computed metrics. Training context annotates but never
          suppresses a finding.
        </p>
        {attention.length === 0 && <div className="callout" data-tone="ok">No watch or flag findings for this facility.</div>}
        {attention.map(({ finding, annotations }) => (
          <div key={finding.id}>
            <div style={{ fontSize: 11.5, color: "var(--ink-mute)", margin: "10px 0 3px", fontFamily: "var(--font-mono)" }}>
              <a href={`/athletes/${finding.athlete_id}`} style={{ color: "var(--accent)" }}>
                {athleteName.get(finding.athlete_id) ?? "athlete"} →
              </a>
            </div>
            <FindingCard finding={finding} annotations={annotations} />
          </div>
        ))}
      </div>
    </main>
  );
}
