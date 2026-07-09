import { currentFacility } from "@/lib/facility";
import { listAthletes, getActiveProtocol } from "@/lib/db/dal";
import { athleteDetail, metricTrend, asymmetryTrend, baselineSeries } from "@/lib/services/queries";
import { METRICS } from "@/lib/config/metrics";
import TrendChart from "@/components/charts/TrendChart";
import AsymmetryChart from "@/components/charts/AsymmetryChart";

export const dynamic = "force-dynamic";

/**
 * Case Study — demo/private placeholder content only. Uses the seeded demo
 * athlete's synthetic data; no real athlete identity or clinical detail.
 */
export default async function StoryPage() {
  const facility = await currentFacility();
  const flagship = listAthletes(facility.id).find((a) => getActiveProtocol(facility.id, a.id));

  if (!flagship) {
    return (
      <main className="page" style={{ maxWidth: 860 }}>
        <div className="page-head">
          <div className="eyebrow">Case Study</div>
          <h1>A season in force–time</h1>
        </div>
        <div className="callout">
          The demo case study follows an athlete on an active staged protocol. This facility has none —
          switch to the Ridgeline facility to view it.
        </div>
      </main>
    );
  }

  const detail = athleteDetail(facility.id, flagship.id)!;
  const jump = metricTrend(facility.id, flagship.id, "cmj_jump_height");
  const mrsi = metricTrend(facility.id, flagship.id, "cmj_mrsi");
  const baseline = baselineSeries(facility.id, flagship.id, "cmj_jump_height");
  const asym = asymmetryTrend(facility.id, flagship.id, "cmj_ecc_braking_impulse");

  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div className="eyebrow">Case Study · demo placeholder content</div>
        <h1 style={{ fontSize: 36 }}>Ten months in force–time</h1>
        <div className="sub" style={{ maxWidth: 640 }}>
          How one athlete&apos;s measured data moved through a season, an injury, and a staged return — told
          entirely by the same schema, calculations, and findings that power the dashboard.
        </div>
      </div>

      <div className="callout" data-tone="error" style={{ marginBottom: 18 }}>
        <strong style={{ color: "var(--ink)" }}>This is placeholder demo content, not a real case study.</strong>{" "}
        “{flagship.display_name}” is an invented, anonymized demo identity with entirely synthetic
        force-plate signals — there is no real athlete, no real injury, and no real recovery behind this page.
        The schema, calculations, and Findings shown are the platform&apos;s real engine; the person, story, and
        clinical details are not. Any future real case study — including a real anchor-athlete recovery
        narrative — would only appear here after that athlete&apos;s own explicit written consent (a
        permission record with scope{" "}
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>demo_display</code>, as modeled here),
        with their own words, their own photos (never fabricated), and never presented as, or adjacent to, a
        clinical claim.
      </div>

      <div className="panel">
        <div className="eyebrow" style={{ color: "var(--stage)" }}>Chapter 1 · The baseline</div>
        <h2>Thirty-eight ordinary sessions</h2>
        <p style={{ color: "var(--ink-dim)", fontSize: 13.5, maxWidth: 680 }}>
          From September to January, {flagship.display_name.split(" ")[0]} tested twice a week on the plates.
          Nothing dramatic — which is the point. Those quiet sessions built a personal benchmark
          ({baseline.baselineMean?.toFixed(1)} cm mean jump height) and a normal band that later made
          “different” measurable. The purple markers are the practitioner-entered milestones that split the
          timeline.
        </p>
        <TrendChart
          points={jump.points}
          label="CMJ jump height"
          unit="cm"
          precision={1}
          band={baseline.points.map((p) => ({ date: p.date, low: p.bandLow, high: p.bandHigh }))}
          baselineMean={baseline.baselineMean}
          thresholdLines={jump.thresholds}
          milestones={detail.milestones}
          flaggedDates={baseline.points.filter((p) => p.flag !== "none").map((p) => p.date)}
          height={260}
        />
      </div>

      <div className="panel">
        <div className="eyebrow" style={{ color: "var(--stage)" }}>Chapter 2 · The gap</div>
        <h2>What the platform did NOT say</h2>
        <p style={{ color: "var(--ink-dim)", fontSize: 13.5, maxWidth: 680 }}>
          In January the record shows an injury milestone, then silence — eight weeks with no tests. The
          platform&apos;s only statement about that period is a data gap. No inference, no projection, no
          risk score: the injury details live with the clinical team, and the first post-surgery numbers
          appear only when the rehab lead cleared testing (a human decision, recorded as a clinical note).
        </p>
      </div>

      <div className="panel">
        <div className="eyebrow" style={{ color: "var(--stage)" }}>Chapter 3 · Strategy before output</div>
        <h2>The jump came back before the bounce did</h2>
        <p style={{ color: "var(--ink-dim)", fontSize: 13.5, maxWidth: 680 }}>
          Through the spring, jump height climbed back toward the benchmark. But mRSI — jump height divided
          by time to takeoff — recovered more slowly: the early jumps were deep, slow, force-reliant
          countermovements. Same height, different strategy. That distinction is why both numbers are on the
          dashboard.
        </p>
        <TrendChart
          points={mrsi.points}
          label="mRSI"
          unit="m/s"
          precision={2}
          thresholdLines={mrsi.thresholds}
          milestones={detail.milestones.filter((m) => m.kind !== "benchmark")}
          height={220}
          interpretation={METRICS.cmj_mrsi.interpretation}
        />
      </div>

      <div className="panel">
        <div className="eyebrow" style={{ color: "var(--stage)" }}>Chapter 4 · The number that lags</div>
        <h2>Braking asymmetry is the honest one</h2>
        <p style={{ color: "var(--ink-dim)", fontSize: 13.5, maxWidth: 680 }}>
          Output metrics forgive; braking doesn&apos;t. The eccentric braking impulse — the force absorbed
          while decelerating into the jump — still favors one side, and the athlete&apos;s own words in the
          practitioner notes (“hesitancy on sharp decelerations”) match the bars below. It remains the
          criterion holding Stage 3 open. The chart states it; the staff decide what to do about it.
        </p>
        <AsymmetryChart
          points={asym.points}
          watchPct={asym.watchPct}
          flagPct={asym.flagPct}
          sourceLabel="Eccentric braking impulse"
        />
      </div>

      <div className="scope-note">
        This story describes measured demo data and trends. It does not diagnose, predict injury, or clear an
        athlete to return to play — with real athletes those decisions remain with the qualified clinical and
        performance team.
      </div>
    </main>
  );
}
