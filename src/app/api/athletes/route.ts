import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { listAthletes } from "@/lib/db/dal";

export async function GET(req: NextRequest) {
  const facility = await currentFacility();
  const team = req.nextUrl.searchParams.get("team") ?? undefined;
  return NextResponse.json({ athletes: listAthletes(facility.id, team) });
}
