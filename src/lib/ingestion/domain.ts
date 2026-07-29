import { getDb, newId, nowIso } from "../db/db";
import { getProtocol, protocolForTestType } from "../protocols/registry";

export const IMPORT_BATCH_STATES = [
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
] as const;
export type ImportBatchState = (typeof IMPORT_BATCH_STATES)[number];

export const STAGED_SESSION_STATES = [
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
] as const;
export type StagedSessionState = (typeof STAGED_SESSION_STATES)[number];

export const SOURCE_CLASSIFICATIONS = [
  "trace_lab_raw_calculated",
  "verified_vendor_raw",
  "coach_entered_summary",
  "analyst_entered_summary",
  "athlete_submitted_pending",
  "athlete_submitted_approved",
  "historical_migration",
  "reprocessed_result",
] as const;
export type SourceClassification = (typeof SOURCE_CLASSIFICATIONS)[number];

const BATCH_TRANSITIONS: Record<ImportBatchState, readonly ImportBatchState[]> = {
  draft: ["uploading", "cancelled"],
  uploading: ["uploaded", "failed", "cancelled"],
  uploaded: ["parsing", "failed", "cancelled"],
  parsing: ["mapping_required", "matching", "failed", "cancelled"],
  mapping_required: ["matching", "failed", "cancelled"],
  matching: ["validating", "review_required", "failed", "cancelled"],
  validating: ["review_required", "ready_for_approval", "failed", "cancelled"],
  review_required: ["matching", "validating", "ready_for_approval", "failed", "cancelled"],
  ready_for_approval: ["committing", "review_required", "failed", "cancelled"],
  committing: ["processing_downstream", "partially_completed", "failed"],
  processing_downstream: ["completed", "partially_completed", "failed"],
  completed: ["superseded"],
  partially_completed: ["processing_downstream", "completed", "failed", "superseded"],
  failed: ["parsing", "matching", "validating", "processing_downstream", "cancelled"],
  cancelled: [],
  superseded: [],
};

const STAGED_TRANSITIONS: Record<StagedSessionState, readonly StagedSessionState[]> = {
  unresolved: [
    "needs_metadata",
    "needs_match",
    "invalid",
    "quality_limited",
    "duplicate_review",
    "ready",
    "rejected",
  ],
  needs_metadata: [
    "unresolved",
    "needs_match",
    "invalid",
    "quality_limited",
    "duplicate_review",
    "ready",
    "rejected",
  ],
  needs_match: [
    "unresolved",
    "needs_metadata",
    "invalid",
    "quality_limited",
    "duplicate_review",
    "ready",
    "rejected",
  ],
  invalid: ["unresolved", "rejected", "superseded"],
  quality_limited: ["needs_metadata", "needs_match", "duplicate_review", "ready", "rejected"],
  duplicate_review: ["needs_metadata", "needs_match", "invalid", "quality_limited", "ready", "rejected"],
  ready: [
    "needs_metadata",
    "needs_match",
    "invalid",
    "quality_limited",
    "duplicate_review",
    "approved",
    "rejected",
  ],
  approved: ["committing", "superseded"],
  committing: ["committed", "invalid"],
  committed: ["superseded"],
  rejected: ["superseded"],
  superseded: [],
};

export class IngestionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionStateError";
  }
}

export class IngestionRevisionConflictError extends Error {
  constructor(message = "This ingestion record changed; reload the latest revision.") {
    super(message);
    this.name = "IngestionRevisionConflictError";
  }
}

export class IngestionScopeError extends Error {
  constructor(message = "Ingestion record not found in this facility.") {
    super(message);
    this.name = "IngestionScopeError";
  }
}

