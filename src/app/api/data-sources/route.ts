import { NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { listDataSources, listDevices } from "@/lib/db/dal";

export async function GET() {
  const facility = await currentFacility();
  return NextResponse.json({
    dataSources: listDataSources(facility.id),
    devices: listDevices(facility.id),
  });
}
