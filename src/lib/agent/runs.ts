/**
 * Server-side agent-run records (tenancy-scoped persistence).
 * Every read takes facilityId first — a run id from another facility
 * resolves to nothing, never to data.
 */

import { getDb } from "../db/db";

export interface AgentRunRecordRow {
  run_id: string;
  facility_id: string;
  athlete_id: string;
  user_id: string | null;
  task: string;
  question: string | null;
  eval_status: string;
  mode: string;
  run_json: string;
  created_at: string;
}

export function getAgentRunRecord(facilityId: string, runId: string): AgentRunRecordRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM agent_run_record WHERE facility_id = ? AND run_id = ?`)
      .get(facilityId, runId) as AgentRunRecordRow | undefined) ?? null
  );
}

export function listAgentRunRecords(facilityId: string, athleteId?: string, limit = 50): AgentRunRecordRow[] {
  if (athleteId) {
    return getDb()
      .prepare(`SELECT * FROM agent_run_record WHERE facility_id = ? AND athlete_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(facilityId, athleteId, limit) as unknown as AgentRunRecordRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM agent_run_record WHERE facility_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(facilityId, limit) as unknown as AgentRunRecordRow[];
}
