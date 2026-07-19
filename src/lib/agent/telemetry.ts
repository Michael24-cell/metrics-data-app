/**
 * Agent telemetry — derived from tenancy-scoped run records and feedback.
 * Tracked here: completion / clarification / refusal / evaluation-failure /
 * hidden-answer rates, tag-vs-free-text mix, latency p50/p95, helpful rate.
 * Cost, follow-up usage, and evidence-open rate come from run provenance and
 * client events as they are recorded.
 */

import { getDb } from "../db/db";

export function agentTelemetry(facilityId: string) {
  const runs = getDb()
    .prepare(`SELECT run_json FROM agent_run_record WHERE facility_id = ?`)
    .all(facilityId) as { run_json: string }[];
  const parsed = runs.map((r) => JSON.parse(r.run_json) as {
    eval?: { status?: string };
    clarification?: unknown;
    answerHidden?: boolean;
    routedIntent?: { kind?: string };
    provenance?: { latencyMs?: number };
  });
  const latencies = parsed.map((p) => p.provenance?.latencyMs ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const pct = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null);
  const fb = getDb()
    .prepare(`SELECT rating, COUNT(*) c FROM agent_feedback WHERE facility_id = ? GROUP BY rating`)
    .all(facilityId) as { rating: string; c: number }[];
  const fbTotal = fb.reduce((a, r) => a + r.c, 0);
  return {
    runs: parsed.length,
    completed: parsed.filter((p) => p.eval?.status === "pass" || p.eval?.status === "warn").length,
    clarifications: parsed.filter((p) => !!p.clarification).length,
    refusals: parsed.filter((p) => p.routedIntent?.kind === "unsupported").length,
    evalFailures: parsed.filter((p) => p.eval?.status === "fail").length,
    hiddenAnswers: parsed.filter((p) => p.answerHidden).length,
    latencyP50Ms: pct(0.5),
    latencyP95Ms: pct(0.95),
    feedback: Object.fromEntries(fb.map((r) => [r.rating, r.c])),
    helpfulRate: fbTotal ? (fb.find((r) => r.rating === "helpful")?.c ?? 0) / fbTotal : null,
  };
}
