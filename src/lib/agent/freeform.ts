/**
 * Scripted freeform composers — one deterministic answer builder per routed
 * intent. Same honesty contract as scripted.ts: real tools over the current
 * local data, claims composed by code, every number in claim text present in
 * that claim's evidence values. Used as the keyless default AND as the
 * live-mode fallback for free-text questions.
 */

import { buildClaim } from "./claims";
import { RoutedIntent } from "./intent";
import { AnswerContext, Claim, EvidenceRef, KeyValue } from "./schemas";
import { ToolExecutor, ToolOutcome } from "./tools";
import { METRICS, TEST_TYPES, ASYMMETRY_SOURCE_METRICS, BASELINE_MONITORED_METRICS } from "../config/metrics";
import { recentVsNormal } from "../calc/recentVsNormal";

export interface FreeformResult {
  summary: string;
  claims: Claim[];
  directAnswer: string;
  keyValues: KeyValue[];
  comparisonBasis?: string;
  limitations: string[];
  suggestedNext: string[];
  followUps: string[];
  contextUsed: AnswerContext;
}

type Run = (name: string, input?: Record<string, unknown>) => Promise<ToolOutcome>;

const DEFER = "Evidence for coach review — this system explains evidence; it does not make the final call.";
const r1 = (v: number) => Math.round(v * 10) / 10;
const rp = (v: number, p: number) => Number(v.toFixed(p));

/** anchor evidence for refusals / empty states — always resolvable */
async function qualityAnchor(run: Run): Promise<EvidenceRef> {
  const completeness = await run("getDataCompleteness");
  return completeness.evidence[0] ?? { id: "quality:unknown:latest", type: "quality", label: "Data completeness snapshot" };
}

function insufficientResult(
  run: Run,
  routed: RoutedIntent,
  what: string,
  why: string,
  followUps: string[]
): Promise<FreeformResult> {
  return qualityAnchor(run).then((anchor) => ({
    summary: `${what} ${why} ${DEFER}`,
    claims: [
      buildClaim({
        text: `${what} ${why}`,
        claimType: "data_gap",
        metricKey: routed.metricKey,
        evidenceRefs: [anchor],
        confidence: "high",
      }),
    ],
    directAnswer: what,
    keyValues: [],
    limitations: [why],
    suggestedNext: ["Import or record the missing test sessions before re-asking."],
    followUps,
    contextUsed: { testType: routed.testType, metricKey: routed.metricKey },
  }));
}

/* ------------------------------------------------------------------ */

