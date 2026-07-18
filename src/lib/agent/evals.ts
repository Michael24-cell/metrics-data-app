/**
 * Deterministic post-generation evaluation (no model involved).
 *
 * Runs after EVERY agent output — fixture, scripted, or live — and gates what
 * the UI presents: pass / warn / fail with named, explained triggers.
 */

import { Claim, EvalCheck, EvalResult, EvidenceRef, EvidenceType, GeneratedReportSchema, AgentAnswerSchema, GeneratedReport, AgentAnswer } from "./schemas";
import { METRICS } from "../config/metrics";

export type EvidenceResolver = (type: EvidenceType, id: string) => { ok: boolean; error?: string };

/** fail: diagnosis / clearance / prediction / medical framing */
const PROHIBITED: { name: string; re: RegExp }[] = [
  { name: "diagnosis language", re: /\bdiagnos\w*/i },
  { name: "medical/clinical framing", re: /\b(medical(ly)?|clinical(ly)?|patient|treatment|prognosis|surgical|surgery|rehabilitat\w*)\b/i },
  { name: "clearance language", re: /\b(clear(ed|ance)?\s+(to|for)|medically cleared|fit to (play|compete|return))\b/i },
  { name: "return-to-play language", re: /\breturn[- ]to[- ](play|sport|competition)\b/i },
  { name: "injury prediction", re: /\b(predicts?|predicted|prediction of|likelihood of|probability of)\s+(an?\s+)?injur\w*/i },
  { name: "risk/readiness score", re: /\b(injury risk|risk score|readiness score|risk level)\b/i },
  { name: "final-call language", re: /\b(ready to (play|compete|return)|safe to (play|train|return)|good to go)\b/i },
  { name: "1RM/prescription language", re: /\b(1\s?rm|one[- ]rep(etition)? max|prescrib\w+|estimated max(imum)? (lift|load))\b/i },
];

/** warn: overconfident or unqualified phrasing */
const OVERCONFIDENT: RegExp = /\b(definitely|certainly|guarantee[ds]?|proves?|without (a )?doubt|will (improve|recover|increase)|always|never fails)\b/i;

const strip = (s: string) =>
  s
    .replace(/\d{4}-\d{2}-\d{2}/g, " ") // ISO dates
    .replace(/\bv\d+(\.\d+)*(-[a-z]+)?\b/gi, " ") // method versions
    .replace(/@\s?\d+\s?ms\b/gi, " ") // metric-label artifacts like "Force @100ms"
    .replace(/±/g, " ");

const numbersIn = (s: string): number[] =>
  (strip(s).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));

const allowedNumbers = (refs: EvidenceRef[]): number[] => {
  const out: number[] = [];
  for (const r of refs) {
    if (r.value != null) out.push(r.value);
    if (r.values) out.push(...r.values);
  }
  return out;
};

const grounded = (n: number, allowed: number[]): boolean =>
  allowed.some((a) => Math.abs(n - a) <= Math.max(0.051, Math.abs(a) * 0.0051)) ||
  // negated deltas ("-3.1%" vs stored 3.1) and vice versa
  allowed.some((a) => Math.abs(Math.abs(n) - Math.abs(a)) <= Math.max(0.051, Math.abs(a) * 0.0051));

