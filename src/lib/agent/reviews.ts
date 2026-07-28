import { getDb, newId, nowIso } from "../db/db";
import type { ReviewAction, ReviewRecord } from "./schemas";

interface ReviewRow {
  id: string;
  run_id: string;
  action: ReviewAction;
  user_id: string | null;
  reason: string | null;
  revised_summary: string | null;
  created_at: string;
}

const toRecord = (row: ReviewRow, originalReportId: string): ReviewRecord => ({
  reviewId: row.id,
  runId: row.run_id,
  originalReportId,
  action: row.action,
  reviewer: row.user_id ?? "Demo coach",
  reason: row.reason ?? undefined,
  revisedExecutiveSummary: row.revised_summary ?? undefined,
  revisedReportId: row.revised_summary ? `${originalReportId}-${row.id}` : undefined,
  timestamp: row.created_at,
});

export function listReviews(facilityId: string, athleteId: string): ReviewRecord[] {
  const rows = getDb().prepare(
    `SELECT rv.*, ar.run_json
     FROM agent_review rv
     JOIN agent_run_record ar ON ar.run_id = rv.run_id AND ar.facility_id = rv.facility_id
     WHERE rv.facility_id = ? AND ar.athlete_id = ?
     ORDER BY rv.created_at`
  ).all(facilityId, athleteId) as unknown as (ReviewRow & { run_json: string })[];
  return rows.map((row) => {
    const run = JSON.parse(row.run_json) as { report?: { reportId?: string } };
    return toRecord(row, run.report?.reportId ?? "report");
  });
}

export function createReview(input: {
  facilityId: string;
  runId: string;
  userId: string | null;
  action: ReviewAction;
  reason?: string;
  revisedSummary?: string;
}): ReviewRecord | null {
  const run = getDb().prepare(
    `SELECT run_json FROM agent_run_record WHERE facility_id = ? AND run_id = ?`
  ).get(input.facilityId, input.runId) as { run_json: string } | undefined;
  if (!run) return null;
  const parsed = JSON.parse(run.run_json) as { report?: { reportId?: string } };
  const row: ReviewRow = {
    id: newId(),
    run_id: input.runId,
    action: input.action,
    user_id: input.userId,
    reason: input.reason ?? null,
    revised_summary: input.revisedSummary ?? null,
    created_at: nowIso(),
  };
  getDb().prepare(
    `INSERT INTO agent_review (id, facility_id, run_id, user_id, action, reason, revised_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id, input.facilityId, row.run_id, row.user_id, row.action,
    row.reason, row.revised_summary, row.created_at
  );
  return toRecord(row, parsed.report?.reportId ?? "report");
}
