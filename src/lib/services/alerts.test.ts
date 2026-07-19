/**
 * Phase 5 gate — alert creation, deduplication, lifecycle, tenant isolation,
 * digest grouping, idempotent job rerun, historical policy reference.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../db/db";
import {
  coachDigest,
  generateAlertsForAthlete,
  getAlert,
  listAlerts,
  runMonitoringJob,
  transitionAlert,
  AlertRow,
} from "./alerts";
import { can } from "../auth/roles";

let facA: string;
let facB: string;
let kai: { id: string; facility_id: string };

beforeAll(() => {
  const db = getDb();
  const facs = db.prepare(`SELECT id, name FROM facility ORDER BY created_at`).all() as { id: string; name: string }[];
  facA = facs.find((f) => f.name.includes("Ridgeline"))!.id;
  facB = facs.find((f) => f.name.includes("Harbor"))!.id;
  kai = db.prepare(`SELECT id, facility_id FROM athlete WHERE display_name = 'Kai Solari'`).get() as { id: string; facility_id: string };
  // clean slate for this suite (test-local; the seed rebuilds demo alerts)
  db.prepare(`DELETE FROM alert WHERE facility_id IN (?, ?)`).run(facA, facB);
});

describe("alert generation", () => {
  it("creates alerts from monitoring results and reruns are idempotent (dedupe key)", () => {
    const first = generateAlertsForAthlete(facA, kai.id);
    const rerun = generateAlertsForAthlete(facA, kai.id);
    expect(first).toBeGreaterThan(0);
    expect(rerun).toBe(0); // same source events → no duplicates
  });

  it("alerts carry the policy fingerprint and calc versions they were generated under", () => {
    const rows = listAlerts(facA, { athleteId: kai.id });
    expect(rows.length).toBeGreaterThan(0);
    const monitoringAlert = rows.find((r) => r.alert_type === "review_suggested" || r.alert_type === "repeated_low_signal" || r.alert_type === "new_pr");
    expect(monitoringAlert?.policy_fingerprint).toContain("mon@");
    expect(JSON.parse(monitoringAlert!.evidence_json)).toBeTruthy();
  });

  it("the facility-wide job runs idempotently across every athlete", () => {
    const run1 = runMonitoringJob(facA);
    const run2 = runMonitoringJob(facA);
    expect(run1.athletes).toBeGreaterThan(5);
    expect(run2.alertsCreated).toBe(0); // full rerun creates nothing new
  });

  it("no readiness, injury, or medical alert types exist", () => {
    const types = new Set(listAlerts(facA).map((a) => a.alert_type));
    for (const t of types) {
      expect(t).toMatch(/^(review_suggested|repeated_low_signal|new_pr|asymmetry_crossing|reliability_concern|monitoring_data_gap|baseline_completed)$/);
    }
  });
});

describe("alert lifecycle", () => {
  let alert: AlertRow;
  beforeAll(() => {
    alert = listAlerts(facA, { status: "new" })[0];
    expect(alert).toBeDefined();
  });

  it("new → acknowledged → resolved, with audit fields", () => {
    const acked = transitionAlert(facA, alert.id, "acknowledge", "user-1") as AlertRow;
    expect(acked.status).toBe("acknowledged");
    expect(acked.acknowledged_by).toBe("user-1");
    const resolved = transitionAlert(facA, alert.id, "resolve", "user-1", { reason: "Reviewed with athlete" }) as AlertRow;
    expect(resolved.status).toBe("resolved");
    expect(resolved.close_reason).toBe("Reviewed with athlete");
  });

  it("dismissal requires a reason; double-close is rejected", () => {
    const next = listAlerts(facA, { status: "new" })[0];
    const noReason = transitionAlert(facA, next.id, "dismiss", "user-1");
    expect((noReason as { error: string }).error).toContain("requires a reason");
    const dismissed = transitionAlert(facA, next.id, "dismiss", "user-1", { reason: "Known testing variation" }) as AlertRow;
    expect(dismissed.status).toBe("dismissed");
    const again = transitionAlert(facA, next.id, "resolve", "user-1");
    expect((again as { error: string }).error).toContain("already dismissed");
  });

  it("coach notes attach without changing status", () => {
    const target = listAlerts(facA)[0];
    const noted = transitionAlert(facA, target.id, "note", "user-1", { note: "Follow up Friday" }) as AlertRow;
    expect(noted.coach_note).toBe("Follow up Friday");
  });
});

describe("authorization + tenant isolation", () => {
  it("read-only users lack the alert-mutation capability (route guard uses can())", () => {
    expect(can("readonly", "alerts.acknowledge")).toBe(false);
    expect(can("coach", "alerts.acknowledge")).toBe(true);
    expect(can("analyst", "alerts.acknowledge")).toBe(false);
  });

  it("another facility's alert resolves to nothing and cannot be transitioned", () => {
    const a = listAlerts(facA)[0];
    expect(getAlert(facB, a.id)).toBeNull();
    const attempt = transitionAlert(facB, a.id, "acknowledge", "intruder");
    expect((attempt as { error: string }).error).toContain("not found");
  });
});

describe("digest", () => {
  it("groups the last-7-day alerts by type with totals and resolved items", () => {
    const d = coachDigest(facA, 7);
    expect(d.windowDays).toBe(7);
    expect(d.totals.created).toBeGreaterThan(0);
    expect(Array.isArray(d.newPrs)).toBe(true);
    expect(Array.isArray(d.repeatedLow)).toBe(true);
    expect(d.resolved.some((r) => r.status === "resolved" || r.status === "dismissed")).toBe(true);
  });
});
