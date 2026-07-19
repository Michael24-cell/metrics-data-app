/**
 * Structured audit events (server-only).
 *
 * One append-only table for authentication, membership changes, data access,
 * agent activity, monitoring-policy changes, alert lifecycle, and exports.
 * Metadata is SAFE metadata only — never secrets, session tokens, password
 * material, or unrestricted raw model prompts.
 */

import { getDb, newId, nowIso } from "./db/db";

export interface AuditInput {
  facilityId?: string | null;
  userId?: string | null;
  action: string; // dotted verb, e.g. auth.signin, agent.question, alert.acknowledge
  resourceType?: string;
  resourceId?: string;
  outcome?: "ok" | "denied" | "error";
  versions?: Record<string, string | number>;
  metadata?: Record<string, string | number | boolean | null>;
}

export function recordAudit(e: AuditInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_event (id, facility_id, user_id, action, resource_type, resource_id, outcome, versions_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId(),
        e.facilityId ?? null,
        e.userId ?? null,
        e.action,
        e.resourceType ?? null,
        e.resourceId ?? null,
        e.outcome ?? "ok",
        e.versions ? JSON.stringify(e.versions) : null,
        e.metadata ? JSON.stringify(e.metadata) : null,
        nowIso()
      );
  } catch {
    /* auditing must never take the request down; error-monitoring hook point */
  }
}

export function listAuditEvents(facilityId: string, limit = 100) {
  return getDb()
    .prepare(`SELECT * FROM audit_event WHERE facility_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(facilityId, limit);
}