export function evaluateOutput(
  output: GeneratedReport | AgentAnswer,
  resolve: EvidenceResolver
): EvalResult {
  const checks: EvalCheck[] = [];
  const push = (name: string, status: EvalCheck["status"], detail: string) => checks.push({ name, status, detail });

  /* 1 — schema validation */
  const schema = output.task === "report" ? GeneratedReportSchema : AgentAnswerSchema;
  const parsed = schema.safeParse(output);
  push(
    "schema_validation",
    parsed.success ? "pass" : "fail",
    parsed.success ? "Output matches the typed schema." : `Schema violations: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  );

  const claims: Claim[] = output.claims ?? [];
  const displayTexts: string[] = [
    output.task === "report" ? output.executiveSummary : output.summary,
    ...claims.map((c) => c.text),
    ...(output.task === "report" ? [...output.coachQuestions, ...output.recommendedReviewAreas, ...output.dataQualityNotes] : []),
  ];
  const joined = displayTexts.join("\n");

  /* 2 — prohibited language */
  const hits = PROHIBITED.filter((p) => p.re.test(joined));
  push(
    "prohibited_language",
    hits.length ? "fail" : "pass",
    hits.length ? `Blocked phrasing detected: ${hits.map((h) => h.name).join(", ")}. Match example: "${(joined.match(hits[0].re) ?? [""])[0]}"` : "No diagnosis, clearance, prediction, or medical framing."
  );

  /* 3 — overconfident language */
  const over = joined.match(OVERCONFIDENT);
  push("overconfident_language", over ? "warn" : "pass", over ? `Overconfident phrasing: "${over[0]}".` : "Phrasing stays measured.");

  /* 4 — evidence presence */
  const noEvidence = claims.filter((c) => !c.evidenceRefs || c.evidenceRefs.length === 0);
  push(
    "evidence_presence",
    noEvidence.length ? "fail" : "pass",
    noEvidence.length ? `${noEvidence.length} claim(s) carry no evidence references.` : `All ${claims.length} claims carry evidence references.`
  );

  /* 5 — evidence resolvable + scoped */
  const uniqueRefs = new Map<string, EvidenceRef>();
  for (const c of claims) for (const r of c.evidenceRefs) uniqueRefs.set(`${r.type}:${r.id}`, r);
  const unresolved: string[] = [];
  for (const r of uniqueRefs.values()) {
    const res = resolve(r.type, r.id);
    if (!res.ok) unresolved.push(`${r.type}:${r.id}${res.error ? ` (${res.error})` : ""}`);
  }
  push(
    "evidence_validity",
    unresolved.length ? "fail" : "pass",
    unresolved.length ? `Unresolvable or out-of-scope evidence: ${unresolved.slice(0, 3).join("; ")}${unresolved.length > 3 ? "…" : ""}` : `All ${uniqueRefs.size} evidence references resolve within the athlete's scope.`
  );

  /* 6 — numeric fidelity */
  const ungrounded: string[] = [];
  for (const c of claims) {
    const allowed = allowedNumbers(c.evidenceRefs);
    for (const n of numbersIn(c.text)) {
      if (!grounded(n, allowed)) ungrounded.push(`"${n}" in claim ${c.claimId.slice(0, 8)}`);
    }
  }
  push(
    "numeric_fidelity",
    ungrounded.length ? "fail" : "pass",
    ungrounded.length ? `Numbers not present in referenced evidence: ${ungrounded.slice(0, 4).join(", ")}${ungrounded.length > 4 ? "…" : ""}` : "Every number in claim text appears in that claim's referenced evidence."
  );

  /* 7 — comparability enforcement */
  const comparisonClaims = claims.filter((c) => c.claimType === "trend" || c.claimType === "baseline_comparison" || c.claimType === "strategy_shift");
  const missingGate = comparisonClaims.filter((c) => !c.evidenceRefs.some((r) => r.type === "comparability" && !(r.label ?? "").startsWith("NOT comparable")));
  push(
    "comparability_enforced",
    missingGate.length ? "fail" : "pass",
    missingGate.length
      ? `${missingGate.length} comparison claim(s) lack a passing comparability-gate reference.`
      : comparisonClaims.length
        ? `All ${comparisonClaims.length} comparison claims cite a passing comparability gate.`
        : "No longitudinal comparison claims made."
  );

  /* 8 — reference vs recent baseline distinction */
  const vagueBaseline = claims.filter(
    (c) => /baseline/i.test(c.text) && !/(reference|recent|rolling|benchmark)/i.test(c.text)
  );
  push(
    "baseline_distinction",
    vagueBaseline.length ? "warn" : "pass",
    vagueBaseline.length ? `${vagueBaseline.length} claim(s) say "baseline" without distinguishing reference vs recent.` : "Reference and recent baselines are distinguished wherever mentioned."
  );

  /* 9 — low data quality must be disclosed */
  const qualityRefs = [...uniqueRefs.values()].filter((r) => r.type === "quality");
  const lowQuality = qualityRefs.some((r) => (r.values?.[0] ?? 100) < 70);
  const disclosed = claims.some((c) => c.claimType === "data_quality" || c.claimType === "data_gap") ||
    (output.task === "report" && output.dataQualityNotes.length > 0);
  push(
    "quality_disclosure",
    lowQuality && !disclosed ? "warn" : "pass",
    lowQuality && !disclosed ? "Data-completeness score is low but no data-quality note or gap claim discloses it." : "Data-quality state is disclosed where relevant."
  );

  /* V2-1 — cohort claims must carry cohort evidence (sample size stays addressable) */
  const cohortClaims = claims.filter((c) => c.claimType === "cohort_comparison");
  const cohortMissing = cohortClaims.filter((c) => !c.evidenceRefs.some((r) => r.type === "cohort"));
  push(
    "cohort_grounding",
    cohortMissing.length ? "fail" : "pass",
    cohortMissing.length
      ? `${cohortMissing.length} cohort-comparison claim(s) cite no cohort evidence — sample size and cohort basis must be evidence-addressable.`
      : cohortClaims.length
        ? `All ${cohortClaims.length} cohort claims cite cohort evidence (mean/median/SD/n).`
        : "No cohort-comparison claims made."
  );

  /* V2-2 — curve claims must carry prepared-curve evidence */
  const curveClaims = claims.filter((c) => c.claimType === "curve_comparison");
  const curveMissing = curveClaims.filter((c) => !c.evidenceRefs.some((r) => r.type === "curve"));
  push(
    "curve_grounding",
    curveMissing.length ? "fail" : "pass",
    curveMissing.length
      ? `${curveMissing.length} curve-comparison claim(s) cite no prepared-curve evidence.`
      : curveClaims.length
        ? `All ${curveClaims.length} curve claims cite deterministic curve-comparison evidence.`
        : "No curve-comparison claims made."
  );

  /* V2-3 — load-velocity claims must carry lv_profile evidence */
  const lvClaims = claims.filter((c) => c.claimType === "load_velocity_profile");
  const lvMissing = lvClaims.filter((c) => !c.evidenceRefs.some((r) => r.type === "lv_profile"));
  push(
    "lv_profile_grounding",
    lvMissing.length ? "fail" : "pass",
    lvMissing.length
      ? `${lvMissing.length} load-velocity claim(s) cite no live-profile evidence.`
      : lvClaims.length
        ? `All ${lvClaims.length} load-velocity claims cite the rebuilt profile evidence.`
        : "No load-velocity claims made."
  );

  /* V2-4 — key-value units must come from cited evidence (unit fidelity) */
  const v2 = output as { keyValues?: { label: string; value: string; unit?: string }[]; dataUsed?: EvidenceRef[] };
  if (v2.keyValues && v2.keyValues.length > 0) {
    // units registered in the metric registry are legitimate app units by
    // definition — the check catches INVENTED units, not registry ones
    const allowedUnits = new Set<string>(["%", "", "ms", "/100", ...Object.values(METRICS).map((m) => m.unit)]);
    for (const r of v2.dataUsed ?? []) if (r.unit) allowedUnits.add(r.unit);
    for (const c of claims) for (const r of c.evidenceRefs) if (r.unit) allowedUnits.add(r.unit);
    const badUnits = v2.keyValues.filter((kv) => kv.unit && !allowedUnits.has(kv.unit) && !kv.unit.includes("/"));
    push(
      "unit_fidelity",
      badUnits.length ? "warn" : "pass",
      badUnits.length
        ? `Key values carry units not present in any cited evidence: ${badUnits.map((k) => `${k.label} (${k.unit})`).join(", ")}.`
        : "Every key-value unit comes from cited evidence."
    );
  } else {
    push("unit_fidelity", "pass", "No key values presented.");
  }

  /* 10 — no verdict aggregation */
  const verdicty = /\b(overall (readiness|score)|composite (score|index)|(\d+|\w+)\/(10|100) readiness)\b/i.test(joined);
  push("no_verdict_aggregation", verdicty ? "fail" : "pass", verdicty ? "Output aggregates evidence into a single readiness verdict/score." : "Evidence is presented per-signal; no single readiness verdict.");

  const status: EvalResult["status"] = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { status, checks };
}
