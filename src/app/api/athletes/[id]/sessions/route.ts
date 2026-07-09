import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { listSessions } from "@/lib/db/dal";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const sessions = listSessions(facility.id, id, {
    testType: p.get("test_type") ?? undefined,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
  });
  return NextResponse.json({ sessions });
}
