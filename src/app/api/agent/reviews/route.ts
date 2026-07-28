import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiContext, isDenied } from "@/lib/authz";
import { ReviewActionSchema } from "@/lib/agent/schemas";
import { createReview } from "@/lib/agent/reviews";
import { recordAudit } from "@/lib/audit";
import { sameOriginDenied } from "@/lib/requestSecurity";

const Body = z.object({
  runId: z.string().min(4).max(80),
  action: ReviewActionSchema,
  reason: z.string().max(600).optional(),
  revisedSummary: z.string().max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "edit" && !value.revisedSummary?.trim()) {
    ctx.addIssue({ code: "custom", path: ["revisedSummary"], message: "An edit requires revised text." });
  }
});

export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ctx = await apiContext("reports.create");
  if (isDenied(ctx)) return ctx;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid review." }, { status: 400 });
  const review = createReview({
    facilityId: ctx.facility.id,
    runId: parsed.data.runId,
    userId: ctx.user?.id ?? null,
    action: parsed.data.action,
    reason: parsed.data.reason,
    revisedSummary: parsed.data.revisedSummary,
  });
  if (!review) return NextResponse.json({ error: "Run not found in the authorized facility." }, { status: 404 });
  recordAudit({
    facilityId: ctx.facility.id, userId: ctx.user?.id, action: "agent.review",
    resourceType: "agent_run", resourceId: parsed.data.runId, metadata: { reviewAction: parsed.data.action },
  });
  return NextResponse.json(review);
}
