import { describe, expect, it } from "vitest";
import { getDb } from "../db/db";
import { listMetrics } from "../db/dal";
import {
  IMPORT_BATCH_STATES,
  STAGED_SESSION_STATES,
  IngestionRevisionConflictError,
  IngestionScopeError,
  IngestionStateError,
  canTransitionImportBatch,
  canTransitionStagedSession,
  createImportBatchDraft,
  createStagedSession,
  listIngestionTransitions,
  transitionImportBatch,
  transitionStagedSession,
} from "./domain";

function fixtures() {
  const db = getDb();
  const facilities = db
    .prepare(`SELECT id FROM facility ORDER BY rowid LIMIT 2`)
    .all() as unknown as { id: string }[];
  if (facilities.length < 2) throw new Error("Phase 1 tests require the two-facility seed.");
  const source = db
    .prepare(`SELECT id FROM data_source WHERE facility_id = ? ORDER BY rowid LIMIT 1`)
    .get(facilities[0].id) as { id: string };
  const athlete = db
    .prepare(`SELECT id FROM athlete WHERE facility_id = ? ORDER BY rowid LIMIT 1`)
    .get(facilities[0].id) as { id: string };
  return { db, facilityA: facilities[0].id, facilityB: facilities[1].id, sourceId: source.id, athleteId: athlete.id };
}

describe("Ingestion Phase 1 state machines", () => {
  it("publishes the complete machine-readable batch and staged-session states", () => {
    expect(IMPORT_BATCH_STATES).toEqual([
      "draft",
      "uploading",
      "uploaded",
      "parsing",
      "mapping_required",
      "matching",
      "validating",
      "review_required",
      "ready_for_approval",
      "committing",
      "processing_downstream",
      "completed",
      "partially_completed",
      "failed",
      "cancelled",
      "superseded",
    ]);
    expect(STAGED_SESSION_STATES).toEqual([
      "unresolved",
      "needs_metadata",
      "needs_match",
      "invalid",
      "quality_limited",
      "duplicate_review",
      "ready",
      "approved",
      "committing",
      "committed",
      "rejected",
      "superseded",
    ]);
  });

  it("allows only explicit lifecycle transitions", () => {
    expect(canTransitionImportBatch("draft", "uploading")).toBe(true);
    expect(canTransitionImportBatch("draft", "completed")).toBe(false);
    expect(canTransitionImportBatch("completed", "superseded")).toBe(true);
    expect(canTransitionImportBatch("superseded", "draft")).toBe(false);
    expect(canTransitionStagedSession("unresolved", "ready")).toBe(true);
    expect(canTransitionStagedSession("unresolved", "committed")).toBe(false);
    expect(canTransitionStagedSession("ready", "approved")).toBe(true);
    expect(canTransitionStagedSession("committed", "superseded")).toBe(true);
  });
});

