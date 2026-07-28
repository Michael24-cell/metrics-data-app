import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiContext, isDenied, withIdempotency } from "@/lib/authz";
import { listAlerts, transitionAlert, AlertStatus } from "@/lib/services/alerts";
import { sameOriginDenied } from "@/lib/requestSecurity";

export async function GET(req: NextRequest) {
  const ctx = await apiContext("athletes.view");
  if (isDenied(ctx)) return ctx;
  const p = req.nextUrl.searchParams;
  const status = p.get("status") as AlertStatus | null;
  return NextResponse.json(
    listAlerts(ctx.facility.id, {
      status: status && ["new", "acknowledged", "resolved", "dismissed"].includes(status) ? status : undefined,
      athleteId: p.get("athlete") ?? undefined,
    })
  );
}

const Body = z
  .object({
    alertId: z.string().min(4).max(60),
    action: z.enum(["acknowledge", "resolve", "dismiss", "note"]),
    reason: z.string().max(400).optional(),
    note: z.string().max(600).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ctx = await apiContext("alerts.acknowledge"); // read-only + analyst are denied here
  if (isDenied(ctx)) return ctx;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "alertId and a valid action are required." }, { status: 400 });
  const { alertId, action, reason, note } = parsed.data;
  // idempotent: the same user repeating the same transition replays the result
  const { result } = await withIdempotency(
    `${ctx.facility.id}:${ctx.user?.id ?? "demo"}:alert:${alertId}:${action}:${reason ?? ""}:${note ?? ""}`,
    () => transitionAlert(ctx.facility.id, alertId, action, ctx.user?.id ?? null, { reason, note })
  );
  if ("error" in (result as object)) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
