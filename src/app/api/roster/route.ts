import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { rosterSummary } from "@/lib/services/queries";

export async function GET(req: NextRequest) {
  const facility = await currentFacility();
  const team = req.nextUrl.searchParams.get("team") ?? undefined;
  return NextResponse.json({ facility, roster: rosterSummary(facility.id, team) });
}
