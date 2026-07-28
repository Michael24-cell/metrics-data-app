/**
 * Agent runner — the honest four-stage workflow (server-only, stateless):
 *
 *   1. deterministic intake (validation, completeness, snapshot hash)
 *   2. ONE bounded, read-only Evidence Agent (scripted or live)
 *   3. deterministic post-generation evaluation (pass/warn/fail)
 *   4. human review — happens in the UI; the model never writes approval
 *
 * The route handler returns the COMPLETE AgentRun snapshot. The server-side
 * route/page boundary persists runs and reviews; browser storage is a
 * transient UI cache.
 */

import { createHash, randomUUID } from "node:crypto";
import { METRICS, ASYMMETRY_SOURCE_METRICS, BASELINE_MONITORED_METRICS } from "../config/metrics";
import { getThreshold } from "../db/dal";
import { FINDINGS_ENGINE_VERSION } from "../findings/engine";
import { buildClaim, collectDataUsed } from "./claims";
import { evaluateOutput, EvidenceResolver } from "./evals";
import { resolveEvidence } from "./evidence";
import { LiveAgentError, runLiveAgent, CreateMessage } from "./live";
import { PROMPT_VERSION } from "./prompts";
import {
  AgentAnswer,
  AgentMode,
  AgentRun,
  Claim,
  EvidenceRef,
  GeneratedReport,
  ModelAnswerSubmit,
  ModelReportSubmit,
  QuestionKey,
  QUESTION_LABELS,
  TraceStep,
} from "./schemas";
import { scriptedAnswer, scriptedReport } from "./scripted";
import { scriptedFreeform } from "./freeform";
import { buildQuerySpec, QueryTags, QuestionContext, RoutedIntent, routeQuestion } from "./intent";
import { createToolExecutor, TOOL_SCHEMA_VERSION, ToolExecutor } from "./tools";

export interface RunAgentInput {
  facilityId: string;
  athleteId: string;
  athleteName: string;
  task: "report" | "question";
  questionKey?: QuestionKey;
  /** free-text question (used when questionKey is absent) */
  question?: string;
  /** page context the question was asked from (test/metric/window hints) */
  context?: QuestionContext;
  /** explicit structured tags from the query builder (below free-text precedence) */
  tags?: QueryTags;
  /** authenticated caller, for the tool plan + audit (null in demo mode) */
  userId?: string | null;
  userRole?: string | null;
  findingId?: string;
  asOf?: string;
  /** override for tests; production resolves from env + key presence */
  modeOverride?: AgentMode;
}

export interface RunAgentDeps {
  executor?: ToolExecutor;
  resolver?: EvidenceResolver;
  createMessage?: CreateMessage;
  now?: () => string;
}

export function resolveMode(override?: AgentMode): AgentMode {
  if (override) return override;
  const envMode = process.env.AGENT_MODE as AgentMode | undefined;
  if (envMode === "live" || envMode === "scripted" || envMode === "fixture") {
    if (envMode === "live" && !process.env.ANTHROPIC_API_KEY) return "scripted";
    return envMode;
  }
  return process.env.ANTHROPIC_API_KEY ? "live" : "scripted";
}

/** Trace-recording wrapper around a tool executor. */
function withTracing(executor: ToolExecutor, trace: TraceStep[], stageOf: () => TraceStep["stage"]) {
  let step = trace.length;
  const wrapped: ToolExecutor = {
    ctx: executor.ctx,
    definitions: () => executor.definitions(),
    run: async (name, input) => {
      const started = Date.now();
      const outcome = await executor.run(name, input);
      trace.push({
        step: ++step,
        stage: stageOf(),
        tool: name,
        inputSummary: JSON.stringify(input ?? {}).slice(0, 160),
        resultSummary: outcome.summary.slice(0, 220),
        evidenceIds: outcome.evidence.map((e) => e.id),
        status: outcome.error ? "error" : outcome.insufficient ? "insufficient" : "ok",
        ms: Date.now() - started,
      });
      return outcome;
    },
  };
  return wrapped;
}

