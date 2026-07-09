import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { findingsWithAnnotations } from "@/lib/services/queries";

export async function GET(req: NextRequest) {
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const findings = findingsWithAnnotations(
    facility.id,
    p.get("athlete_id") ?? undefined,
    p.get("limit") ? Number(p.get("limit")) : undefined
  );
  return NextResponse.json({ findings });
}