describe("Ingestion Phase 1 persisted lifecycle", () => {
  it("creates idempotent draft batches and replays revisioned transitions", () => {
    const { facilityA, sourceId } = fixtures();
    const key = "phase1-domain-batch-replay";
    const first = createImportBatchDraft({
      facilityId: facilityA,
      dataSourceId: sourceId,
      userId: "phase1-user",
      idempotencyKey: key,
      filename: "phase1.csv",
    });
    const replay = createImportBatchDraft({
      facilityId: facilityA,
      dataSourceId: sourceId,
      userId: "phase1-user",
      idempotencyKey: key,
      filename: "ignored-on-replay.csv",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.batch.id).toBe(first.batch.id);
    expect(first.batch.lifecycle_state).toBe("draft");
    expect(first.batch.revision).toBe(1);

    const uploading = transitionImportBatch({
      facilityId: facilityA,
      batchId: first.batch.id,
      expectedRevision: 1,
      toState: "uploading",
      userId: "phase1-user",
    });
    const uploaded = transitionImportBatch({
      facilityId: facilityA,
      batchId: first.batch.id,
      expectedRevision: 2,
      toState: "uploaded",
      userId: "phase1-user",
      reason: "Source bytes persisted",
    });
    expect(uploaded).toMatchObject({ lifecycle_state: "uploaded", revision: 3 });
    expect(
      listIngestionTransitions(facilityA, "import_batch", first.batch.id).map((row) => [
        row.from_state,
        row.to_state,
        row.revision,
      ])
    ).toEqual([
      [null, "draft", 1],
      ["draft", "uploading", 2],
      ["uploading", "uploaded", 3],
    ]);
    expect(uploading.revision).toBe(2);
  });

  it("rejects stale revisions, illegal transitions, and cross-facility access", () => {
    const { facilityA, facilityB, sourceId } = fixtures();
    const { batch } = createImportBatchDraft({
      facilityId: facilityA,
      dataSourceId: sourceId,
      idempotencyKey: "phase1-domain-conflicts",
    });
    expect(() =>
      transitionImportBatch({
        facilityId: facilityA,
        batchId: batch.id,
        expectedRevision: 1,
        toState: "completed",
      })
    ).toThrow(IngestionStateError);
    transitionImportBatch({
      facilityId: facilityA,
      batchId: batch.id,
      expectedRevision: 1,
      toState: "uploading",
    });
    expect(() =>
      transitionImportBatch({
        facilityId: facilityA,
        batchId: batch.id,
        expectedRevision: 1,
        toState: "uploaded",
      })
    ).toThrow(IngestionRevisionConflictError);
    expect(() =>
      transitionImportBatch({
        facilityId: facilityB,
        batchId: batch.id,
        expectedRevision: 2,
        toState: "uploaded",
      })
    ).toThrow(IngestionScopeError);
  });

  it("requires explicit CMJ/IMTP protocol lineage on staged sessions", () => {
    const { facilityA, sourceId, athleteId } = fixtures();
    const { batch } = createImportBatchDraft({
      facilityId: facilityA,
      dataSourceId: sourceId,
      idempotencyKey: "phase1-staged-protocol",
    });
    expect(() =>
      createStagedSession({
        facilityId: facilityA,
        batchId: batch.id,
        sourceLocator: { row: 1 },
        sourceClassification: "coach_entered_summary",
        athleteId,
        testType: "cmj",
      })
    ).toThrow(/explicit protocol identity and version/);
    expect(() =>
      createStagedSession({
        facilityId: facilityA,
        batchId: batch.id,
        sourceLocator: { row: 1 },
        sourceClassification: "coach_entered_summary",
        athleteId,
        protocolId: "tracelab.imtp",
        protocolVersion: 1,
        testType: "cmj",
      })
    ).toThrow(/does not match/);

    const staged = createStagedSession({
      facilityId: facilityA,
      batchId: batch.id,
      sourceLocator: { row: 1 },
      sourceClassification: "coach_entered_summary",
      athleteId,
      protocolId: "tracelab.cmj",
      protocolVersion: 1,
      testType: "cmj",
      setupVariant: "standard",
      sessionDatetime: "2026-07-28T16:00:00-07:00",
      timezoneName: "America/Los_Angeles",
      userId: "phase1-user",
    });
    expect(staged).toMatchObject({
      lifecycle_state: "unresolved",
      revision: 1,
      protocol_id: "tracelab.cmj",
      protocol_version: 1,
      test_type: "cmj",
    });
    const ready = transitionStagedSession({
      facilityId: facilityA,
      stagedSessionId: staged.id,
      expectedRevision: 1,
      toState: "ready",
      userId: "phase1-user",
    });
    const approved = transitionStagedSession({
      facilityId: facilityA,
      stagedSessionId: staged.id,
      expectedRevision: ready.revision,
      toState: "approved",
      userId: "phase1-user",
    });
    expect(approved).toMatchObject({ lifecycle_state: "approved", revision: 3 });
  });

  it("keeps staged metrics structurally invisible to official analytics", () => {
    const { db, facilityA, sourceId, athleteId } = fixtures();
    const { batch } = createImportBatchDraft({
      facilityId: facilityA,
      dataSourceId: sourceId,
      idempotencyKey: "phase1-staged-nondisclosure",
    });
    const staged = createStagedSession({
      facilityId: facilityA,
      batchId: batch.id,
      sourceLocator: { row: 99 },
      sourceClassification: "analyst_entered_summary",
      athleteId,
      protocolId: "tracelab.cmj",
      protocolVersion: 1,
      testType: "cmj",
    });
    const marker = 987654321.123;
    db.prepare(
      `INSERT INTO staged_metric
       (id, facility_id, staged_session_id, metric_key, side,
        original_value, original_unit, canonical_value, canonical_unit,
        verification_state, source_locator_json, created_at)
       VALUES ('phase1-hidden-metric', ?, ?, 'cmj_jump_height', 'bilateral',
               ?, 'cm', ?, 'cm', 'unverified', '{"row":99}', ?)`
    ).run(facilityA, staged.id, marker, marker, new Date().toISOString());
    expect(
      listMetrics(facilityA, athleteId, { metricType: "cmj_jump_height" }).some(
        (metric) => metric.value === marker
      )
    ).toBe(false);
  });
});
