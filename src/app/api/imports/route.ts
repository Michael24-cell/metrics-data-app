import { NextRequest, NextResponse } from "next/server";
import { currentFacility } from "@/lib/facility";
import { listImportBatches, listDataSources } from "@/lib/db/dal";
import { csvGenericAdapter, manualEntryAdapter, runImportBatch } from "@/lib/pipeline/adapters";
import { CsvInput, ManualInput } from "@/lib/pipeline/adapters";
import { apiContext, isDenied } from "@/lib/authz";
import { sameOriginDenied } from "@/lib/requestSecurity";

export async function GET() {
  const facility = await currentFacility();
  return NextResponse.json({ batches: listImportBatches(facility.id) });
}

/**
 * Runs an import through the full adapter pipeline.
 * body: { adapter: "csv_generic", input: CsvInput } |
 *       { adapter: "manual_entry", input: ManualInput } |
 *       { adapter: "csv_generic", input: CsvInput, dryRun: true }  → inspect+validate only
 */
export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ctx = await apiContext("imports.write");
  if (isDenied(ctx)) return ctx;
  const facility = ctx.facility;
  const body = (await req.json().catch(() => null)) as {
    adapter: string;
    input: CsvInput | ManualInput;
    dryRun?: boolean;
  } | null;
  if (!body || typeof body.adapter !== "string" || !body.input) {
    return NextResponse.json({ error: "adapter and input are required." }, { status: 400 });
  }

  const adapter =
    body.adapter === "csv_generic" ? csvGenericAdapter : body.adapter === "manual_entry" ? manualEntryAdapter : null;
  if (!adapter) {
    return NextResponse.json(
      { error: `Adapter '${body.adapter}' is not operational for uploads. Vendor API adapters are interface-defined only in V1.` },
      { status: 400 }
    );
  }

  if (body.dryRun) {
    // inspect + map + validate without touching the DB
    const inspect = adapter.inspect(body.input as never);
    if (!inspect.ok) return NextResponse.json({ inspect, validation: null });
    const payload = adapter.mapToCanonical(body.input as never, facility.id);
    const validation = adapter.validate(payload, facility.id);
    return NextResponse.json({ inspect, validation, sessionCount: payload.sessions.length });
  }

  const source = listDataSources(facility.id).find((s) => s.adapter_key === body.adapter);
  if (!source) return NextResponse.json({ error: "No data source configured for this adapter." }, { status: 400 });

  const result = runImportBatch(
    adapter as never,
    body.input as never,
    facility.id,
    source.id,
    body.adapter === "csv_generic" ? (body.input as CsvInput).filename : "manual entry"
  );
  return NextResponse.json(result, { status: result.status === "complete" ? 200 : 422 });
}
