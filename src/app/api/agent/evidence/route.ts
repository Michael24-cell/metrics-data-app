import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { getAthlete } from "@/lib/db/dal";
import { resolveEvidence } from "@/lib/agent/evidence";
import { EvidenceTypeSchema } from "@/lib/agent/schemas";

/** Evidence Explorer resolver — scoped to the current facility + athlete. */
export async function GET(req: NextRequest) {
  const facility = await currentFacility();
  const p = req.nextUrl.searchParams;
  const type = EvidenceTypeSchema.safeParse(p.get("type"));
  const id = p.get("id") ?? "";
  const athleteId = p.get("athleteId") ?? "";
  if (!type.success || !id || !athleteId || id.length > 200) {
    return NextResponse.json({ error: "type, id, and athleteId are required." }, { status: 400 });
  }
  if (!getAthlete(facility.id, athleteId)) {
    return NextResponse.json({ error: "Athlete not found in the current facility scope." }, { status: 404 });
  }
  const resolved = resolveEvidence(facility.id, athleteId, type.data, id);
  return NextResponse.json(resolved, { status: resolved.ok ? 200 : 404 });
}
