import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { asymmetryTrend } from "@/lib/services/queries";
import { ASYMMETRY_SOURCE_METRICS } from "@/lib/config/metrics";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const source = p.get("source") ?? ASYMMETRY_SOURCE_METRICS[0];
  return NextResponse.json(
    asymmetryTrend(facility.id, id, source, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
    })
  );
}
