/**
 * Bounded intent router (pure, client-safe, deterministic).
 *
 * Classifies a trainer's natural-language question into one supported intent
 * with resolved scope (test, metric, cohort, curve selections), or into an
 * HONEST refusal (unsupported/out-of-scope/prohibited), or into a minimal
 * clarification when a materially answer-changing basis is ambiguous.
 *
 * This is NOT a language model: routing is keyword/synonym based over the
 * metric registry, so it is testable, versioned, and cannot fabricate scope.
 * In live mode the router's output is advisory context for the model; in
 * scripted mode it selects the deterministic composer. Unsupported and
 * prohibited questions are refused BEFORE any model call in either mode.
 */

import { METRICS, TEST_TYPES, IMTP_FORCE_POINT_KEYS } from "../config/metrics";

export const INTENT_ROUTER_VERSION = "1.0.0";

export type IntentKind =
  | "current_status"
  | "change_over_time"
  | "baseline_comparison"
  | "team_comparison"
  | "position_comparison"
  | "asymmetry"
  | "force_window"
  | "curve_comparison"
  | "load_velocity"
  | "missing_data"
  | "review_next"
  | "why_finding"
  | "unsupported";

/** page/session context the question is asked from (all optional) */
export interface QuestionContext {
  testType?: string;
  metricKey?: string;
  from?: string;
  to?: string;
  cohort?: "team" | "position";
}

export interface ClarificationOption {
  label: string;
  /** re-ask with this question text (context made explicit) */
  question: string;
}

export interface RoutedIntent {
  kind: IntentKind;
  testType?: string;
  metricKey?: string;
  pointMs?: number;
  cohort?: "team" | "position";
  normalized?: boolean;
  curveA?: string;
  curveB?: string;
  /** tools the scripted composer will call (advisory for live mode) */
  requiredTools: string[];
  clarification?: { question: string; options: ClarificationOption[] };
  unsupported?: { reason: string; missing?: string; nearest?: string };
}

/* ---------------- vocabulary ---------------- */

const PROHIBITED_PATTERNS: { re: RegExp; reason: string; nearest: string }[] = [
  {
    // NOTE: refusal wording is echoed into trainer-facing answers, so it must
    // itself stay clean under the deterministic prohibited-language checker.
    re: /\b(ready to (play|compete|return)|clear(ed)? (to|for)|clearance|return[- ]to[- ]play|fit to play)\b/i,
    reason: "This system never makes readiness or availability decisions — those stay with the athlete's qualified team. It can only show measured evidence.",
    nearest: "What changed in this athlete's recent results?",
  },
  {
    re: /\b(1\s?rm|one[- ]rep max|max(imum)? lift|how much (weight |load )?(should|can))\b/i,
    reason: "No 1RM estimate or load prescription exists in this system — the load-velocity profile deliberately does not extrapolate beyond observed loads.",
    nearest: "Is the load-velocity profile changing?",
  },
  {
    re: /\b(prescri\w+|what (training|program|exercises) should|program (them|him|her))\b/i,
    reason: "This system explains measured evidence; it does not prescribe training.",
    nearest: "What should the coach review next?",
  },
  {
    re: /\b(predict\w*|likelihood|probability|risk) (of )?(injur\w*|getting hurt)\b/i,
    reason: "Forecasting how likely someone is to get hurt is outside this system's validated scope — it reports measured performance only.",
    nearest: "What information is missing?",
  },
  {
    re: /\b(ignore (the )?(evidence|data)|make (something|it) up|fabricate|pretend|just say)\b/i,
    reason: "Answers are grounded in validated application data only — evidence cannot be ignored or invented.",
    nearest: "What changed in this athlete's recent results?",
  },
];

const DOMAIN_WORDS =
  /\b(jump|force|imtp|cmj|mrsi|rsi|asymmetr\w*|side|left|right|team|position|guard|forward|center|curve|waveform|trace|velocity|load|squat|deadlift|baseline|session|test|metric|trend|athlete|train\w*|peak|takeoff|braking|propulsive|impulse|rfd|profile|cohort|z[- ]?score|average|data|monitor\w*|finding|review|compar\w*|change|improv\w*|declin\w*|missing|reliab\w*|normali[sz]ed|body[- ]?mass|kg|newton|stronger|attempt|rolling)\b/i;

