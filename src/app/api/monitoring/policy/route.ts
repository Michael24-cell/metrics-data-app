import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiContext, isDenied, assertAthleteInFacility, AuthzError } from "@/lib/authz";
import { savePolicyLayer, effectivePolicy } from "@/lib/services/monitoringPolicy";
import { evaluateAthlete } from "@/lib/services/monitoringEngine";
import { recordAudit } from "@/lib/audit";
import { STAT_POLICIES } from "@/lib/config/statPolicies";
import { sameOriginDenied } from "@/lib/requestSecurity";

const Overrides = z
  .object({
    baselineSessions: z.union([z.literal(15), z.literal(30)]).optional(),
    rollingWindow: z.union([z.literal(5), z.literal(7), z.literal(10)]).optional(),
    noiseGate: z.enum(["te", "mdc", "swc", "none"]).optional(),
    bandSdMultiplier: z.number().min(0.5).max(3).optional(),
    consecutiveLowCount: z.number().int().min(2).max(5).optional(),
    requireReliabilityEligible: z.boolean().optional(),
    metricKeys: z.array(z.string().max(60)).max(40).optional(),
  })
  .strict();

const Body = z
  .object({
    scope: z.enum(["facility", "coach", "athlete"]),
    athleteId: z.string().max(60).optional(),
    overrides: Overrides,
  })
  .strict();

export async function POST(req: NextRequest) {
  const originDenied = sameOriginDenied(req);
  if (originDenied) return originDenied;
  const ctx = await apiContext("monitoring.configure");
  if (isDenied(ctx)) return ctx;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }, { status: 400 });
  }
  const { scope, athleteId, overrides } = parsed.data;
  // metric selection: only registered, monitoring-eligible metrics
  if (overrides.metricKeys) {
    const bad = overrides.metricKeys.filter((k) => !STAT_POLICIES[k]);
    if (bad.length) return NextResponse.json({ error: `Not monitoring-eligible: ${bad.join(", ")}` }, { status: 400 });
    if (overrides.metricKeys.length === 0) return NextResponse.json({ error: "Select at least one metric." }, { status: 400 });
  }
  if (scope === "athlete") {
    if (!athleteId) return NextResponse.json({ error: "athleteId required for athlete overrides." }, { status: 400 });
    try {
      assertAthleteInFacility(ctx, athleteId);
    } catch (e) {
      if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
  const layer = savePolicyLayer(ctx.facility.id, scope, overrides, {
    athleteId,
    coachUserId: scope === "coach" ? (ctx.user?.id ?? undefined) : undefined,
    createdBy: ctx.user?.id ?? null,
  });
  recordAudit({
    facilityId: ctx.facility.id,
    userId: ctx.user?.id,
    action: scope === "athlete" ? "monitoring.override_saved" : "monitoring.policy_saved",
    resourceType: "monitoring_policy",
    resourceId: athleteId ?? scope,
    versions: { layerVersion: layer.version },
    metadata: { scope },
  });
  // recompute for the affected athlete under the NEW policy version (old results preserved)
  if (scope === "athlete" && athleteId) {
    const summary = evaluateAthlete(ctx.facility.id, athleteId, ctx.user?.id);
    recordAudit({ facilityId: ctx.facility.id, userId: ctx.user?.id, action: "monitoring.recompute", resourceType: "athlete", resourceId: athleteId, versions: { fingerprint: summary.effective.fingerprint } });
  }
  return NextResponse.json({ ok: true, layer, effective: athleteId ? effectivePolicy(ctx.facility.id, athleteId, ctx.user?.id) : undefined });
}
