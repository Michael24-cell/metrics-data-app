import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAthlete } from "@/lib/db/dal";
import { getDb, nowIso } from "@/lib/db/db";
import { runAgent } from "@/lib/agent/runner";
import { QUESTION_KEYS } from "@/lib/agent/schemas";
import { apiContext, isDenied, rateLimit } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

/**
 * Executes one agent run and returns the COMPLETE run snapshot (trace,
 * output, eval, provenance). Stateless by design: persistence of runs and
 * review records is client-side for this controlled demo, because route
 * handlers may restart or execute in separate instances.
 *
 * Scope: the facility comes from the controlled-demo scope cookie (not real
 * authentication) and the athlete must belong to it — the tool executor is
 * then bound server-side to exactly that athlete.
 */

const BodySchema = z
  .object({
    athleteId: z.string().min(4).max(60),
    task: z.enum(["report", "question"]),
    questionKey: z.enum(QUESTION_KEYS).optional(),
    /** free-text trainer question (V2) — used when questionKey is absent */
    question: z.string().min(3).max(500).optional(),
    /** page context the question was asked from (test/metric/window hints) */
    context: z
      .object({
        testType: z.string().max(30).optional(),
        metricKey: z.string().max(60).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .strict()
      .optional(),
    findingId: z.string().max(60).optional(),
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const ctx = await apiContext("agent.ask");
  if (isDenied(ctx)) return ctx;
  const facility = ctx.facility;
  if (!rateLimit(`agent:${ctx.user?.id ?? "demo"}:${facility.id}`, 30)) {
    return NextResponse.json({ error: "Rate limit reached — try again shortly." }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` },
      { status: 400 }
    );
  }
  const athlete = getAthlete(facility.id, parsed.data.athleteId);
  if (!athlete) {
    return NextResponse.json({ error: "Athlete not found in the current facility scope." }, { status: 404 });
  }
  try {
    const run = await runAgent({
      facilityId: facility.id,
      athleteId: athlete.id,
      athleteName: athlete.display_name,
      task: parsed.data.task,
      questionKey: parsed.data.questionKey,
      question: parsed.data.question,
      context: parsed.data.context,
      findingId: parsed.data.findingId,
      asOf: parsed.data.asOf,
    });
    // Server-side record: tenancy-scoped persistence for audit and access
    // control (the client keeps its localStorage copy for UX).
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO agent_run_record (run_id, facility_id, athlete_id, user_id, task, question, eval_status, mode, run_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(run.runId, facility.id, athlete.id, ctx.user?.id ?? null, run.task, run.question ?? run.questionKey ?? null, run.eval.status, run.mode, JSON.stringify(run), nowIso());
    recordAudit({
      facilityId: facility.id,
      userId: ctx.user?.id,
      action: "agent.question",
      resourceType: "agent_run",
      resourceId: run.runId,
      outcome: run.eval.status === "fail" ? "error" : "ok",
      versions: { prompt: run.provenance.promptVersion, tools: run.provenance.toolSchemaVersion, mode: run.mode },
      metadata: { task: run.task, toolCalls: run.provenance.toolCallCount, evalStatus: run.eval.status },
    });
    return NextResponse.json(run);
  } catch (e) {
    return NextResponse.json(
      { error: `Agent run failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