/** metricKey ← synonym patterns (checked in order; first match wins) */
const METRIC_SYNONYMS: { re: RegExp; key: string }[] = [
  { re: /\bjump height\b/i, key: "cmj_jump_height" },
  { re: /\bmrsi\b|\bmodified reactive\b/i, key: "cmj_mrsi" },
  { re: /\btime to takeoff\b/i, key: "cmj_time_to_takeoff" },
  { re: /\bbraking\b/i, key: "cmj_ecc_braking_impulse" },
  { re: /\bpropulsive\b/i, key: "cmj_peak_propulsive_force" },
  { re: /\btime to peak\b/i, key: "imtp_time_to_peak_force" },
  { re: /\brelative (peak )?force\b|\bn\/kg\b/i, key: "imtp_relative_force" },
  { re: /\bpeak force\b/i, key: "imtp_peak_force" },
  { re: /\bdrop[- ]jump\b.*\brsi\b|\brsi\b(?!.*modified)/i, key: "dj_rsi" },
  { re: /\bmean velocity\b/i, key: "lv_mean_velocity" },
];

const uniq = (xs: string[]) => [...new Set(xs)];

/* ---------------- router ---------------- */

export function routeQuestion(rawText: string, ctx: QuestionContext = {}): RoutedIntent {
  const text = rawText.trim().slice(0, 500);
  const t = text.toLowerCase();

  /* prohibited asks — refuse before anything else */
  for (const p of PROHIBITED_PATTERNS) {
    if (p.re.test(t)) {
      return {
        kind: "unsupported",
        requiredTools: [],
        unsupported: { reason: p.reason, nearest: p.nearest },
      };
    }
  }

  /* out-of-domain guard */
  if (!DOMAIN_WORDS.test(t)) {
    return {
      kind: "unsupported",
      requiredTools: [],
      unsupported: {
        reason: "The question is outside this system's sports-performance data scope — it can only answer questions about this facility's recorded tests, metrics, comparisons, and data quality.",
        nearest: "What changed since the previous comparable session?",
      },
    };
  }

  /* fixed time point (e.g. "force at 100 ms", "100ms") */
  const msMatch = t.match(/\b(50|100|150|200|250|300)\s?ms\b/);
  const pointMs = msMatch ? Number(msMatch[1]) : undefined;
  const forceWindowish = /\bforce (0|zero)\s?[-–to]+\s?300\b|\bearly force\b/.test(t) || (pointMs != null && /\bforce\b/.test(t));

  /* metric */
  let metricKey: string | undefined;
  if (forceWindowish && pointMs != null) metricKey = IMTP_FORCE_POINT_KEYS[pointMs];
  if (!metricKey) metricKey = METRIC_SYNONYMS.find((s) => s.re.test(t))?.key;
  if (!metricKey && /\b(that|it|this metric)\b/.test(t)) metricKey = ctx.metricKey; // follow-up
  if (!metricKey && ctx.metricKey && !/\bteam|position|guard|forward|center|curve|velocity profile\b/.test(t)) {
    // inherit the page metric for metric-shaped questions with no explicit metric
    if (/\bnormali[sz]ed|trend|chang|improv|declin|baseline|asymmetr|stronger\b/.test(t)) metricKey = ctx.metricKey;
  }

  /* normalized form requested? */
  const normalized = /\bnormali[sz]ed|per (kilo|kg)|body[- ]?mass\b|\bn\/kg\b/.test(t);
  if (normalized && metricKey && METRICS[metricKey]?.normalizedKey) metricKey = METRICS[metricKey].normalizedKey;

  /* test type */
  let testType: string | undefined;
  if (/\bimtp\b|mid[- ]thigh/.test(t)) testType = "imtp";
  else if (/\bcmj\b|countermovement/.test(t)) testType = "cmj";
  else if (/\bdrop[- ]jump\b/.test(t)) testType = "drop_jump";
  else if (/\b(vbt|barbell|squat|deadlift|load[- ]velocity|velocity profile)\b/.test(t)) testType = "vbt";
  if (!testType && metricKey) testType = METRICS[metricKey]?.testType;
  if (!testType && forceWindowish) testType = "imtp";
  if (!testType) testType = ctx.testType;

  const helper = (kind: IntentKind, extra: Partial<RoutedIntent>, tools: string[]): RoutedIntent => ({
    kind,
    testType,
    metricKey,
    pointMs,
    normalized: normalized || undefined,
    requiredTools: uniq(tools),
    ...extra,
  });

  /* ---- intent selection, most specific first ---- */

  /* load-velocity */
  if (/\bload[- ]velocity\b|\bvelocity profile\b|\bl[- ]v profile\b/.test(t) || (testType === "vbt" && /\bprofile|chang|point|load/.test(t))) {
    return helper("load_velocity", {}, ["getLoadVelocityProfile"]);
  }

  /* curve comparison */
  if (/\bcurve|waveform|trace\b/.test(t) || /\brolling[- ](five|ten|thirty|5|10|30)\b.*\b(attempt|average|latest)\b|\blatest attempt\b.*\baverage\b/.test(t)) {
    const curveTest = testType === "imtp" || testType === "cmj" ? testType : undefined;
    if (!curveTest) {
      return helper(
        "curve_comparison",
        {
          clarification: {
            question: "Force-time curves exist for two tests — which one?",
            options: [
              { label: "CMJ", question: `${text} (CMJ)` },
              { label: "IMTP", question: `${text} (IMTP)` },
            ],
          },
        },
        ["getCurveOptions", "compareCurves"]
      );
    }
    const rolling = t.match(/rolling[- ](five|5|ten|10|thirty|30)/);
    const rollingToken = rolling ? `rolling:${rolling[1] === "five" ? 5 : rolling[1] === "ten" ? 10 : rolling[1] === "thirty" ? 30 : Number(rolling[1])}` : undefined;
    const b = rollingToken ?? (/\ball[- ]time\b/.test(t) ? "alltime" : "previous");
    return helper("curve_comparison", { testType: curveTest, curveA: "latest", curveB: b }, ["getCurveOptions", "compareCurves"]);
  }

  /* asymmetry / stronger side */
  if (/\basymmetr\w*|stronger side|which side|side (change|flip)|left.{0,12}right\b/.test(t)) {
    const tools = ["getAsymmetryHistory"];
    if (forceWindowish || testType === "imtp") tools.push("getForceWindowSummary");
    return helper("asymmetry", {}, tools);
  }

  /* "why is X being monitored" → finding explanation */
  if (/\bwhy\b/.test(t) && /\bmonitor\w*|flag\w*|watch\w*|finding\b/.test(t)) {
    return helper("why_finding", {}, ["getCurrentFindings", "getAsymmetryHistory"]);
  }

  /* team / position comparison */
  const positionish = /\bposition\b|\bguards?\b|\bforwards?\b|\bcenters?\b|\bother (players|athletes) (at|in) (the|their)\b/.test(t);
  const teamish = /\bteam\b|\bsquad\b|\broster\b|\bteammates\b/.test(t) || /\bcompare\w*\b.*\bwith (the )?(rest|others)\b/.test(t);
  if (positionish || teamish) {
    const cohort: "team" | "position" = positionish && !/\bwhole team|team average|team mean\b/.test(t) && positionish !== teamish ? (positionish ? "position" : "team") : positionish ? "position" : "team";
    const effective = metricKey ?? ctx.metricKey;
    if (!effective) {
      return helper(
        "team_comparison",
        {
          cohort,
          clarification: {
            question: "Compare on which metric? The choice changes every number in the comparison.",
            options: [
              { label: "Jump height", question: `${text} (jump height)` },
              { label: "IMTP peak force", question: `${text} (peak force)` },
              { label: "Force at 100 ms", question: `${text} (force at 100 ms)` },
            ],
          },
        },
        ["getTeamComparison"]
      );
    }
    return helper(cohort === "position" ? "position_comparison" : "team_comparison", { cohort, metricKey: effective }, ["getTeamComparison"]);
  }

  /* force window (no explicit asymmetry/team angle) */
  if (forceWindowish) {
    return helper("force_window", { testType: "imtp" }, ["getForceWindowSummary"]);
  }

  /* missing data / reliability */
  if (/\bmissing|reliab\w*|before (this|the) comparison|enough data|data quality\b/.test(t)) {
    return helper("missing_data", {}, ["getDataCompleteness"]);
  }

  /* review next */
  if (/\breview next|look at next|priorit\w*\b/.test(t)) {
    return helper("review_next", {}, ["getCurrentFindings"]);
  }

  /* baseline comparison */
  if (/\bbaseline\b/.test(t)) {
    return helper("baseline_comparison", {}, ["getBaselineComparison"]);
  }

  /* change over time */
  if (/\bwhat changed|chang(e|ed|ing)|trend|improv\w*|declin\w*|over time|since\b/.test(t)) {
    const tools = metricKey ? ["getMetricSeries"] : ["getTestSummary", "getMetricSeries"];
    return helper("change_over_time", {}, tools);
  }

  /* default: current status of a test/metric */
  return helper("current_status", {}, ["getTestSummary", "getDataCompleteness"]);
}
