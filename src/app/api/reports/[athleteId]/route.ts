import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { buildReport } from "@/lib/services/report";

export async function GET(req: NextRequest, ctx: { params: Promise<{ athleteId: string }> }) {
  const { athleteId } = await ctx.params;
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const report = buildReport(facility.id, athleteId, {
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
  });
  if (!report) return NextResponse.json({ error: "Athlete not found in this facility." }, { status: 404 });
  return NextResponse.json(report);
}