export async function runAgent(input: RunAgentInput, deps: RunAgentDeps = {}): Promise<AgentRun> {
  const startedAt = Date.now();
  const now = deps.now ?? (() => new Date().toISOString());
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const trace: TraceStep[] = [];
  let stage: TraceStep["stage"] = "intake";
  const baseExecutor =
    deps.executor ?? createToolExecutor({ facilityId: input.facilityId, athleteId: input.athleteId, asOf: input.asOf });
  const executor = withTracing(baseExecutor, trace, () => stage);
  const resolver: EvidenceResolver =
    deps.resolver ?? ((type, id) => {
      const r = resolveEvidence(input.facilityId, input.athleteId, type, id);
      return { ok: r.ok, error: r.error };
    });

  /* ---- stage 1: deterministic intake ---- */
  const overview = await executor.run("getAthleteOverview", {});
  if (!overview.ok) {
    throw new Error("Athlete not found in this facility — refusing to run.");
  }
  const completeness = await executor.run("getDataCompleteness", {});
  const snapshotBasis = JSON.stringify({
    athleteId: input.athleteId,
    facilityId: input.facilityId,
    asOf: input.asOf ?? null,
    overview: overview.data,
    completeness: completeness.data,
    toolSchema: TOOL_SCHEMA_VERSION,
    prompt: PROMPT_VERSION,
  });
  const inputSnapshotHash = createHash("sha256").update(snapshotBasis).digest("hex").slice(0, 16);

  /* ---- free-text questions: bounded intent routing (deterministic) ---- */
  const isFreeform = input.task === "question" && !!input.question && !input.questionKey;
  let routed: RoutedIntent | undefined;
  if (isFreeform) {
    const routeStarted = Date.now();
    routed = routeQuestion(input.question!, input.context ?? {}, input.tags ?? {});
    trace.push({
      step: trace.length + 1,
      stage: "intake",
      tool: "routeIntent",
      inputSummary: input.question!.slice(0, 160),
      resultSummary: `intent=${routed.kind}${routed.metricKey ? ` metric=${routed.metricKey}` : ""}${routed.cohort ? ` cohort=${routed.cohort}` : ""}${routed.clarification ? " → clarification" : ""}${routed.unsupported ? " → refused" : ""}`,
      evidenceIds: [],
      status: routed.unsupported ? "insufficient" : "ok",
      ms: Date.now() - routeStarted,
    });
  }

  /* ---- stage 2: one bounded Evidence Agent ---- */
  stage = "evidence_agent";
  let mode = resolveMode(input.modeOverride);
  // Clarifications and refusals never need a model call: force the
  // deterministic path so live mode cannot answer around the router's gate.
  if (routed?.clarification || routed?.unsupported) mode = mode === "fixture" ? "fixture" : "scripted";
  let fallback: { from: AgentMode; reason: string } | undefined;
  let provider = "deterministic";
  let model = "scripted-workflow-v1";
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  let report: GeneratedReport | undefined;
  let answer: AgentAnswer | undefined;

  const routedIntentSummary = routed
    ? { kind: routed.kind, testType: routed.testType, metricKey: routed.metricKey, cohort: routed.cohort, requiredTools: routed.requiredTools }
    : undefined;
  const querySpec = routed ? buildQuerySpec(routed) : undefined;
  const toolPlan = routed
    ? {
        version: "1.0.0" as const,
        facilityId: input.facilityId,
        userId: input.userId ?? null,
        role: input.userRole ?? null,
        tools: routed.requiredTools,
        maxCalls: 8,
        deadlineMs: 180_000,
        requiredEvidence: routed.requiredTools.map((t) => `outcome:${t}`),
        answerTemplate: routed.kind,
      }
    : undefined;

  /* clarification: return before any composing — the trainer picks a basis first */
  if (routed?.clarification) {
    return {
      runId,
      facilityId: input.facilityId,
      athleteId: input.athleteId,
      athleteName: input.athleteName,
      task: "question",
      question: input.question,
      asOf: input.asOf,
      createdAt: now(),
      mode,
      trace,
      clarification: routed.clarification,
      routedIntent: routedIntentSummary,
      querySpec,
      toolPlan,
      eval: {
        status: "pass",
        checks: [{ name: "clarification_only", status: "pass", detail: "No claims were made — the router asked for one clarification before answering, instead of silently choosing a comparison basis." }],
      },
      provenance: {
        runId,
        mode,
        provider: "deterministic",
        model: "intent-router-v1",
        promptVersion: PROMPT_VERSION,
        toolSchemaVersion: TOOL_SCHEMA_VERSION,
        inputSnapshotHash,
        methodVersions: {},
        thresholdVersions: [],
        knowledgeVersions: { intent_router: "src/lib/agent/intent.ts" },
        toolCallCount: trace.filter((t) => t.tool && t.stage !== "evaluation").length,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  const buildFromScripted = async () => {
    if (isFreeform) {
      const s = await scriptedFreeform(executor, routed!);
      answer = {
        answerId: `ans_${inputSnapshotHash}_${randomUUID().slice(0, 8)}`,
        athleteId: input.athleteId,
        facilityId: input.facilityId,
        task: "question",
        question: input.question!,
        asOf: input.asOf,
        generatedAt: now(),
        summary: s.summary,
        claims: s.claims,
        dataUsed: collectDataUsed(s.claims),
        directAnswer: s.directAnswer,
        keyValues: s.keyValues,
        comparisonBasis: s.comparisonBasis,
        limitations: s.limitations,
        suggestedNext: s.suggestedNext,
        followUps: s.followUps,
        contextUsed: s.contextUsed,
      };
      return;
    }
    if (input.task === "report") {
      const s = await scriptedReport(executor);
      report = {
        reportId: `rpt_${inputSnapshotHash}_${randomUUID().slice(0, 8)}`,
        athleteId: input.athleteId,
        facilityId: input.facilityId,
        task: "report",
        asOf: input.asOf,
        generatedAt: now(),
        executiveSummary: s.executiveSummary,
        claims: s.claims,
        conflictingSignals: s.conflictingSignals,
        coachQuestions: s.coachQuestions,
        recommendedReviewAreas: s.recommendedReviewAreas,
        dataQualityNotes: s.dataQualityNotes,
        confidence: s.confidence,
        dataUsed: collectDataUsed(s.claims),
      };
    } else {
      const s = await scriptedAnswer(executor, input.questionKey ?? "what_changed", input.findingId);
      answer = {
        answerId: `ans_${inputSnapshotHash}_${randomUUID().slice(0, 8)}`,
        athleteId: input.athleteId,
        facilityId: input.facilityId,
        task: "question",
        questionKey: input.questionKey ?? "what_changed",
        question: QUESTION_LABELS[input.questionKey ?? "what_changed"],
        asOf: input.asOf,
        generatedAt: now(),
        summary: s.summary,
        claims: s.claims,
        dataUsed: collectDataUsed(s.claims),
      };
    }
  };

  if (mode === "live") {
    try {
      const live = await runLiveAgent(input.task, executor, {
        questionKey: input.questionKey,
        freeQuestion: isFreeform ? input.question : undefined,
        routedHint: routed
          ? `Router hints (deterministic, advisory): intent=${routed.kind}${routed.testType ? `, test=${routed.testType}` : ""}${routed.metricKey ? `, metric=${routed.metricKey}` : ""}${routed.cohort ? `, cohort=${routed.cohort}` : ""}${routed.curveA ? `, curves=${routed.curveA} vs ${routed.curveB}` : ""}. Suggested tools: ${routed.requiredTools.join(", ") || "(none)"}.`
          : undefined,
        createMessage: deps.createMessage,
      });
      provider = "anthropic";
      model = live.model;
      usage = live.usage;
      const toClaims = (modelClaims: (ModelReportSubmit | ModelAnswerSubmit)["claims"]): Claim[] => {
        const out: Claim[] = [];
        for (const mc of modelClaims) {
          const refs: EvidenceRef[] = mc.evidenceIds
            .map((id) => live.evidenceRegistry.get(id))
            .filter((r): r is EvidenceRef => !!r);
          if (refs.length === 0) continue; // uncollected evidence — claim is dropped, eval guards the rest
          out.push(
            buildClaim({
              text: mc.text,
              claimType: mc.claimType,
              metricKey: mc.metricKey,
              comparisonWindow: mc.comparisonWindow,
              evidenceRefs: refs,
              confidence: mc.confidence,
              uncertaintyReason: mc.uncertaintyReason,
            })
          );
        }
        if (out.length === 0) throw new LiveAgentError("No live claim cited evidence collected in this run.");
        return out;
      };
      if (input.task === "report") {
        const sub = live.submit as ModelReportSubmit;
        const claims = toClaims(sub.claims);
        report = {
          reportId: `rpt_${inputSnapshotHash}_${randomUUID().slice(0, 8)}`,
          athleteId: input.athleteId,
          facilityId: input.facilityId,
          task: "report",
          asOf: input.asOf,
          generatedAt: now(),
          executiveSummary: sub.executiveSummary,
          claims,
          conflictingSignals: sub.conflictingClaimIndexes.map((i) => claims[i]?.claimId).filter((x): x is string => !!x),
          coachQuestions: sub.coachQuestions,
          recommendedReviewAreas: sub.recommendedReviewAreas,
          dataQualityNotes: sub.dataQualityNotes,
          confidence: sub.confidence,
          dataUsed: collectDataUsed(claims),
        };
      } else {
        const sub = live.submit as ModelAnswerSubmit;
        const claims = toClaims(sub.claims);
        answer = {
          answerId: `ans_${inputSnapshotHash}_${randomUUID().slice(0, 8)}`,
          athleteId: input.athleteId,
          facilityId: input.facilityId,
          task: "question",
          questionKey: isFreeform ? undefined : (input.questionKey ?? "what_changed"),
          question: isFreeform ? input.question! : QUESTION_LABELS[input.questionKey ?? "what_changed"],
          asOf: input.asOf,
          generatedAt: now(),
          summary: sub.summary,
          claims,
          dataUsed: collectDataUsed(claims),
          directAnswer: sub.directAnswer,
          keyValues: sub.keyValues,
          comparisonBasis: sub.comparisonBasis,
          limitations: sub.limitations,
          suggestedNext: sub.suggestedNext,
          followUps: sub.followUps,
          contextUsed: routed
            ? { testType: routed.testType, metricKey: routed.metricKey, cohort: routed.cohort }
            : undefined,
        };
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      trace.push({
        step: trace.length + 1,
        stage: "evidence_agent",
        inputSummary: "live mode",
        resultSummary: `Live agent failed safely — falling back to scripted mode. Reason: ${reason.slice(0, 180)}`,
        evidenceIds: [],
        status: "warn",
        ms: 0,
      });
      fallback = { from: "live", reason };
      mode = "scripted";
      provider = "deterministic";
      model = "scripted-workflow-v1";
      await buildFromScripted();
    }
  }
  if (mode !== "live" && !report && !answer) {
    if (mode === "fixture") {
      provider = "deterministic";
      model = "fixture-v1";
    }
    await buildFromScripted();
  }

  /* ---- stage 3: deterministic evaluation (+ one deterministic repair) ---- */
  stage = "evaluation";
  let evalResult = evaluateOutput((report ?? answer)!, resolver);
  let answerHidden: boolean | undefined;
  if (evalResult.status === "fail" && answer && isFreeform) {
    if (mode === "live") {
      // Deterministic repair: recompose from the intent-specific template
      // over trusted tool output — the model is never asked to freely retry.
      const repairStarted = Date.now();
      try {
        const s = await scriptedFreeform(executor, routed!);
        answer = {
          ...answer,
          summary: s.summary,
          claims: s.claims,
          dataUsed: collectDataUsed(s.claims),
          directAnswer: s.directAnswer,
          keyValues: s.keyValues,
          comparisonBasis: s.comparisonBasis,
          limitations: s.limitations,
          suggestedNext: s.suggestedNext,
          followUps: s.followUps,
          contextUsed: s.contextUsed,
        };
        evalResult = evaluateOutput(answer, resolver); // re-evaluate exactly once
        trace.push({
          step: trace.length + 1,
          stage: "evaluation",
          tool: "deterministicRepair",
          inputSummary: "live answer failed evaluation",
          resultSummary: `Recomposed from the '${routed!.kind}' deterministic template — re-evaluation: ${evalResult.status.toUpperCase()}`,
          evidenceIds: [],
          status: evalResult.status === "fail" ? "error" : "ok",
          ms: Date.now() - repairStarted,
        });
      } catch {
        /* repair itself failed — fall through to hiding */
      }
    }
    if (evalResult.status === "fail") answerHidden = true; // still failing → the UI hides the answer body
  }
  const output = (report ?? answer)!;
  const evalStarted = Date.now();
  trace.push({
    step: trace.length + 1,
    stage: "evaluation",
    tool: "runSafetyEvaluation",
    inputSummary: `${output.claims.length} claims, ${output.task}`,
    resultSummary: `${evalResult.status.toUpperCase()} — ${evalResult.checks.filter((c) => c.status !== "pass").map((c) => c.name).join(", ") || "all checks passed"}`,
    evidenceIds: [],
    status: evalResult.status === "fail" ? "error" : evalResult.status === "warn" ? "warn" : "ok",
    ms: Date.now() - evalStarted,
  });

  /* ---- provenance ---- */
  const methodVersions: Record<string, string> = {};
  for (const key of [...BASELINE_MONITORED_METRICS, ...ASYMMETRY_SOURCE_METRICS, "asymmetry_index"]) {
    if (METRICS[key]) methodVersions[key] = METRICS[key].methodVersion;
  }
  methodVersions["findings_engine"] = FINDINGS_ENGINE_VERSION;
  const thresholdVersions = ["asymmetry_watch_pct", "asymmetry_flag_pct"]
    .map((key) => {
      try {
        const t = getThreshold(input.facilityId, key);
        return t ? { key, version: t.version, value: t.value } : null;
      } catch {
        return null; // fixture mode without a DB
      }
    })
    .filter((x): x is { key: string; version: number; value: number } => !!x);

  return {
    runId,
    facilityId: input.facilityId,
    athleteId: input.athleteId,
    athleteName: input.athleteName,
    task: input.task,
    questionKey: input.questionKey,
    question: isFreeform ? input.question : undefined,
    asOf: input.asOf,
    createdAt: now(),
    mode,
    trace,
    report,
    answer,
    routedIntent: routedIntentSummary,
    querySpec,
    toolPlan,
    answerHidden,
    eval: evalResult,
    provenance: {
      runId,
      mode,
      provider,
      model,
      promptVersion: PROMPT_VERSION,
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      inputSnapshotHash,
      methodVersions,
      thresholdVersions,
      knowledgeVersions: {
        metric_registry: "src/lib/config/metrics.ts",
        methodology_doc: "docs/METHODOLOGY.md",
        language_policy: `prompt@${PROMPT_VERSION}`,
      },
      toolCallCount: trace.filter((t) => t.tool && t.stage !== "evaluation").length,
      latencyMs: Date.now() - startedAt,
      usage,
      fallback,
    },
  };
}
