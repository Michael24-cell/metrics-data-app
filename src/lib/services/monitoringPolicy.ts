/**
 * Monitoring policy hierarchy — product default ← facility template ←
 * coach template ← athlete override. Every layer is versioned; saving a
 * change writes a NEW active row (old rows preserved), so historical
 * results always reference the exact policy they were generated with.
 */

import { getDb, newId, nowIso } from "../db/db";
import {
  mergePolicyLayers,
  MonitoringPolicyV1,
  policyFingerprint,
  PRODUCT_DEFAULT_POLICY,
} from "../calc/monitoring";

export interface PolicyLayer {
  scope: "facility" | "coach" | "athlete";
  version: number;
  overrides: Partial<MonitoringPolicyV1>;
}

export interface EffectivePolicy {
  policy: MonitoringPolicyV1;
  layers: PolicyLayer[];
  fingerprint: string;
}

interface PolicyRow {
  id: string;
  scope: string;
  version: number;
  config_json: string;
}

function activeRow(facilityId: string, scope: "facility" | "coach" | "athlete", target?: string): PolicyRow | undefined {
  const db = getDb();
  if (scope === "facility") {
    return db
      .prepare(`SELECT id, scope, version, config_json FROM monitoring_policy WHERE facility_id = ? AND scope = 'facility' AND active = 1`)
      .get(facilityId) as PolicyRow | undefined;
  }
  const col = scope === "coach" ? "coach_user_id" : "athlete_id";
  return db
    .prepare(`SELECT id, scope, version, config_json FROM monitoring_policy WHERE facility_id = ? AND scope = ? AND ${col} = ? AND active = 1`)
    .get(facilityId, scope, target ?? "") as PolicyRow | undefined;
}

/** Resolve the effective policy with full layer traceability. */
export function effectivePolicy(facilityId: string, athleteId: string, coachUserId?: string | null): EffectivePolicy {
  const layers: PolicyLayer[] = [];
  const partials: Partial<MonitoringPolicyV1>[] = [];
  const facilityRow = activeRow(facilityId, "facility");
  if (facilityRow) {
    const overrides = JSON.parse(facilityRow.config_json) as Partial<MonitoringPolicyV1>;
    layers.push({ scope: "facility", version: facilityRow.version, overrides });
    partials.push(overrides);
  }
  if (coachUserId) {
    const coachRow = activeRow(facilityId, "coach", coachUserId);
    if (coachRow) {
      const overrides = JSON.parse(coachRow.config_json) as Partial<MonitoringPolicyV1>;
      layers.push({ scope: "coach", version: coachRow.version, overrides });
      partials.push(overrides);
    }
  }
  const athleteRow = activeRow(facilityId, "athlete", athleteId);
  if (athleteRow) {
    const overrides = JSON.parse(athleteRow.config_json) as Partial<MonitoringPolicyV1>;
    layers.push({ scope: "athlete", version: athleteRow.version, overrides });
    partials.push(overrides);
  }
  const policy = mergePolicyLayers(partials);
  return { policy, layers, fingerprint: policyFingerprint(policy, layers.map((l) => ({ scope: l.scope, version: l.version }))) };
}

/** Save a policy layer: deactivates the previous row and writes version+1. */
export function savePolicyLayer(
  facilityId: string,
  scope: "facility" | "coach" | "athlete",
  overrides: Partial<MonitoringPolicyV1>,
  opts: { coachUserId?: string; athleteId?: string; createdBy?: string | null } = {}
): PolicyLayer {
  const db = getDb();
  const target = scope === "coach" ? opts.coachUserId : scope === "athlete" ? opts.athleteId : undefined;
  const prev = activeRow(facilityId, scope, target);
  const version = (prev?.version ?? 0) + 1;
  if (prev) db.prepare(`UPDATE monitoring_policy SET active = 0 WHERE id = ?`).run(prev.id);
  db.prepare(
    `INSERT INTO monitoring_policy (id, facility_id, scope, coach_user_id, athlete_id, version, config_json, created_by, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    newId(), facilityId, scope,
    scope === "coach" ? (opts.coachUserId ?? null) : null,
    scope === "athlete" ? (opts.athleteId ?? null) : null,
    version, JSON.stringify(overrides), opts.createdBy ?? null, nowIso()
  );
  return { scope, version, overrides };
}

export { PRODUCT_DEFAULT_POLICY };
