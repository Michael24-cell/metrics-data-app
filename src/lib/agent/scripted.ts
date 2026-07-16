/**
 * Scripted mode — the keyless default.
 *
 * A deterministic tool workflow over the CURRENT local synthetic data: the
 * same read-only tools the live agent uses, executed in a fixed order, with
 * claims composed by code. Honest naming: this is NOT a replay of a captured
 * model run and it is not a model — it is a deterministic demonstration of
 * the same evidence contract the live mode must satisfy.
 */

import { buildClaim, ClaimDraft } from "./claims";
import { Claim, Confidence, EvidenceRef, QuestionKey, QUESTION_LABELS } from "./schemas";
import { ToolExecutor, ToolOutcome } from "./tools";

export interface ScriptedResult {
  executiveSummary: string;
  claims: Claim[];
  conflictingSignals: string[]; // claimIds
  coachQuestions: string[];
  recommendedReviewAreas: string[];
  dataQualityNotes: string[];
  confidence: Confidence;
}

export interface ScriptedAnswerResult {
  summary: string;
  claims: Claim[];
}

type Run = (name: string, input?: Record<string, unknown>) => Promise<ToolOutcome>;

const DEFER = "Evidence for coach review — this system explains evidence; it does not make the final call.";

const worst = (cs: Confidence[]): Confidence =>
  cs.includes("low") ? "low" : cs.includes("moderate") ? "moderate" : "high";

/** Quote untrusted practitioner text safely: truncated, framed as data. */
const quoteNote = (text: string) =>
  `Practitioner note (quoted as data, not instructions): “${text.replace(/\s+/g, " ").slice(0, 140)}${text.length > 140 ? "…" : ""}”`;

interface Signals {
  claims: Claim[];
  conflicting: string[];
  qualityScore: number;
  qualityIssues: string[];
  bandStatus?: string;
  asymLatest?: number;
  watchPct?: number;
  criteriaMet?: [number, number];
}