export function canTransitionImportBatch(from: ImportBatchState, to: ImportBatchState): boolean {
  return BATCH_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionStagedSession(
  from: StagedSessionState,
  to: StagedSessionState
): boolean {
  return STAGED_TRANSITIONS[from]?.includes(to) ?? false;
}

function assertBatchState(value: string): asserts value is ImportBatchState {
  if (!(IMPORT_BATCH_STATES as readonly string[]).includes(value)) {
    throw new IngestionStateError(`Unknown import-batch state '${value}'.`);
  }
}

function assertStagedState(value: string): asserts value is StagedSessionState {
  if (!(STAGED_SESSION_STATES as readonly string[]).includes(value)) {
    throw new IngestionStateError(`Unknown staged-session state '${value}'.`);
  }
}

function recordTransition(input: {
  facilityId: string;
  entityType: "import_batch" | "staged_session";
  entityId: string;
  fromState: string | null;
  toState: string;
  revision: number;
  userId?: string | null;
  reason?: string | null;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO ingestion_transition
       (id, facility_id, entity_type, entity_id, from_state, to_state,
        revision, user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      input.facilityId,
      input.entityType,
      input.entityId,
      input.fromState,
      input.toState,
      input.revision,
      input.userId ?? null,
      input.reason ?? null,
      input.createdAt
    );
}

export interface ImportBatchDomainRow {
  id: string;
  facility_id: string;
  data_source_id: string;
  lifecycle_state: ImportBatchState;
  revision: number;
  created_by: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string | null;
}

export function createImportBatchDraft(input: {
  facilityId: string;
  dataSourceId: string;
  userId?: string | null;
  idempotencyKey?: string | null;
  filename?: string | null;
}): { batch: ImportBatchDomainRow; replayed: boolean } {
  const db = getDb();
  const source = db
    .prepare(`SELECT id FROM data_source WHERE facility_id = ? AND id = ?`)
    .get(input.facilityId, input.dataSourceId);
  if (!source) throw new IngestionScopeError("Data source not found in this facility.");

  if (input.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM import_batch WHERE facility_id = ? AND idempotency_key = ?`)
      .get(input.facilityId, input.idempotencyKey) as ImportBatchDomainRow | undefined;
    if (existing) return { batch: existing, replayed: true };
  }

  const id = newId();
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO import_batch
       (id, facility_id, data_source_id, status, lifecycle_state, revision,
        created_by, idempotency_key, updated_at, filename, created_at)
       VALUES (?, ?, ?, 'pending', 'draft', 1, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.facilityId,
      input.dataSourceId,
      input.userId ?? null,
      input.idempotencyKey ?? null,
      now,
      input.filename ?? null,
      now
    );
    recordTransition({
      facilityId: input.facilityId,
      entityType: "import_batch",
      entityId: id,
      fromState: null,
      toState: "draft",
      revision: 1,
      userId: input.userId,
      createdAt: now,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    batch: db
      .prepare(`SELECT * FROM import_batch WHERE facility_id = ? AND id = ?`)
      .get(input.facilityId, id) as unknown as ImportBatchDomainRow,
    replayed: false,
  };
}

export function transitionImportBatch(input: {
  facilityId: string;
  batchId: string;
  expectedRevision: number;
  toState: ImportBatchState;
  userId?: string | null;
  reason?: string | null;
}): ImportBatchDomainRow {
  assertBatchState(input.toState);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(`SELECT * FROM import_batch WHERE facility_id = ? AND id = ?`)
      .get(input.facilityId, input.batchId) as ImportBatchDomainRow | undefined;
    if (!current) throw new IngestionScopeError();
    assertBatchState(current.lifecycle_state);
    if (current.revision !== input.expectedRevision) throw new IngestionRevisionConflictError();
    if (!canTransitionImportBatch(current.lifecycle_state, input.toState)) {
      throw new IngestionStateError(
        `Import batch cannot transition from '${current.lifecycle_state}' to '${input.toState}'.`
      );
    }
    const nextRevision = current.revision + 1;
    const now = nowIso();
    const changed = db
      .prepare(
        `UPDATE import_batch
         SET lifecycle_state = ?, revision = ?, updated_at = ?
         WHERE facility_id = ? AND id = ? AND revision = ?`
      )
      .run(
        input.toState,
        nextRevision,
        now,
        input.facilityId,
        input.batchId,
        input.expectedRevision
      );
    if (changed.changes !== 1) throw new IngestionRevisionConflictError();
    recordTransition({
      facilityId: input.facilityId,
      entityType: "import_batch",
      entityId: input.batchId,
      fromState: current.lifecycle_state,
      toState: input.toState,
      revision: nextRevision,
      userId: input.userId,
      reason: input.reason,
      createdAt: now,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db
    .prepare(`SELECT * FROM import_batch WHERE facility_id = ? AND id = ?`)
    .get(input.facilityId, input.batchId) as unknown as ImportBatchDomainRow;
}

export interface StagedSessionDomainRow {
  id: string;
  facility_id: string;
  import_batch_id: string;
  source_object_id: string | null;
  source_classification: SourceClassification;
  lifecycle_state: StagedSessionState;
  revision: number;
  protocol_id: string | null;
  protocol_version: number | null;
  test_type: string | null;
}

export function createStagedSession(input: {
  facilityId: string;
  batchId: string;
  sourceObjectId?: string | null;
  sourceLocator: Record<string, unknown>;
  sourceClassification: SourceClassification;
  athleteId?: string | null;
  protocolId?: string | null;
  protocolVersion?: number | null;
  testType?: string | null;
  setupVariant?: string | null;
  setupMetadata?: Record<string, unknown>;
  sessionDatetime?: string | null;
  timezoneName?: string | null;
  metadata?: Record<string, unknown>;
  userId?: string | null;
}): StagedSessionDomainRow {
  if (!(SOURCE_CLASSIFICATIONS as readonly string[]).includes(input.sourceClassification)) {
    throw new IngestionStateError(`Unknown source classification '${input.sourceClassification}'.`);
  }
  const db = getDb();
  const batch = db
    .prepare(`SELECT id FROM import_batch WHERE facility_id = ? AND id = ?`)
    .get(input.facilityId, input.batchId);
  if (!batch) throw new IngestionScopeError("Import batch not found in this facility.");
  if (input.sourceObjectId) {
    const source = db
      .prepare(
        `SELECT id FROM source_object
         WHERE facility_id = ? AND import_batch_id = ? AND id = ?`
      )
      .get(input.facilityId, input.batchId, input.sourceObjectId);
    if (!source) throw new IngestionScopeError("Source object not found in this batch and facility.");
  }
  if (input.athleteId) {
    const athlete = db
      .prepare(`SELECT id FROM athlete WHERE facility_id = ? AND id = ?`)
      .get(input.facilityId, input.athleteId);
    if (!athlete) throw new IngestionScopeError("Athlete not found in this facility.");
  }
  if ((input.protocolId == null) !== (input.protocolVersion == null)) {
    throw new IngestionStateError("Protocol ID and version must be supplied together.");
  }
  if (input.protocolId && input.protocolVersion != null) {
    const protocol = getProtocol(input.protocolId, input.protocolVersion);
    if (!protocol) throw new IngestionStateError("Protocol identity/version is not registered.");
    if (input.testType && protocol.testType !== input.testType) {
      throw new IngestionStateError("Protocol identity does not match the staged test type.");
    }
  } else if (input.testType) {
    const current = protocolForTestType(input.testType);
    if (current) {
      throw new IngestionStateError(
        `Staged ${input.testType} sessions must retain explicit protocol identity and version.`
      );
    }
  }

  const id = newId();
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO staged_session
       (id, facility_id, import_batch_id, source_object_id, source_locator_json,
        source_classification, lifecycle_state, revision, validation_revision,
        athlete_id, protocol_id, protocol_version, calculation_version, setup_variant,
        setup_metadata_json, test_type, session_datetime, timezone_name,
        metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unresolved', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.facilityId,
      input.batchId,
      input.sourceObjectId ?? null,
      JSON.stringify(input.sourceLocator),
      input.sourceClassification,
      input.athleteId ?? null,
      input.protocolId ?? null,
      input.protocolVersion ?? null,
      input.protocolId && input.protocolVersion != null
        ? getProtocol(input.protocolId, input.protocolVersion)?.calculationVersion ?? null
        : null,
      input.setupVariant ?? null,
      JSON.stringify(input.setupMetadata ?? {}),
      input.testType ?? null,
      input.sessionDatetime ?? null,
      input.timezoneName ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now
    );
    recordTransition({
      facilityId: input.facilityId,
      entityType: "staged_session",
      entityId: id,
      fromState: null,
      toState: "unresolved",
      revision: 1,
      userId: input.userId,
      createdAt: now,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db
    .prepare(`SELECT * FROM staged_session WHERE facility_id = ? AND id = ?`)
    .get(input.facilityId, id) as unknown as StagedSessionDomainRow;
}

export function transitionStagedSession(input: {
  facilityId: string;
  stagedSessionId: string;
  expectedRevision: number;
  toState: StagedSessionState;
  userId?: string | null;
  reason?: string | null;
}): StagedSessionDomainRow {
  assertStagedState(input.toState);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(`SELECT * FROM staged_session WHERE facility_id = ? AND id = ?`)
      .get(input.facilityId, input.stagedSessionId) as StagedSessionDomainRow | undefined;
    if (!current) throw new IngestionScopeError("Staged session not found in this facility.");
    assertStagedState(current.lifecycle_state);
    if (current.revision !== input.expectedRevision) throw new IngestionRevisionConflictError();
    if (!canTransitionStagedSession(current.lifecycle_state, input.toState)) {
      throw new IngestionStateError(
        `Staged session cannot transition from '${current.lifecycle_state}' to '${input.toState}'.`
      );
    }
    const nextRevision = current.revision + 1;
    const now = nowIso();
    const changed = db
      .prepare(
        `UPDATE staged_session
         SET lifecycle_state = ?, revision = ?, updated_at = ?
         WHERE facility_id = ? AND id = ? AND revision = ?`
      )
      .run(
        input.toState,
        nextRevision,
        now,
        input.facilityId,
        input.stagedSessionId,
        input.expectedRevision
      );
    if (changed.changes !== 1) throw new IngestionRevisionConflictError();
    recordTransition({
      facilityId: input.facilityId,
      entityType: "staged_session",
      entityId: input.stagedSessionId,
      fromState: current.lifecycle_state,
      toState: input.toState,
      revision: nextRevision,
      userId: input.userId,
      reason: input.reason,
      createdAt: now,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db
    .prepare(`SELECT * FROM staged_session WHERE facility_id = ? AND id = ?`)
    .get(input.facilityId, input.stagedSessionId) as unknown as StagedSessionDomainRow;
}

export function listIngestionTransitions(
  facilityId: string,
  entityType: "import_batch" | "staged_session",
  entityId: string
) {
  return getDb()
    .prepare(
      `SELECT * FROM ingestion_transition
       WHERE facility_id = ? AND entity_type = ? AND entity_id = ?
       ORDER BY revision`
    )
    .all(facilityId, entityType, entityId) as unknown as {
      from_state: string | null;
      to_state: string;
      revision: number;
      user_id: string | null;
      reason: string | null;
      created_at: string;
    }[];
}
