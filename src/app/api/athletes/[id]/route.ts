import { NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { athleteDetail } from "@/lib/services/queries";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const detail = athleteDetail(facility.id, id);
  if (!detail) return NextResponse.json({ error: "Athlete not found in this facility." }, { status: 404 });
  return NextResponse.json(detail);
}