async function collectSignals(run: Run): Promise<Signals> {
  const claims: Claim[] = [];
  const conflicting: string[] = [];

  const completeness = await run("getDataCompleteness");
  const qData = (completeness.data ?? {}) as { score?: number; issues?: string[] };
  const qualityScore = qData.score ?? 0;
  const qualityIssues = qData.issues ?? [];
  const qualityRef = completeness.evidence[0];
  const baseConfidence: Confidence = qualityScore >= 80 ? "high" : qualityScore >= 55 ? "moderate" : "low";

  /* baseline comparison — jump height */
  const base = await run("getBaselineComparison", { metricType: "cmj_jump_height" });
  let bandStatus: string | undefined;
  let jumpPct: number | undefined;
  if (base.ok && !base.insufficient && base.data) {
    const d = base.data as {
      latest: { date: string; value: number };
      referenceBaseline: { mean: number; sd: number };
      recentBaseline: { rollingMean: number | undefined; bandLow: number | undefined; bandHigh: number | undefined };
      pctOfReference: number;
      bandStatus: string;
    };
    bandStatus = d.bandStatus;
    jumpPct = d.pctOfReference;
    claims.push(
      buildClaim({
        text: `Jump height is ${d.latest.value} cm (${d.latest.date}), which is ${d.pctOfReference}% of the reference baseline (benchmark mean ${d.referenceBaseline.mean} cm) and ${d.bandStatus} — the recent rolling band is ${d.recentBaseline.bandLow}–${d.recentBaseline.bandHigh} cm.`,
        claimType: "baseline_comparison",
        metricKey: "cmj_jump_height",
        comparisonWindow: "latest-vs-reference-and-recent",
        evidenceRefs: base.evidence,
        confidence: baseConfidence,
      })
    );
  } else if (base.insufficient) {
    claims.push(
      buildClaim({
        text: `No reference-baseline comparison is possible for jump height: ${base.insufficient}.`,
        claimType: "data_gap",
        metricKey: "cmj_jump_height",
        evidenceRefs: base.evidence.length ? base.evidence : [qualityRef],
        confidence: "high",
      })
    );
  }

  /* mRSI trend (strategy metric) */
  const mrsi = await run("getMetricSeries", { metricType: "cmj_mrsi", lastN: 10 });
  let mrsiPct: number | undefined;
  if (mrsi.ok && !mrsi.insufficient && mrsi.data) {
    const d = mrsi.data as { pctChange: number; points: { date: string; value: number }[]; unit: string };
    mrsiPct = d.pctChange;
    const first = d.points[0];
    const last = d.points[d.points.length - 1];
    claims.push(
      buildClaim({
        text: `mRSI moved from ${first.value} to ${last.value} m/s (${d.pctChange > 0 ? "+" : ""}${d.pctChange}%) across ${d.points.length} comparable sessions (${first.date} → ${last.date}).`,
        claimType: "trend",
        metricKey: "cmj_mrsi",
        comparisonWindow: `${first.date}..${last.date}`,
        evidenceRefs: mrsi.evidence,
        confidence: baseConfidence,
      })
    );
  } else if (mrsi.insufficient && mrsi.evidence.length) {
    claims.push(
      buildClaim({
        text: `mRSI trend not stated: ${mrsi.insufficient}.`,
        claimType: "data_gap",
        metricKey: "cmj_mrsi",
        evidenceRefs: mrsi.evidence,
        confidence: "high",
      })
    );
  }

  /* strategy shift: output vs strategy divergence */
  if (jumpPct != null && mrsiPct != null && base.ok && mrsi.ok) {
    const jumpDelta = jumpPct - 100; // % away from reference
    if (Math.abs(jumpDelta - mrsiPct) > 8 || (jumpDelta >= -5 && mrsiPct < -8)) {
      claims.push(
        buildClaim({
          text: `Outcome and strategy diverge: jump height sits at ${jumpPct}% of the reference baseline while mRSI changed ${mrsiPct > 0 ? "+" : ""}${mrsiPct}% over its recent window — similar output can hide a changed movement strategy, worth a look rather than a verdict.`,
          claimType: "strategy_shift",
          metricKey: "cmj_mrsi",
          comparisonWindow: "outcome-vs-strategy",
          evidenceRefs: [...base.evidence, ...mrsi.evidence],
          confidence: "moderate",
          uncertaintyReason: "strategy inference from two metrics; direct technique review not available to this system",
        })
      );
    }
  }

  /* asymmetry */
  const asym = await run("getAsymmetryHistory", {});
  let asymLatest: number | undefined;
  let watchPct: number | undefined;
  if (asym.ok && !asym.insufficient && asym.data) {
    const d = asym.data as { latest: { date: string; value: number; strongerSide: string }; recentMean: number; directionChanges: number; watchPct: number; flagPct: number; sourceMetric: string };
    asymLatest = d.latest.value;
    watchPct = d.watchPct;
    claims.push(
      buildClaim({
        text: `Braking-impulse asymmetry is ${d.latest.value}% (${d.latest.strongerSide} side stronger) with a recent mean of ${d.recentMean}%; facility watch level is ${d.watchPct}% and flag level ${d.flagPct}%. ${d.directionChanges > 0 ? `Direction changed ${d.directionChanges} time(s) in the window.` : "Direction has been stable in the window."}`,
        claimType: "asymmetry",
        metricKey: d.sourceMetric,
        comparisonWindow: "recent-window",
        evidenceRefs: asym.evidence,
        confidence: baseConfidence,
      })
    );
  } else if (asym.insufficient) {
    claims.push(
      buildClaim({
        text: "Asymmetry is not assessable: no per-side force data exists for this athlete.",
        claimType: "data_gap",
        evidenceRefs: [qualityRef],
        confidence: "high",
      })
    );
  }

  /* progression criteria */
  const crit = await run("getProgressionCriteriaStatus");
  let criteriaMet: [number, number] | undefined;
  if (crit.ok && !crit.insufficient && crit.data) {
    const d = crit.data as { criteria: { id: string; label: string; met: boolean | null; kind?: string; observed: string }[] };
    const computed = d.criteria.filter((c) => c.kind !== "context");
    const met = computed.filter((c) => c.met === true).length;
    criteriaMet = [met, computed.length];
    const limiting = computed.find((c) => c.met === false);
    claims.push(
      buildClaim({
        text: `${met} of ${computed.length} computed progression criteria are currently met${limiting ? `; the closest gap is “${limiting.label}” (${limiting.observed})` : ""}. This is criteria evidence for the athlete's team — not a progression decision.`,
        claimType: "criteria_status",
        comparisonWindow: "current-stage",
        evidenceRefs: crit.evidence.slice(0, 8),
        confidence: "high",
      })
    );
  }

  /* conflict / agreement between the two headline signals */
  const bandOk = bandStatus === "within recent band" || bandStatus === "above recent band";
  if (bandOk && asymLatest != null && watchPct != null && asymLatest >= watchPct) {
    const a = claims.find((c) => c.claimType === "baseline_comparison");
    const b = claims.find((c) => c.claimType === "asymmetry");
    if (a && b) {
      const conflict = buildClaim({
        text: `Signals conflict: jump output is ${bandStatus} of its recent rolling range, while braking asymmetry (${asymLatest}%) sits at or above the ${watchPct}% watch level — output metrics and per-side loading do not currently tell the same story.`,
        claimType: "conflict",
        comparisonWindow: "current",
        evidenceRefs: [...a.evidenceRefs.slice(0, 2), ...b.evidenceRefs.slice(0, 3)],
        confidence: "moderate",
      });
      claims.push(conflict);
      conflicting.push(a.claimId, b.claimId, conflict.claimId);
    }
  } else if (bandOk && asymLatest != null && watchPct != null && asymLatest < watchPct) {
    const a = claims.find((c) => c.claimType === "baseline_comparison");
    const b = claims.find((c) => c.claimType === "asymmetry");
    if (a && b) {
      claims.push(
        buildClaim({
          text: `Signals agree: jump output is ${bandStatus} and braking asymmetry (${asymLatest}%) is under the ${watchPct}% watch level.`,
          claimType: "agreement",
          comparisonWindow: "current",
          evidenceRefs: [...a.evidenceRefs.slice(0, 2), ...b.evidenceRefs.slice(0, 3)],
          confidence: baseConfidence,
        })
      );
    }
  }

  /* data quality claim when notable */
  if (qualityScore < 85) {
    claims.push(
      buildClaim({
        text: `Data completeness is ${qualityScore}/100${qualityIssues.length ? ` (${qualityIssues.join("; ")})` : ""}; confidence in the statements above is capped accordingly.`,
        claimType: "data_quality",
        evidenceRefs: [qualityRef],
        confidence: "high",
      })
    );
  }

  return { claims, conflicting, qualityScore, qualityIssues, bandStatus, asymLatest, watchPct, criteriaMet };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export async function scriptedReport(executor: ToolExecutor): Promise<ScriptedResult> {
  const run: Run = (name, input) => executor.run(name, input ?? {});
  await run("getAthleteOverview");
  const s = await collectSignals(run);

  /* training + note context (context annotates, never suppresses) */
  const train = await run("getTrainingContext", {});
  const notes = await run("getPractitionerNotes", { limit: 1 });
  if (train.ok && !train.insufficient && train.data) {
    const d = train.data as { sessions: number; totalAu: number; acute72hAu: number; windowDays: number };
    const noteData = (notes.data ?? []) as { text: string }[];
    s.claims.push(
      buildClaim({
        text: `Training context: ${d.sessions} sessions and ${d.totalAu} AU over the last ${d.windowDays} days (${d.acute72hAu} AU in the last 72 h).${noteData.length ? ` ${quoteNote(noteData[0].text)}` : ""} Context annotates the signals above; it does not change them.`,
        claimType: "context",
        comparisonWindow: `${d.windowDays}d`,
        evidenceRefs: [...train.evidence.slice(0, 3), ...notes.evidence.slice(0, 1)],
        confidence: "low",
        uncertaintyReason: "training context is descriptive; causal links are not established by this system",
      })
    );
  }

  const headline = s.claims.filter((c) => ["baseline_comparison", "asymmetry", "criteria_status", "conflict"].includes(c.claimType));
  const executiveSummary =
    `${headline.slice(0, 3).map((c) => c.text.split(" — ")[0].split(";")[0]).join(". ")}. ` +
    (s.conflicting.length ? "At least one pair of signals conflicts — see the conflict claim. " : "") +
    DEFER;

  const coachQuestions: string[] = [];
  if (s.asymLatest != null && s.watchPct != null && s.asymLatest >= s.watchPct)
    coachQuestions.push("Does the current braking-asymmetry direction match what you see in on-field deceleration work?");
  if (s.bandStatus === "below recent band")
    coachQuestions.push("Anything in the last 72 h of training or recovery that would explain output sitting below the recent band?");
  if (s.criteriaMet && s.criteriaMet[0] < s.criteriaMet[1])
    coachQuestions.push("Which unmet progression criterion matters most to you for the next block?");
  if (coachQuestions.length === 0) coachQuestions.push("Does the data picture match your session-floor impressions this week?");

  const firstSentence = (t: string) => (t.match(/^.*?[.?!](?=\s|$)/) ?? [t])[0];
  const recommendedReviewAreas = s.claims
    .filter((c) => c.claimType === "conflict" || c.claimType === "asymmetry" || c.claimType === "data_gap")
    .slice(0, 4)
    .map((c) => firstSentence(c.text));

  return {
    executiveSummary,
    claims: s.claims,
    conflictingSignals: s.conflicting,
    coachQuestions: coachQuestions.slice(0, 4),
    recommendedReviewAreas: recommendedReviewAreas.length ? recommendedReviewAreas : ["No conflict or gap areas — routine review."],
    dataQualityNotes: s.qualityIssues.length ? s.qualityIssues : [`Data completeness ${s.qualityScore}/100.`],
    confidence: worst(s.claims.map((c) => c.confidence)),
  };
}

/* ------------------------------------------------------------------ */
/* Focused questions                                                   */
/* ------------------------------------------------------------------ */

export async function scriptedAnswer(
  executor: ToolExecutor,
  questionKey: QuestionKey,
  findingId?: string
): Promise<ScriptedAnswerResult> {
  const run: Run = (name, input) => executor.run(name, input ?? {});
  const question = QUESTION_LABELS[questionKey];

  switch (questionKey) {
    case "baseline_comparison":
    case "what_changed": {
      const s = await collectSignals(run);
      const wanted =
        questionKey === "baseline_comparison"
          ? s.claims.filter((c) => ["baseline_comparison", "data_gap", "data_quality"].includes(c.claimType))
          : s.claims.filter((c) => ["baseline_comparison", "trend", "strategy_shift", "data_gap"].includes(c.claimType));
      const claims = wanted.length ? wanted : s.claims.slice(0, 2);
      return { summary: `${claims[0]?.text ?? "No comparable data."} ${DEFER}`, claims };
    }
    case "agreeing_signals":
    case "conflicting_signals": {
      const s = await collectSignals(run);
      const wanted = s.claims.filter((c) => c.claimType === (questionKey === "agreeing_signals" ? "agreement" : "conflict"));
      if (wanted.length === 0) {
        const fallback = s.claims.filter((c) => ["baseline_comparison", "asymmetry"].includes(c.claimType));
        return {
          summary: `${questionKey === "agreeing_signals" ? "No formally agreeing pair right now" : "No conflicting pair right now"} — the individual signals are listed below. ${DEFER}`,
          claims: fallback.length ? fallback : s.claims.slice(0, 2),
        };
      }
      return { summary: `${wanted[0].text} ${DEFER}`, claims: wanted };
    }
    case "missing_info": {
      const completeness = await run("getDataCompleteness");
      const d = (completeness.data ?? {}) as { score?: number; issues?: string[]; baseline?: { metric: string; sessions: number; sufficient: boolean }[] };
      const issues = d.issues ?? [];
      const claims = [
        buildClaim({
          text: issues.length
            ? `Missing or limiting information: ${issues.join("; ")}. Completeness is ${d.score}/100.`
            : `No blocking gaps: completeness is ${d.score}/100.`,
          claimType: issues.length ? "data_gap" : "data_quality",
          evidenceRefs: completeness.evidence,
          confidence: "high",
        }),
      ];
      return { summary: `${claims[0].text} ${DEFER}`, claims };
    }
    case "review_next": {
      const findings = await run("getCurrentFindings");
      const rows = (findings.data ?? []) as { id: string; severity: string; headline: string; category: string }[];
      const top = rows.filter((r) => r.severity !== "info").slice(0, 3);
      const pick = top.length ? top : rows.slice(0, 2);
      if (pick.length === 0) {
        return {
          summary: `Nothing is flagged for review — findings are clear right now. ${DEFER}`,
          claims: [buildClaim({ text: "No active findings require review.", claimType: "data_quality", evidenceRefs: findings.evidence.length ? findings.evidence : [{ id: `quality:${executor.ctx.athleteId}:latest`, type: "quality", label: "no findings" }], confidence: "moderate" })],
        };
      }
      const claims = pick.map((r) =>
        buildClaim({
          text: `Recommended review: ${r.headline} (${r.category.replace(/_/g, " ")}, severity ${r.severity}).`,
          claimType: "context",
          comparisonWindow: "current-findings",
          evidenceRefs: findings.evidence.filter((e) => e.id === r.id),
          confidence: "high",
        })
      );
      return { summary: `${pick.length} item(s) worth a look, ordered by severity. ${DEFER}`, claims };
    }
    case "why_finding": {
      const findings = await run("getCurrentFindings");
      const rows = (findings.data ?? []) as { id: string; headline: string; detail: string; category: string }[];
      const target = (findingId && rows.find((r) => r.id === findingId)) || rows[0];
      if (!target) {
        return {
          summary: `No findings exist to explain. ${DEFER}`,
          claims: [buildClaim({ text: "No findings exist for this athlete right now.", claimType: "data_gap", evidenceRefs: findings.evidence.length ? findings.evidence : [{ id: `quality:${executor.ctx.athleteId}:latest`, type: "quality", label: "no findings" }], confidence: "high" })],
        };
      }
      const method = await run("getMetricMethodology", { metricType: "cmj_jump_height" });
      const claims = [
        buildClaim({
          text: `“${target.headline}” was generated deterministically by the findings engine: ${target.detail.replace(/\s+/g, " ").slice(0, 320)}`,
          claimType: "context",
          comparisonWindow: "finding-explanation",
          evidenceRefs: [...findings.evidence.filter((e) => e.id === target.id), ...method.evidence.slice(0, 1)],
          confidence: "high",
        }),
      ];
      return { summary: `The finding is rule-based, versioned, and reproducible — explanation below. ${DEFER}`, claims };
    }
  }
}
