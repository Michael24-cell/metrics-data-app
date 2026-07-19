import { NextResponse } from "next/server";
import { apiContext, isDenied } from "@/lib/authz";
import { runMonitoringJob } from "@/lib/services/alerts";

/** Idempotent monitoring job trigger (queue/scheduler boundary in production). */
export async function POST() {
  const ctx = await apiContext("monitoring.configure");
  if (isDenied(ctx)) return ctx;
  const summary = runMonitoringJob(ctx.facility.id, ctx.user?.id ?? null);
  return NextResponse.json(summary);
}