export async function scriptedFreeform(executor: ToolExecutor, routed: RoutedIntent): Promise<FreeformResult> {
  const run: Run = (name, input) => executor.run(name, input ?? {});

  /* honest refusal — no analytics tools are consulted for scope */
  if (routed.kind === "unsupported") {
    const anchor = await qualityAnchor(run);
    const reason = routed.unsupported!.reason;
    const nearest = routed.unsupported!.nearest;
    return {
      summary: `This question can't be answered by this system. ${reason}${nearest ? ` A nearby supported question: “${nearest}”.` : ""}`,
      claims: [
        buildClaim({
          text: `Question declined: ${reason}`,
          claimType: "context",
          comparisonWindow: "scope-refusal",
          evidenceRefs: [anchor],
          confidence: "high",
        }),
      ],
      directAnswer: `Not something this system can answer: ${reason}`,
      keyValues: [],
      limitations: [reason],
      suggestedNext: nearest ? [`Try: “${nearest}”`] : [],
      followUps: nearest ? [nearest] : [],
      contextUsed: {},
    };
  }

  switch (routed.kind) {
    /* ---------------- current status / test summary ---------------- */
    case "current_status": {
      const testType = routed.testType ?? "cmj";
      const res = await run("getTestSummary", { testType });
      if (res.insufficient) {
        return insufficientResult(run, routed, `No ${TEST_TYPES[testType]?.label ?? testType} data is recorded for this athlete.`, "A summary needs at least one imported session of this test.", ["What information is missing?"]);
      }
      const d = res.data as { metrics: { metricKey: string; label: string; unit: string; peak: number | null; average: number | null; mostRecent: number | null; mostRecentDate: string | null; sessions: number }[] };
      const withData = d.metrics.filter((m) => m.mostRecent != null);
      const evByKey = new Map(res.evidence.map((e) => [e.id.split(":")[1], e]));
      const claims: Claim[] = withData.slice(0, 4).map((m) =>
        buildClaim({
          text: `${m.label}: most recent ${m.mostRecent} ${m.unit} (${m.mostRecentDate}); window peak ${m.peak} and average ${m.average} ${m.unit} over ${m.sessions} sessions.`,
          claimType: "context",
          metricKey: m.metricKey,
          comparisonWindow: "window-summary",
          evidenceRefs: [evByKey.get(m.metricKey)!].filter(Boolean),
          confidence: "high",
        })
      );
      const top = withData[0];
      return {
        summary: `${TEST_TYPES[testType]?.label ?? testType}: ${withData.length} metrics with data; latest session ${top?.mostRecentDate ?? "—"}. ${DEFER}`,
        claims,
        directAnswer: top
          ? `Latest ${TEST_TYPES[testType]?.label ?? testType} numbers (${top.mostRecentDate}): ${withData.slice(0, 3).map((m) => `${m.label} ${m.mostRecent} ${m.unit}`).join(", ")}.`
          : "Data exists but no metric has a current value.",
        keyValues: withData.slice(0, 4).map((m) => ({ label: m.label, value: String(m.mostRecent), unit: m.unit })),
        comparisonBasis: "Session-best values across the athlete's recorded history (peak / average / most recent).",
        limitations: [],
        suggestedNext: ["Open the athlete's test-first analysis for the full trends."],
        followUps: ["What changed over time?", "How does this athlete compare with the team?", "Which side is stronger?"],
        contextUsed: { testType },
      };
    }

    /* ---------------- change over time ---------------- */
    case "change_over_time":
    case "baseline_comparison": {
      const metricKey =
        routed.metricKey ?? (routed.testType ? TEST_TYPES[routed.testType]?.defaultMetric : undefined) ?? "cmj_jump_height";
      const def = METRICS[metricKey];
      if (routed.kind === "baseline_comparison" && !BASELINE_MONITORED_METRICS.includes(metricKey)) {
        return insufficientResult(run, { ...routed, metricKey }, `Baseline monitoring is configured for ${BASELINE_MONITORED_METRICS.map((k) => METRICS[k].shortLabel).join(" and ")} only — not ${def.shortLabel}.`, "Other metrics can still be examined as trends.", [`What changed in ${def.shortLabel}?`]);
      }
      const toolName = routed.kind === "baseline_comparison" ? "getBaselineComparison" : "getMetricSeries";
      const res = await run(toolName, { metricType: metricKey, ...(toolName === "getMetricSeries" ? { lastN: 10 } : {}) });
      if (res.insufficient || !res.data) {
        return insufficientResult(run, { ...routed, metricKey }, `No reliable ${def.shortLabel} statement is possible.`, `Reason: ${res.insufficient ?? "no data"}.`, ["What information is missing?"]);
      }
      if (routed.kind === "baseline_comparison") {
        const d = res.data as { latest: { date: string; value: number }; referenceBaseline: { mean: number }; recentBaseline: { bandLow?: number; bandHigh?: number }; pctOfReference: number; bandStatus: string };
        const claim = buildClaim({
          text: `${def.shortLabel} is ${d.latest.value} ${def.unit} (${d.latest.date}) = ${d.pctOfReference}% of the reference baseline (benchmark mean ${d.referenceBaseline.mean} ${def.unit}), and ${d.bandStatus} (recent rolling band ${d.recentBaseline.bandLow}–${d.recentBaseline.bandHigh} ${def.unit}).`,
          claimType: "baseline_comparison",
          metricKey,
          comparisonWindow: "latest-vs-reference-and-recent",
          evidenceRefs: res.evidence,
          confidence: "high",
        });
        return {
          summary: `${claim.text} ${DEFER}`,
          claims: [claim],
          directAnswer: `${def.shortLabel} sits at ${d.pctOfReference}% of the reference baseline and is ${d.bandStatus}.`,
          keyValues: [
            { label: "Latest", value: String(d.latest.value), unit: def.unit },
            { label: "% of reference baseline", value: String(d.pctOfReference), unit: "%" },
            { label: "Recent band", value: `${d.recentBaseline.bandLow}–${d.recentBaseline.bandHigh}`, unit: def.unit },
          ],
          comparisonBasis: "Reference baseline (fixed benchmark window) AND recent baseline (rolling band) — two distinct references.",
          limitations: [],
          suggestedNext: ["Review the flagged sessions on the athlete's trend chart."],
          followUps: [`How does ${def.shortLabel} compare with the team?`, "What changed over time?"],
          contextUsed: { metricKey, testType: def.testType },
        };
      }
      const d = res.data as { points: { date: string; value: number }[]; pctChange: number; unit: string; comparability: { comparable: boolean; reasons: string[] } };
      const first = d.points[0];
      const last = d.points[d.points.length - 1];
      const claim = buildClaim({
        text: `${def.shortLabel} moved from ${first.value} to ${last.value} ${def.unit} (${d.pctChange > 0 ? "+" : ""}${d.pctChange}%) across ${d.points.length} comparable sessions (${first.date} → ${last.date}).`,
        claimType: "trend",
        metricKey,
        comparisonWindow: `${first.date}..${last.date}`,
        evidenceRefs: res.evidence,
        confidence: "high",
      });
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: `${def.shortLabel} changed ${d.pctChange > 0 ? "+" : ""}${d.pctChange}% across the last ${d.points.length} comparable sessions.`,
        keyValues: [
          { label: "First in window", value: String(first.value), unit: def.unit },
          { label: "Most recent", value: String(last.value), unit: def.unit },
          { label: "Change", value: `${d.pctChange > 0 ? "+" : ""}${d.pctChange}`, unit: "%" },
        ],
        comparisonBasis: `Session-best values, ${first.date} → ${last.date}, comparability-gated (one test type, one method version).`,
        limitations: [],
        suggestedNext: ["Open the trend chart to see the shape of the change."],
        followUps: [`How does ${def.shortLabel} compare with the team?`, "What about the normalized value?"],
        contextUsed: { metricKey, testType: def.testType, window: `${first.date}..${last.date}` },
      };
    }

    /* ---------------- team / position comparison ---------------- */
    case "team_comparison":
    case "position_comparison": {
      const metricKey = routed.metricKey!;
      const def = METRICS[metricKey];
      const res = await run("getTeamComparison", { metricType: metricKey });
      if (res.insufficient || !res.data || !(res.data as { athlete: unknown }).athlete) {
        return insufficientResult(run, routed, `No cohort comparison is possible for ${def.shortLabel}.`, `Reason: ${res.insufficient ?? "no cohort data"}.`, ["What information is missing?"]);
      }
      const d = res.data as {
        team: string;
        teamStats: { mean: number | null; median: number | null; populationSd: number | null; n: number };
        positionStats: { position: string; mean: number | null; n: number; populationSd: number | null } | null;
        athlete: { mostRecent: number; mostRecentDate: string | null; teamDiff: number | null; teamZ: number | null; positionDiff: number | null; positionZ: number | null };
        furthestFromTeamMean: { name: string; value: number; diff: number }[];
        excludedCount: number;
      };
      const usePosition = routed.kind === "position_comparison" && d.positionStats;
      const cohortLabel = usePosition ? `${d.positionStats!.position} group (n=${d.positionStats!.n})` : `${d.team} (n=${d.teamStats.n})`;
      const diff = usePosition ? d.athlete.positionDiff : d.athlete.teamDiff;
      const z = usePosition ? d.athlete.positionZ : d.athlete.teamZ;
      const cohortMean = usePosition ? rp(d.positionStats!.mean!, def.precision) : rp(d.teamStats.mean!, def.precision);
      const claim = buildClaim({
        text: `${def.shortLabel}: athlete most recent ${d.athlete.mostRecent} ${def.unit} vs ${cohortLabel} mean ${cohortMean} ${def.unit} — difference ${diff != null && diff > 0 ? "+" : ""}${diff} ${def.unit}${z != null ? `, z-score ${z > 0 ? "+" : ""}${z}` : " (no z-score: cohort has fewer than 2 athletes or zero variance)"} under the cohort contract (population SD, athlete included in own cohort).`,
        claimType: "cohort_comparison",
        metricKey,
        comparisonWindow: usePosition ? "vs-position-cohort" : "vs-team-cohort",
        evidenceRefs: res.evidence,
        confidence: "high",
      });
      const limitations: string[] = [];
      if (z == null) limitations.push("No z-score for this cohort (fewer than 2 athletes with data, or zero variance) — the raw difference is still valid.");
      if (d.excludedCount > 0) limitations.push(`${d.excludedCount} athlete(s) have no ${def.shortLabel} value in the window and are excluded from the cohort statistics.`);
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: `${diff != null && diff >= 0 ? "Above" : "Below"} the ${usePosition ? d.positionStats!.position + " group" : "team"} mean by ${Math.abs(diff ?? 0)} ${def.unit}${z != null ? ` (z ${z > 0 ? "+" : ""}${z})` : ""}.`,
        keyValues: [
          { label: "Athlete (most recent)", value: String(d.athlete.mostRecent), unit: def.unit },
          { label: `${usePosition ? d.positionStats!.position : "Team"} mean`, value: String(cohortMean), unit: def.unit },
          { label: "Difference", value: `${diff != null && diff > 0 ? "+" : ""}${diff}`, unit: def.unit },
          { label: "z-score", value: z != null ? `${z > 0 ? "+" : ""}${z}` : "—" },
        ],
        comparisonBasis: `Most recent session-best per athlete; ${cohortLabel}; population SD with the athlete included; no z when n<2 or variance is zero.`,
        limitations,
        suggestedNext: ["Open the roster team-analytics view for every athlete's standing."],
        followUps: usePosition
          ? [`How does this athlete compare with the whole team?`, "Which athletes are furthest from the team average?"]
          : [`How do they compare with other ${d.positionStats?.position.toLowerCase() ?? "position"}s?`, "What about the normalized value?"],
        contextUsed: { metricKey, testType: def.testType, cohort: usePosition ? "position" : "team" },
      };
    }

    /* ---------------- asymmetry ---------------- */
    case "asymmetry": {
      const source =
        routed.metricKey && (ASYMMETRY_SOURCE_METRICS as string[]).includes(routed.metricKey)
          ? routed.metricKey
          : routed.testType === "imtp"
            ? "imtp_peak_force"
            : ASYMMETRY_SOURCE_METRICS[0];
      const def = METRICS[source];
      const res = await run("getAsymmetryHistory", { sourceMetric: source });
      if (res.insufficient || !res.data) {
        return insufficientResult(run, { ...routed, metricKey: source }, "Side-to-side analysis is not possible for this metric.", "It needs genuine left/right (dual-plate) data — none exists in the window.", ["What information is missing?"]);
      }
      const d = res.data as { latest: { date: string; value: number; strongerSide: string }; recentMean: number; directionChanges: number; watchPct: number; flagPct: number };
      const claim = buildClaim({
        text: `${def.shortLabel} asymmetry is ${d.latest.value}% with the ${d.latest.strongerSide} side stronger (${d.latest.date}); recent mean ${d.recentMean}%. The stronger side changed ${d.directionChanges} time(s) in the window. Facility watch level ${d.watchPct}%, flag level ${d.flagPct}%.`,
        claimType: "asymmetry",
        metricKey: source,
        comparisonWindow: "recent-window",
        evidenceRefs: res.evidence,
        confidence: "high",
      });
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: `The ${d.latest.strongerSide} side is currently stronger on ${def.shortLabel} (asymmetry ${d.latest.value}%)${d.directionChanges > 0 ? `; the stronger side has flipped ${d.directionChanges} time(s) in this window` : "; the direction has been stable"}.`,
        keyValues: [
          { label: "Latest asymmetry", value: String(d.latest.value), unit: "%" },
          { label: "Stronger side", value: d.latest.strongerSide },
          { label: "Side changes in window", value: String(d.directionChanges) },
          { label: "Watch / flag", value: `${d.watchPct} / ${d.flagPct}`, unit: "%" },
        ],
        comparisonBasis: `Asymmetry index per session (|stronger−weaker| ÷ mean of sides) on ${def.label}, against facility thresholds.`,
        limitations: [],
        suggestedNext: ["Check whether the direction matches what you see in on-floor loading."],
        followUps: ["Did the stronger side change?", "How does the Force 0–300 ms window look side to side?"],
        contextUsed: { metricKey: source, testType: def.testType },
      };
    }

    /* ---------------- IMTP force window ---------------- */
    case "force_window": {
      const res = await run("getForceWindowSummary");
      if (res.insufficient || !res.data) {
        return insufficientResult(run, routed, "No IMTP Force 0–300 ms values are recorded.", "The fixed-time points appear after an IMTP session with a detected force onset is imported.", ["What information is missing?"]);
      }
      const d = res.data as { latestDate: string; rows: { ms: number; metricKey: string; absN: number | null; relNkg: number | null; asymmetryPct: number | null; strongerSide: string | null }[] };
      const wanted = routed.pointMs ? d.rows.filter((r) => r.ms === routed.pointMs) : d.rows;
      const evByKey = new Map(res.evidence.map((e) => [e.id.split(":")[1], e]));
      const claims: Claim[] = wanted
        .filter((r) => r.absN != null)
        .slice(0, 6)
        .map((r) =>
          buildClaim({
            text: `Force at ${r.ms} ms: ${Math.round(r.absN!)} N${r.relNkg != null ? ` (${rp(r.relNkg, 2)} N/kg)` : ""}${r.asymmetryPct != null ? `, asymmetry ${r1(r.asymmetryPct)}% with the ${r.strongerSide} side stronger` : ""} — official persisted value from ${d.latestDate}.`,
            claimType: "context",
            metricKey: r.metricKey,
            comparisonWindow: d.latestDate,
            evidenceRefs: [evByKey.get(r.metricKey)!].filter(Boolean),
            confidence: "high",
          })
        );
      const p = wanted.find((r) => r.absN != null);
      return {
        summary: `IMTP Force 0–300 ms, latest session ${d.latestDate}: ${claims.length} official time point(s). ${DEFER}`,
        claims: claims.length ? claims : [buildClaim({ text: `No official force values exist at the requested time point.`, claimType: "data_gap", evidenceRefs: [await qualityAnchor(run)], confidence: "high" })],
        directAnswer: p
          ? `Force at ${p.ms} ms is ${Math.round(p.absN!)} N${p.relNkg != null ? ` (${rp(p.relNkg, 2)} N/kg)` : ""} on ${d.latestDate}.`
          : "No official force-point values in the selected window.",
        keyValues: wanted.filter((r) => r.absN != null).slice(0, 4).map((r) => ({ label: `@${r.ms} ms`, value: String(Math.round(r.absN!)), unit: "N" })),
        comparisonBasis: "Persisted official fixed-time force values (never re-read from the display waveform).",
        limitations: wanted.some((r) => r.asymmetryPct == null) ? ["Side values and asymmetry appear only where genuine left/right plate data exists."] : [],
        suggestedNext: ["Open the Force 0–300 ms table for all six points with left/right detail."],
        followUps: ["Which side is stronger?", "What about normalized force?", "How does this compare with the team?"],
        contextUsed: { testType: "imtp", metricKey: routed.metricKey, window: d.latestDate },
      };
    }

    /* ---------------- curve comparison ---------------- */
    case "curve_comparison": {
      const testType = routed.testType === "imtp" ? "imtp" : "cmj";
      const a = routed.curveA ?? "latest";
      const b = routed.curveB ?? "previous";
      const res = await run("compareCurves", { testType, a, b });
      if (res.insufficient || !res.data || !(res.data as { comparable?: boolean }).comparable) {
        const reason = res.insufficient ?? "curves not comparable";
        return insufficientResult(run, routed, `The requested ${testType.toUpperCase()} curves cannot be compared.`, `Reason: ${reason}.`, ["Which attempts have valid curves?"]);
      }
      const c = res.data as {
        a: { label: string; kind: string }; b: { label: string; kind: string; includedCount: number };
        displayPeakN: { a: number; b: number; diff: number } | null;
        meanDiffOverOverlapN: number | null;
        overlapStartMs: number | null; overlapEndMs: number | null;
        officialPeakForceN: { a: number; b: number; diff: number } | null;
        officialTimeToPeakMs: { a: number; b: number; diff: number } | null;
        officialTimeToTakeoffMs: { a: number; b: number; diff: number } | null;
        officialForcePointDiffs: { ms: number; a: number; b: number; diff: number }[] | null;
      };
      const parts: string[] = [];
      if (c.officialPeakForceN) parts.push(`official peak force ${c.officialPeakForceN.a} vs ${c.officialPeakForceN.b} N (difference ${c.officialPeakForceN.diff} N)`);
      if (c.officialTimeToPeakMs) parts.push(`time to peak ${c.officialTimeToPeakMs.a} vs ${c.officialTimeToPeakMs.b} ms (${c.officialTimeToPeakMs.diff} ms)`);
      if (c.officialTimeToTakeoffMs) parts.push(`time to takeoff ${c.officialTimeToTakeoffMs.a} vs ${c.officialTimeToTakeoffMs.b} ms (${c.officialTimeToTakeoffMs.diff} ms)`);
      const claim = buildClaim({
        text: `${c.a.label} vs ${c.b.label}: ${parts.length ? parts.join("; ") + ". " : ""}Display-resolution peaks ${c.displayPeakN?.a} vs ${c.displayPeakN?.b} N; mean force difference ${c.meanDiffOverOverlapN} N over the overlapping aligned window ${c.overlapStartMs}–${c.overlapEndMs} ms.`,
        claimType: "curve_comparison",
        comparisonWindow: `${a}-vs-${b}`,
        evidenceRefs: res.evidence,
        confidence: parts.length ? "high" : "moderate",
        uncertaintyReason: parts.length ? undefined : "official values exist only when both curves are individual attempts; averages compare at display resolution",
      });
      const limitations = [
        "Display-resolution values come from the downsampled display copy of the waveform, not the full-rate signal.",
      ];
      if (!parts.length) limitations.push("Official peak/timing differences are withheld because one side is an average — only individual attempts carry official values.");
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: c.officialPeakForceN
          ? `Peak force differs by ${c.officialPeakForceN.diff} N between the two attempts (official values).`
          : `The curves differ by ${c.meanDiffOverOverlapN} N on average over their shared window (display resolution).`,
        keyValues: [
          ...(c.officialPeakForceN ? [{ label: "Peak force diff", value: String(c.officialPeakForceN.diff), unit: "N" }] : []),
          ...(c.officialTimeToPeakMs ? [{ label: "Time-to-peak diff", value: String(c.officialTimeToPeakMs.diff), unit: "ms" }] : []),
          ...(c.officialTimeToTakeoffMs ? [{ label: "Time-to-takeoff diff", value: String(c.officialTimeToTakeoffMs.diff), unit: "ms" }] : []),
          { label: "Mean diff (display)", value: String(c.meanDiffOverOverlapN), unit: "N" },
        ].slice(0, 4),
        comparisonBasis: `${c.a.label} (${c.a.kind}) vs ${c.b.label} (${c.b.kind}${c.b.kind === "average" ? `, ${c.b.includedCount} valid attempts` : ""}), onset-aligned, overlap-only.`,
        limitations,
        suggestedNext: ["Open the curve workspace to see both curves overlaid."],
        followUps: ["Compare the latest attempt with the all-time average.", "Which attempts have valid curves?"],
        contextUsed: { testType, comparison: `${a} vs ${b}` },
      };
    }

    /* ---------------- load-velocity ---------------- */
    case "load_velocity": {
      const res = await run("getLoadVelocityProfile", {});
      if (res.insufficient && !res.data) {
        return insufficientResult(run, routed, "No load-velocity profile can be built.", "No stored velocity reps exist for this athlete.", ["What information is missing?"]);
      }
      const d = res.data as {
        latest: { exercise: string; date: string; profile: { status: string; method: string | null; distinctLoads: number; validReps: number; slope: number | null; intercept: number | null; r2: number | null; excludedReps: unknown[]; notes: string[] } };
        previous: { date: string; profile: { slope: number | null } } | null;
        slopeChange: number | null;
      };
      const p = d.latest.profile;
      const exercise = d.latest.exercise.replace(/_/g, " ");
      if (p.status === "insufficient") {
        const anchor = res.evidence[0] ?? (await qualityAnchor(run));
        const claim = buildClaim({
          text: `The latest ${exercise} session (${d.latest.date}) has ${p.distinctLoads} distinct load(s) — a load–velocity profile needs at least two distinct loads. The ${p.validReps} valid rep(s) are still real observations.`,
          claimType: "data_gap",
          comparisonWindow: d.latest.date,
          evidenceRefs: [anchor],
          confidence: "high",
        });
        return {
          summary: `${claim.text} ${DEFER}`,
          claims: [claim],
          directAnswer: `No profile can be fitted yet: only ${p.distinctLoads} distinct load(s) recorded.`,
          keyValues: [{ label: "Distinct loads", value: String(p.distinctLoads) }, { label: "Valid reps", value: String(p.validReps) }],
          limitations: ["A load–velocity profile needs at least 2 distinct loads; 4 is the standard fuller protocol."],
          suggestedNext: ["Record a second, clearly different load in the next velocity session."],
          followUps: ["What data is missing before this comparison is reliable?"],
          contextUsed: { testType: "vbt" },
        };
      }
      const slopeTxt = p.slope!.toFixed(4);
      const claim = buildClaim({
        text: `${exercise} (${d.latest.date}): ${p.distinctLoads}-load ${p.method === "two_point" ? "two-point" : "least-squares"} profile with slope ${slopeTxt} (m/s)/kg${p.r2 != null ? ` and R² ${p.r2.toFixed(3)}` : " (R² is not meaningful for 2 points and is not shown)"}${d.slopeChange != null ? `; slope changed ${d.slopeChange > 0 ? "+" : ""}${d.slopeChange} vs the previous profile` : ""}. ${p.excludedReps.length} rep(s) excluded by explicit quality flag.`,
        claimType: "load_velocity_profile",
        comparisonWindow: d.latest.date,
        evidenceRefs: res.evidence,
        confidence: "high",
      });
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer:
          d.slopeChange != null
            ? `The ${exercise} profile ${Math.abs(d.slopeChange) < 0.0005 ? "is essentially unchanged" : `shifted (slope ${d.slopeChange > 0 ? "+" : ""}${d.slopeChange})`} vs the previous session's profile.`
            : `The latest ${exercise} profile is a ${p.distinctLoads}-load ${p.method === "two_point" ? "two-point" : "least-squares"} fit (slope ${slopeTxt}).`,
        keyValues: [
          { label: "Slope", value: slopeTxt, unit: "(m/s)/kg" },
          { label: "Distinct loads", value: String(p.distinctLoads) },
          ...(p.r2 != null ? [{ label: "R²", value: p.r2.toFixed(3) }] : []),
          ...(d.slopeChange != null ? [{ label: "Slope change", value: `${d.slopeChange > 0 ? "+" : ""}${d.slopeChange}` }] : []),
        ],
        comparisonBasis: "Profiles rebuilt live from stored valid reps (mean of valid reps per distinct load); no extrapolation beyond observed loads.",
        limitations: p.method === "two_point" ? ["Two-point method: R² is not meaningful and load placement (~40% / ≥80% of max) is protocol guidance only — no reference max is recorded."] : [],
        suggestedNext: ["Open the load–velocity panel for the observed points and fitted line."],
        followUps: ["What data is missing before this comparison is reliable?"],
        contextUsed: { testType: "vbt", window: d.latest.date },
      };
    }

    /* ---------------- recent vs normal ---------------- */
    case "recent_vs_normal": {
      const metricKey =
        routed.metricKey ?? (routed.testType ? TEST_TYPES[routed.testType]?.defaultMetric : undefined) ?? "cmj_jump_height";
      const def = METRICS[metricKey];
      const window = routed.rvnWindow ?? 5;
      const res = await run("getMetricSeries", { metricType: metricKey, lastN: Math.min(window + 1, 60) });
      const d = res.data as { points?: { date: string; value: number }[] } | null;
      const rvn = recentVsNormal(d?.points ?? [], window);
      if (!rvn.latest || rvn.referenceMean == null) {
        return insufficientResult(run, { ...routed, metricKey }, `Whether the latest ${def.shortLabel} is normal for this athlete can't be judged yet.`, `Reason: ${rvn.insufficient ?? res.insufficient ?? "no comparable history"}.`, ["What information is missing?"]);
      }
      const p = def.precision;
      const latestV = Number(rvn.latest.value.toFixed(p));
      const refV = Number(rvn.referenceMean.toFixed(p));
      const diffV = Number(rvn.diff!.toFixed(p));
      const pctV = rvn.pctDiff != null ? Number(rvn.pctDiff.toFixed(1)) : null;
      const rvnRef: EvidenceRef = {
        id: `series:${metricKey}:bilateral:rvn:${window}`,
        type: "metric_series",
        label: `${def.shortLabel}: latest ${latestV} vs mean ${refV} ${def.unit} of the previous ${rvn.referenceCount} valid sessions`,
        values: [latestV, refV, diffV, ...(pctV != null ? [pctV] : []), rvn.referenceCount, window],
        unit: def.unit,
        date: rvn.latest.date,
      };
      const claim = buildClaim({
        text: `${def.shortLabel} on ${rvn.latest.date} is ${latestV} ${def.unit} vs an average of ${refV} ${def.unit} across the previous ${rvn.referenceCount} valid sessions — a difference of ${diffV > 0 ? "+" : ""}${diffV} ${def.unit}${pctV != null ? ` (${pctV > 0 ? "+" : ""}${pctV}%)` : ""}. The latest session is never part of the window used to judge it.`,
        claimType: "context",
        metricKey,
        comparisonWindow: `latest-vs-previous-${window}`,
        evidenceRefs: [rvnRef, ...res.evidence.slice(0, 2)],
        confidence: rvn.insufficient ? "moderate" : "high",
        uncertaintyReason: rvn.insufficient ?? undefined,
      });
      const limitations = [
        "This is a descriptive comparison with the athlete's own recent values. Whether a difference exceeds normal measurement variability is NOT assessed here — that requires the reliability/monitoring engine's configured thresholds.",
      ];
      if (rvn.insufficient) limitations.push(rvn.insufficient + ".");
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: `The latest ${def.shortLabel} is ${Math.abs(diffV) < 1 / 10 ** p ? "essentially at" : diffV > 0 ? "above" : "below"} the athlete's recent average by ${Math.abs(diffV)} ${def.unit}${pctV != null ? ` (${Math.abs(pctV)}%)` : ""}.`,
        keyValues: [
          { label: "Latest", value: String(latestV), unit: def.unit },
          { label: `Avg of previous ${rvn.referenceCount}`, value: String(refV), unit: def.unit },
          { label: "Difference", value: `${diffV > 0 ? "+" : ""}${diffV}`, unit: def.unit },
          ...(pctV != null ? [{ label: "Difference %", value: `${pctV > 0 ? "+" : ""}${pctV}`, unit: "%" }] : []),
        ],
        comparisonBasis: `Latest session vs the mean of the previous ${rvn.referenceCount} valid sessions (requested window ${window}); the latest value is excluded from its own reference.`,
        limitations,
        suggestedNext: ["Open the trend chart to see where this session sits."],
        followUps: [`What changed in ${def.shortLabel} over time?`, "How does this athlete compare with the team?"],
        contextUsed: { metricKey, testType: def.testType, window: `previous-${rvn.referenceCount}` },
      };
    }

    /* ---------------- missing data ---------------- */
    case "missing_data": {
      const res = await run("getDataCompleteness");
      const d = (res.data ?? {}) as { score?: number; issues?: string[] };
      const issues = d.issues ?? [];
      const claim = buildClaim({
        text: issues.length
          ? `Missing or limiting information: ${issues.join("; ")}. Data completeness is ${d.score}/100.`
          : `No blocking gaps: data completeness is ${d.score}/100.`,
        claimType: issues.length ? "data_gap" : "data_quality",
        evidenceRefs: res.evidence,
        confidence: "high",
      });
      return {
        summary: `${claim.text} ${DEFER}`,
        claims: [claim],
        directAnswer: issues.length ? `${issues.length} gap(s) currently limit interpretation: ${issues[0]}${issues.length > 1 ? "; …" : "."}` : "No blocking data gaps right now.",
        keyValues: [{ label: "Completeness", value: `${d.score}/100` }],
        limitations: issues,
        suggestedNext: issues.length ? ["Address the first gap before drawing longitudinal conclusions."] : ["Routine review."],
        followUps: ["What changed since the previous comparable session?"],
        contextUsed: {},
      };
    }

    /* ---------------- review next / why finding ---------------- */
    case "review_next":
    case "why_finding": {
      const res = await run("getCurrentFindings");
      const rows = (res.data ?? []) as { id: string; severity: string; headline: string; detail: string; category: string }[];
      const matching = routed.metricKey ? rows.filter((r) => `${r.headline} ${r.detail}`.toLowerCase().includes(METRICS[routed.metricKey!]?.shortLabel.toLowerCase() ?? "")) : rows;
      const pick = (matching.length ? matching : rows).filter((r) => routed.kind === "review_next" ? r.severity !== "info" : true).slice(0, 3);
      if (pick.length === 0) {
        return insufficientResult(run, routed, routed.kind === "review_next" ? "Nothing is flagged for review right now." : "No matching finding exists to explain.", "The deterministic findings engine has no active items for this scope.", ["What changed since the previous comparable session?"]);
      }
      const claims = pick.map((r) =>
        buildClaim({
          text: routed.kind === "why_finding"
            ? `“${r.headline}” was generated deterministically: ${r.detail.replace(/\s+/g, " ").slice(0, 300)}`
            : `Recommended review: ${r.headline} (${r.category.replace(/_/g, " ")}, severity ${r.severity}).`,
          claimType: "context",
          comparisonWindow: routed.kind === "why_finding" ? "finding-explanation" : "current-findings",
          evidenceRefs: res.evidence.filter((e) => e.id === r.id),
          confidence: "high",
        })
      );
      return {
        summary: `${pick.length} finding(s) ${routed.kind === "why_finding" ? "explained" : "worth a look"}. ${DEFER}`,
        claims,
        directAnswer: routed.kind === "why_finding"
          ? `“${pick[0].headline}” is a rule-based, versioned finding — the trigger is explained below.`
          : `${pick.length} item(s) worth reviewing, starting with: ${pick[0].headline}.`,
        keyValues: [],
        limitations: [],
        suggestedNext: pick.map((r) => r.headline).slice(0, 3),
        followUps: ["Why was this finding generated?", "What information is missing?"],
        contextUsed: { metricKey: routed.metricKey },
      };
    }

    default: {
      // exhaustive guard — unreachable kinds route to current_status
      return scriptedFreeform(executor, { ...routed, kind: "current_status" });
    }
  }
}
