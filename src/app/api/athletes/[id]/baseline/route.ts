import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { baselineSeries } from "@/lib/services/queries";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const metricType = p.get("metric_type") ?? "cmj_jump_height";
  return NextResponse.json(
    baselineSeries(facility.id, id, metricType, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
    })
  );
}
