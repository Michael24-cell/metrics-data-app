/**
 * Athlete Intelligence Agent — typed contracts (client-safe, no node deps).
 *
 * Everything the agent produces is structured and evidence-bound:
 * - Claim: one substantive statement + the evidence refs that ground it.
 * - GeneratedReport / AgentAnswer: the agent's only output shapes.
 * - ReviewRecord: human review state, stored SEPARATELY from generated
 *   output (the model never writes its own approval state). For this
 *   controlled demo, runs and reviews persist in the browser
 *   (localStorage) — route handlers stay stateless.
 */

import { z } from "zod";

export const AGENT_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export const EvidenceTypeSchema = z.enum([
  "metric_series", // a session-best series window for one metric
  "metric_value", // one metric row
  "session", // a test session
  "finding", // a deterministic findings-engine row
  "criterion", // one progression criterion evidence item
  "threshold", // a facility threshold_setting row
  "methodology", // a metric registry entry (formula/version)
  "note", // practitioner-entered note (untrusted text, quoted only)
  "training_session", // training context row
  "baseline", // reference or recent baseline computation
  "comparability", // a comparability-gate result for a window
  "quality", // data completeness / quality snapshot
  "cohort", // team/position cohort statistics (population SD contract)
  "curve", // a prepared force-time curve or deterministic curve comparison
  "lv_profile", // a live load-velocity profile rebuilt from stored reps
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceRefSchema = z.object({
  /** stable id, resolvable via /api/agent/evidence */
  id: z.string().min(1).max(200),
  type: EvidenceTypeSchema,
  label: z.string().max(300).optional(),
  date: z.string().max(20).optional(),
  value: z.number().optional(),
  /** every number a claim may cite from this evidence (incl. bands, targets, counts) */
  values: z.array(z.number()).max(40).optional(),
  unit: z.string().max(30).optional(),
  methodVersion: z.string().max(60).optional(),
  thresholdVersion: z.number().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export const ClaimTypeSchema = z.enum([
  "trend",
  "baseline_comparison",
  "asymmetry",
  "criteria_status",
  "strategy_shift",
  "conflict",
  "agreement",
  "data_quality",
  "data_gap",
  "context",
  "cohort_comparison", // team/position standing under the cohort contract
  "curve_comparison", // deterministic prepared-curve comparison
  "load_velocity_profile", // live-rebuilt L-V profile statement
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ConfidenceSchema = z.enum(["high", "moderate", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ClaimSchema = z.object({
  /** deterministic: derived from type + metric + window + sorted evidence ids */
  claimId: z.string().min(6).max(64),
  text: z.string().min(1).max(600),
  claimType: ClaimTypeSchema,
  metricKey: z.string().max(60).optional(),
  /** e.g. "2026-03-09..2026-07-06" or "latest-vs-reference" */
  comparisonWindow: z.string().max(80).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1).max(20),
  confidence: ConfidenceSchema,
  uncertaintyReason: z.string().max(300).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export const GeneratedReportSchema = z.object({
  reportId: z.string(),
  athleteId: z.string(),
  facilityId: z.string(),
  task: z.literal("report"),
  asOf: z.string().optional(),
  generatedAt: z.string(),
  executiveSummary: z.string().min(1).max(2000),
  claims: z.array(ClaimSchema).min(1).max(24),
  /** claimIds of claims that disagree with each other */
  conflictingSignals: z.array(z.string()).max(24),
  coachQuestions: z.array(z.string().max(300)).max(8),
  recommendedReviewAreas: z.array(z.string().max(300)).max(8),
  dataQualityNotes: z.array(z.string().max(400)).max(8),
  confidence: ConfidenceSchema,
  dataUsed: z.array(EvidenceRefSchema).max(80),
});
export type GeneratedReport = z.infer<typeof GeneratedReportSchema>;

export const QUESTION_KEYS = [
  "what_changed",
  "why_finding",
  "agreeing_signals",
  "conflicting_signals",
  "missing_info",
  "review_next",
  "baseline_comparison",
] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

export const QUESTION_LABELS: Record<QuestionKey, string> = {
  what_changed: "What changed since the previous comparable session?",
  why_finding: "Why was this finding generated?",
  agreeing_signals: "Which signals agree right now?",
  conflicting_signals: "Which signals conflict right now?",
  missing_info: "What information is missing?",
  review_next: "What should the coach review next?",
  baseline_comparison: "How does the current session compare with the reference baseline and the recent baseline?",
};

/** one headline number in a V2 answer — value is preformatted display text */
export const KeyValueSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(60),
  unit: z.string().max(20).optional(),
});
export type KeyValue = z.infer<typeof KeyValueSchema>;

/** the scope an answer was computed over — shown to the trainer, editable via re-ask */
export const AnswerContextSchema = z.object({
  testType: z.string().max(30).optional(),
  metricKey: z.string().max(60).optional(),
  window: z.string().max(60).optional(),
  cohort: z.enum(["team", "position"]).optional(),
  comparison: z.string().max(120).optional(),
});
export type AnswerContext = z.infer<typeof AnswerContextSchema>;

export const AgentAnswerSchema = z.object({
  answerId: z.string(),
  athleteId: z.string(),
  facilityId: z.string(),
  task: z.literal("question"),
  /** set for the seven guided questions; free-text questions carry only `question` */
  questionKey: z.enum(QUESTION_KEYS).optional(),
  question: z.string(),
  asOf: z.string().optional(),
  generatedAt: z.string(),
  summary: z.string().min(1).max(1500),
  claims: z.array(ClaimSchema).min(1).max(12),
  dataUsed: z.array(EvidenceRefSchema).max(60),
  /* ---- V2 answer contract (optional so guided-question answers stay valid) ---- */
  /** one- or two-sentence direct answer, shown first */
  directAnswer: z.string().max(400).optional(),
  keyValues: z.array(KeyValueSchema).max(8).optional(),
  comparisonBasis: z.string().max(200).optional(),
  limitations: z.array(z.string().max(300)).max(6).optional(),
  suggestedNext: z.array(z.string().max(200)).max(4).optional(),
  followUps: z.array(z.string().max(160)).max(4).optional(),
  contextUsed: AnswerContextSchema.optional(),
});
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

/** returned instead of an answer when a materially answer-changing basis is ambiguous */
export interface ClarificationRequest {
  question: string;
  options: { label: string; question: string }[];
}

/* ------------------------------------------------------------------ */
/* Report diff (use case C)                                            */
/* ------------------------------------------------------------------ */

export interface ClaimChange {
  identityKey: string;
  before: Claim;
  after: Claim;
  textChanged: boolean;
  confidenceChanged: boolean;
  newEvidence: EvidenceRef[];
  droppedEvidence: EvidenceRef[];
}

export interface ReportDiff {
  fromReportId: string;
  toReportId: string;
  added: Claim[];
  removed: Claim[];
  changed: ClaimChange[];
  confidenceShift: { from: Confidence; to: Confidence } | null;
  summaryText: string;
}

/* ------------------------------------------------------------------ */
/* Trace / eval / provenance / run                                     */
/* ------------------------------------------------------------------ */

export type WorkflowStage = "intake" | "evidence_agent" | "evaluation";

export interface TraceStep {
  step: number;
  stage: WorkflowStage;
  tool?: string;
  inputSummary: string;
  resultSummary: string;
  evidenceIds: string[];
  status: "ok" | "insufficient" | "error" | "warn";
  ms: number;
}

export interface EvalCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface EvalResult {
  status: "pass" | "warn" | "fail";
  checks: EvalCheck[];
}

export type AgentMode = "fixture" | "scripted" | "live";

export interface Provenance {
  runId: string;
  mode: AgentMode;
  provider: string; // "deterministic" | "anthropic"
  model: string; // "scripted-v1" or the real model id
  promptVersion: string;
  toolSchemaVersion: string;
  inputSnapshotHash: string;
  methodVersions: Record<string, string>;
  thresholdVersions: { key: string; version: number; value: number }[];
  knowledgeVersions: Record<string, string>;
  toolCallCount: number;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  /** set when live mode failed and the run fell back to scripted */
  fallback?: { from: AgentMode; reason: string };
}

export interface AgentRun {
  runId: string;
  facilityId: string;
  athleteId: string;
  athleteName: string;
  task: "report" | "question";
  questionKey?: QuestionKey;
  /** free-text question, when this run answered one */
  question?: string;
  asOf?: string;
  createdAt: string;
  mode: AgentMode;
  trace: TraceStep[];
  report?: GeneratedReport;
  answer?: AgentAnswer;
  /** set instead of answer when the router needs one clarification first */
  clarification?: ClarificationRequest;
  /** router output for the Developer/Audit view (never shown in trainer UI) */
  routedIntent?: { kind: string; testType?: string; metricKey?: string; cohort?: string; requiredTools: string[] };
  /** versioned resolved-query contract (field-level value/confidence/provenance) */
  querySpec?: unknown; // QuerySpecV1 — typed in intent.ts (kept loose here to stay client-safe)
  /** bounded tool plan (Developer/Audit view only) */
  toolPlan?: ToolPlanV1;
  /** true when evaluation failed after deterministic repair — UI must hide the answer body */
  answerHidden?: boolean;
  eval: EvalResult;
  provenance: Provenance;
}

export interface ToolPlanV1 {
  version: "1.0.0";
  facilityId: string;
  userId: string | null;
  role: string | null;
  /** ordered tools the plan expects (advisory in live mode, exact in scripted) */
  tools: string[];
  maxCalls: number;
  deadlineMs: number;
  requiredEvidence: string[];
  answerTemplate: string; // the intent-specific deterministic template key
}

/* ------------------------------------------------------------------ */
/* Human review (client-persisted; original output preserved)          */
/* ------------------------------------------------------------------ */

export const ReviewActionSchema = z.enum(["approve", "edit", "reject", "needs_more_data"]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

export interface ReviewRecord {
  reviewId: string;
  runId: string;
  originalReportId: string;
  action: ReviewAction;
  reviewer: string; // free-text label in this demo
  reason?: string;
  /** for edit: the reviewer's revised summary text; the original report object is never mutated */
  revisedExecutiveSummary?: string;
  revisedReportId?: string;
  timestamp: string;
}

/* ------------------------------------------------------------------ */
/* Live-model submit shape (model output BEFORE server post-processing) */
/* — the model never assigns claim IDs and never references evidence it */
/*   didn't collect: it cites evidence by id from prior tool results.   */
/* ------------------------------------------------------------------ */

export const ModelClaimSchema = z.object({
  text: z.string().min(1).max(600),
  claimType: ClaimTypeSchema,
  metricKey: z.string().max(60).optional(),
  comparisonWindow: z.string().max(80).optional(),
  evidenceIds: z.array(z.string().max(200)).min(1).max(20),
  confidence: ConfidenceSchema,
  uncertaintyReason: z.string().max(300).optional(),
});

export const ModelReportSubmitSchema = z.object({
  executiveSummary: z.string().min(1).max(2000),
  claims: z.array(ModelClaimSchema).min(1).max(24),
  conflictingClaimIndexes: z.array(z.number().int().min(0)).max(24).default([]),
  coachQuestions: z.array(z.string().max(300)).max(8).default([]),
  recommendedReviewAreas: z.array(z.string().max(300)).max(8).default([]),
  dataQualityNotes: z.array(z.string().max(400)).max(8).default([]),
  confidence: ConfidenceSchema,
});
export type ModelReportSubmit = z.infer<typeof ModelReportSubmitSchema>;

export const ModelAnswerSubmitSchema = z.object({
  summary: z.string().min(1).max(1500),
  claims: z.array(ModelClaimSchema).min(1).max(12),
  /* V2 answer contract (optional; post-processed into the typed answer) */
  directAnswer: z.string().max(400).optional(),
  keyValues: z.array(KeyValueSchema).max(8).optional(),
  comparisonBasis: z.string().max(200).optional(),
  limitations: z.array(z.string().max(300)).max(6).optional(),
  suggestedNext: z.array(z.string().max(200)).max(4).optional(),
  followUps: z.array(z.string().max(160)).max(4).optional(),
});
export type ModelAnswerSubmit = z.infer<typeof ModelAnswerSubmitSchema>;
