import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiContext, isDenied } from "@/lib/authz";
import { getAgentRunRecord } from "@/lib/agent/runs";
import { getDb, newId, nowIso } from "@/lib/db/db";
import { recordAudit } from "@/lib/audit";
import { sameOriginDenied } from "@/lib/requestSecurity";

const RATINGS = ["helpful", "not_what_i_asked", "wrong_context", "too_technical", "missing_option"] as const;
const Body = z.object({ runId: z.string().min(4).max(80), rating: z.enum(RATINGS) }).strict();

/** Structured feedback on one agent answer — tenancy-scoped, duplicate-safe. */
export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ctx = await apiContext("agent.ask");
  if (isDenied(ctx)) return ctx;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "runId and a valid rating are required." }, { status: 400 });
  const record = getAgentRunRecord(ctx.facility.id, parsed.data.runId);
  if (!record) return NextResponse.json({ error: "Run not found in the authorized facility." }, { status: 404 });
  const run = JSON.parse(record.run_json) as { querySpec?: { version?: string }; provenance?: { latencyMs?: number } };
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_feedback (id, facility_id, run_id, user_id, rating, query_version, answer_mode, eval_status, latency_ms, user_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(), ctx.facility.id, record.run_id, ctx.user?.id ?? null, parsed.data.rating,
      run.querySpec?.version ?? null, record.mode, record.eval_status,
      run.provenance?.latencyMs ?? null, ctx.role, nowIso()
    );
  recordAudit({ facilityId: ctx.facility.id, userId: ctx.user?.id, action: "agent.feedback", resourceType: "agent_run", resourceId: record.run_id, metadata: { rating: parsed.data.rating } });
  return NextResponse.json({ ok: true });
}
