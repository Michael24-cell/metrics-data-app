import { currentFacility } from "@/lib/facility";
import { rosterSummary, facilityFilterOptions, findingsWithAnnotations } from "@/lib/services/queries";
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

  const attention = findingsWithAnnotations(facility.id).filter(
    (f) => f.finding.severity !== "info"
  );
  const athleteName = new Map(options.athletes.map((a) => [a.id, a.name]));

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">{facility.name}</div>
        <h1>Roster &amp; Triage</h1>
        <div className="sub">
          Measured performance data and practitioner-defined criteria status. Nothing here diagnoses,
          predicts injury, or clears an athlete — those decisions stay with your clinical and performance team.
        </div>
      </div>

      <Suspense>
        <FilterBar options={{ teams: options.teams, athletes: options.athletes, show: ["team", "athlete"] }} />
      </Suspense>

      <div className="panel">
        <h2>Athletes</h2>
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
