/**
 * Live mode — real model tool-calling via the official Anthropic SDK.
 *
 * Server-only. Guarantees enforced here:
 * - the API key never leaves the server (read from env at call time);
 * - per-request timeout + a total wall-clock deadline (AbortController);
 * - hard tool-step maximum;
 * - the model finishes via a submit tool whose input is zod-validated;
 * - any failure throws LiveAgentError — the runner falls back to scripted
 *   mode and the page never crashes;
 * - the transport is injectable, so a mocked contract test exercises the
 *   full loop without network or keys.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  EvidenceRef,
  ModelAnswerSubmit,
  ModelAnswerSubmitSchema,
  ModelReportSubmit,
  ModelReportSubmitSchema,
  QuestionKey,
} from "./schemas";
import { SYSTEM_PROMPT, taskPrompt } from "./prompts";
import { ToolExecutor } from "./tools";

export const DEFAULT_LIVE_MODEL = "claude-opus-4-8";
export const MAX_TOOL_STEPS = 8;
export const REQUEST_TIMEOUT_MS = 60_000;
export const TOTAL_DEADLINE_MS = 180_000;

export class LiveAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveAgentError";
  }
}

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<Anthropic.Message>;

export interface LiveRunResult {
  submit: ModelReportSubmit | ModelAnswerSubmit;
  /** every evidence item collected from tool results, keyed by id */
  evidenceRegistry: Map<string, EvidenceRef>;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  steps: number;
}

const SUBMIT_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["executiveSummary", "claims", "confidence"],
  properties: {
    executiveSummary: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "claimType", "evidenceIds", "confidence"],
        properties: {
          text: { type: "string" },
          claimType: { type: "string", enum: ["trend", "baseline_comparison", "asymmetry", "criteria_status", "strategy_shift", "conflict", "agreement", "data_quality", "data_gap", "context", "cohort_comparison", "curve_comparison", "load_velocity_profile"] },
          metricKey: { type: "string" },
          comparisonWindow: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["high", "moderate", "low"] },
          uncertaintyReason: { type: "string" },
        },
      },
    },
    conflictingClaimIndexes: { type: "array", items: { type: "integer" } },
    coachQuestions: { type: "array", items: { type: "string" } },
    recommendedReviewAreas: { type: "array", items: { type: "string" } },
    dataQualityNotes: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "moderate", "low"] },
  },
};

const SUBMIT_ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "claims"],
  properties: {
    summary: { type: "string" },
    claims: (SUBMIT_REPORT_SCHEMA.properties as Record<string, unknown>).claims,
    directAnswer: { type: "string", description: "One- or two-sentence direct answer, shown first." },
    keyValues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: { label: { type: "string" }, value: { type: "string" }, unit: { type: "string" } },
      },
    },
    comparisonBasis: { type: "string", description: "What the answer compares against (cohort, baseline, window)." },
    limitations: { type: "array", items: { type: "string" } },
    suggestedNext: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
  },
};

export function defaultCreateMessage(): CreateMessage {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LiveAgentError("ANTHROPIC_API_KEY is not set.");
  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  return (params, signal) => client.messages.create(params, { signal });
}

export async function runLiveAgent(
  task: "report" | "question",
  executor: ToolExecutor,
  opts: {
    questionKey?: QuestionKey;
    /** free-text trainer question (V2) — used instead of questionKey */
    freeQuestion?: string;
    /** deterministic router output, passed as advisory context */
    routedHint?: string;
    createMessage?: CreateMessage;
    model?: string;
    maxSteps?: number;
    deadlineMs?: number;
    onToolCall?: (tool: string, inputSummary: string, resultSummary: string, evidenceIds: string[], ok: boolean, ms: number) => void;
  } = {}
): Promise<LiveRunResult> {
  const createMessage = opts.createMessage ?? defaultCreateMessage();
  const model = opts.model ?? process.env.AGENT_MODEL ?? DEFAULT_LIVE_MODEL;
  const maxSteps = opts.maxSteps ?? MAX_TOOL_STEPS;
  const deadline = Date.now() + (opts.deadlineMs ?? TOTAL_DEADLINE_MS);
  const abort = new AbortController();

  const submitName = task === "report" ? "submit_report" : "submit_answer";
  const tools: Anthropic.Tool[] = [
    ...executor.definitions().map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.jsonSchema as Anthropic.Tool.InputSchema,
    })),
    {
      name: submitName,
      description: `Finish the task by submitting your structured ${task === "report" ? "report" : "answer"}. Call exactly once, citing only evidence ids collected in this run.`,
      input_schema: (task === "report" ? SUBMIT_REPORT_SCHEMA : SUBMIT_ANSWER_SCHEMA) as Anthropic.Tool.InputSchema,
    },
  ];

  const evidenceRegistry = new Map<string, EvidenceRef>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: taskPrompt(task, opts.questionKey, opts.freeQuestion, opts.routedHint) },
  ];

  let steps = 0;
  let nudged = false;

  while (true) {
    if (Date.now() > deadline) {
      abort.abort();
      throw new LiveAgentError(`Deadline exceeded after ${steps} tool step(s).`);
    }
    if (steps >= maxSteps) {
      throw new LiveAgentError(`Tool-step maximum (${maxSteps}) reached without a submit call.`);
    }

    let response: Anthropic.Message;
    try {
      response = await createMessage(
        {
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          thinking: { type: "adaptive" },
          tools,
          messages,
        },
        abort.signal
      );
    } catch (e) {
      throw new LiveAgentError(`Model request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const submitBlock = toolUses.find((b) => b.name === submitName);

    if (submitBlock) {
      const schema = task === "report" ? ModelReportSubmitSchema : ModelAnswerSubmitSchema;
      const parsed = schema.safeParse(submitBlock.input);
      if (!parsed.success) {
        throw new LiveAgentError(
          `Submit payload failed structured-output validation: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
      }
      return { submit: parsed.data, evidenceRegistry, model: response.model, usage, steps };
    }

    if (toolUses.length === 0) {
      if (nudged) throw new LiveAgentError("Model ended twice without calling the submit tool.");
      nudged = true;
      steps++;
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `Call ${submitName} now with your structured output, citing only evidence ids you collected.` });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      steps++;
      const started = Date.now();
      const outcome = await executor.run(tu.name, tu.input);
      for (const e of outcome.evidence) evidenceRegistry.set(e.id, e);
      opts.onToolCall?.(
        tu.name,
        JSON.stringify(tu.input ?? {}).slice(0, 160),
        outcome.summary.slice(0, 200),
        outcome.evidence.map((e) => e.id),
        outcome.ok,
        Date.now() - started
      );
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify({ summary: outcome.summary, insufficient: outcome.insufficient ?? null, evidence: outcome.evidence, data: outcome.data }).slice(0, 12_000),
        is_error: !outcome.ok,
      });
    }
    messages.push({ role: "user", content: results });
  }
}
