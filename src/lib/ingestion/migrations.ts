import type { DatabaseSync } from "node:sqlite";

/** Conservative, idempotent Phase 1 backfill for pre-staging official data. */
export function backfillIngestionDomain(db: DatabaseSync): void {
  db.exec(`
    UPDATE import_batch
    SET lifecycle_state = CASE status
      WHEN 'complete' THEN 'completed'
      WHEN 'failed' THEN 'failed'
      WHEN 'computed' THEN 'processing_downstream'
      WHEN 'imported' THEN 'committing'
      WHEN 'validated' THEN 'ready_for_approval'
      WHEN 'inspected' THEN 'parsing'
      ELSE COALESCE(lifecycle_state, 'draft')
    END,
    revision = COALESCE(revision, 1),
    updated_at = COALESCE(updated_at, completed_at, created_at);

    INSERT OR IGNORE INTO ingestion_transition
      (id, facility_id, entity_type, entity_id, from_state, to_state, revision, user_id, reason, created_at)
    SELECT 'legacy-batch:' || id, facility_id, 'import_batch', id, NULL,
           lifecycle_state, revision, created_by, 'Legacy lifecycle backfill',
           COALESCE(updated_at, created_at)
    FROM import_batch;

    INSERT OR IGNORE INTO official_result_lineage
      (id, facility_id, official_session_id, metric_id, import_batch_id,
       source_object_id, source_locator_json, source_profile_version_id,
       mapping_template_version_id, unit_transformation_json, athlete_match_id,
       protocol_id, protocol_version, calculation_version, import_approval_id,
       import_commit_id, committed_by, verification_state, source_classification,
       correction_id, authoritative_status, created_at)
    SELECT 'legacy-metric:' || m.id, m.facility_id, m.session_id, m.id,
           s.import_batch_id, NULL, NULL, NULL, NULL, NULL, NULL,
           m.protocol_id, m.protocol_version,
           COALESCE(m.calculation_version, m.method_version), NULL, NULL, NULL,
           'legacy_unverified', 'historical_migration', NULL, 'current', m.created_at
    FROM metric m
    JOIN session s ON s.id = m.session_id;

    INSERT OR IGNORE INTO official_result_lineage
      (id, facility_id, official_session_id, metric_id, import_batch_id,
       source_object_id, source_locator_json, source_profile_version_id,
       mapping_template_version_id, unit_transformation_json, athlete_match_id,
       protocol_id, protocol_version, calculation_version, import_approval_id,
       import_commit_id, committed_by, verification_state, source_classification,
       correction_id, authoritative_status, created_at)
    SELECT 'legacy-session:' || s.id, s.facility_id, s.id, NULL,
           s.import_batch_id, NULL, NULL, NULL, NULL, NULL, NULL,
           s.protocol_id, s.protocol_version, s.calculation_version,
           NULL, NULL, NULL, 'legacy_unverified', 'historical_migration',
           NULL, 'current', s.created_at
    FROM session s
    WHERE NOT EXISTS (
      SELECT 1 FROM metric m WHERE m.session_id = s.id
    );
  `);
}
