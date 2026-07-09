import { NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { getImportBatch } from "@/lib/db/dal";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const facility = await currentFacility();
  const batch = getImportBatch(facility.id, id);
  if (!batch) return NextResponse.json({ error: "Import batch not found in this facility." }, { status: 404 });
  return NextResponse.json(batch);
}
