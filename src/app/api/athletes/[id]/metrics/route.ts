import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { metricTrend } from "@/lib/services/queries";
import { listMetrics } from "@/lib/db/dal";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const metricType = p.get("metric_type");
  const range = { from: p.get("from") ?? undefined, to: p.get("to") ?? undefined };
  if (metricType) {
    // session-best trend series for one metric
    return NextResponse.json(
      metricTrend(facility.id, id, metricType, p.get("side") ?? "bilateral", range)
    );
  }
  return NextResponse.json({ metrics: listMetrics(facility.id, id, range) });
}
