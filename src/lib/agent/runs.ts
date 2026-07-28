/**
 * Server-side agent-run records (tenancy-scoped persistence).
 * Every read takes facilityId first — a run id from another facility
 * resolves to nothing, never to data.
 */

import { getDb, nowIso } from "../db/db";
import type { AgentRun } from "./schemas";

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

export function saveAgentRunRecord(run: AgentRun, userId: string | null = null): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_run_record
       (run_id, facility_id, athlete_id, user_id, task, question, eval_status, mode, run_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.runId, run.facilityId, run.athleteId, userId, run.task,
      run.question ?? run.questionKey ?? null, run.eval.status, run.mode, JSON.stringify(run), nowIso()
    );
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
