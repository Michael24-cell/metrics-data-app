/**
 * V1 canonical schema. SQLite via node:sqlite.
 *
 * Scoping rule: every row that describes an athlete's data carries facility_id.
 * The DAL requires a facilityId argument on every read/write — there is no
 * unscoped query path for athlete data.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS facility (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS athlete (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  display_name TEXT NOT NULL,
  sport TEXT NOT NULL,
  position TEXT,
  team TEXT,
  sex TEXT,
  birth_year INTEGER,
  height_cm REAL,
  mass_kg REAL,
  status TEXT NOT NULL DEFAULT 'active',        -- active | rts | inactive
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_facility ON athlete(facility_id);

CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  device_type TEXT NOT NULL,                     -- config-driven key
  make TEXT,
  model TEXT,
  sampling_hz INTEGER,
  last_calibrated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_source (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  adapter_key TEXT NOT NULL,                     -- synthetic_signal | csv_generic | manual_entry | demo_dataset | vendor stubs
  label TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- operational | stub
  config_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batch (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  data_source_id TEXT NOT NULL REFERENCES data_source(id),
  status TEXT NOT NULL,                          -- pending | inspected | validated | imported | computed | complete | failed
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  idempotency_key TEXT,
  updated_at TEXT,
  filename TEXT,
  row_count INTEGER,
  error_json TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_facility ON import_batch(facility_id);

/* ======== immutable built-in test protocol catalog (Milestone A) ======== */

CREATE TABLE IF NOT EXISTS test_protocol_definition (
  id TEXT PRIMARY KEY,                           -- stable system identity, e.g. tracelab.cmj
  test_type TEXT NOT NULL UNIQUE,                -- current application test_type key
  label TEXT NOT NULL,
  scope TEXT NOT NULL,                           -- system (facility-authored protocols are future work)
  status TEXT NOT NULL,                          -- published
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_protocol_version (
  id TEXT PRIMARY KEY,                           -- protocol_id@version
  protocol_id TEXT NOT NULL REFERENCES test_protocol_definition(id),
  version INTEGER NOT NULL,
  calculation_version TEXT NOT NULL,
  contract_json TEXT NOT NULL,                   -- immutable capability snapshot
  contract_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE(protocol_id, version)
);

/* ================= ingestion domain model (Phase 1) ================= */

CREATE TABLE IF NOT EXISTS mapping_template (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',          -- active | paused | archived
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mapping_template_facility ON mapping_template(facility_id, state);

CREATE TABLE IF NOT EXISTS mapping_template_version (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  mapping_template_id TEXT NOT NULL REFERENCES mapping_template(id),
  version INTEGER NOT NULL,
  mapping_json TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(mapping_template_id, version)
);

CREATE TABLE IF NOT EXISTS source_profile (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  name TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',          -- active | paused | archived
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_profile_facility ON source_profile(facility_id, state);

CREATE TABLE IF NOT EXISTS source_profile_version (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  source_profile_id TEXT NOT NULL REFERENCES source_profile(id),
  version INTEGER NOT NULL,
  expected_signature_json TEXT NOT NULL,
  mapping_template_version_id TEXT REFERENCES mapping_template_version(id),
  unit_assumptions_json TEXT NOT NULL,
  athlete_identifier_strategy_json TEXT NOT NULL,
  protocol_mapping_json TEXT NOT NULL,
  timezone_behavior_json TEXT NOT NULL,
  required_defaults_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_profile_id, version)
);

CREATE TABLE IF NOT EXISTS source_object (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  uploader_user_id TEXT,
  original_filename TEXT NOT NULL,
  safe_display_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  detected_file_type TEXT,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  parser_version TEXT,
  mapping_template_version_id TEXT REFERENCES mapping_template_version(id),
  source_profile_version_id TEXT REFERENCES source_profile_version(id),
  vendor_identifier TEXT,
  device_identifier TEXT,
  quarantine_status TEXT NOT NULL DEFAULT 'pending', -- pending | cleared | rejected | unavailable
  retention_status TEXT NOT NULL DEFAULT 'active',   -- active | retained | superseded | deleted
  source_classification TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(facility_id, sha256, storage_reference)
);
CREATE INDEX IF NOT EXISTS idx_source_object_batch ON source_object(facility_id, import_batch_id);

CREATE TABLE IF NOT EXISTS import_job (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  source_object_id TEXT REFERENCES source_object(id),
  job_type TEXT NOT NULL,                        -- parse | validate | commit | downstream | reprocess
  status TEXT NOT NULL,                          -- queued | running | succeeded | failed | cancelled
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  deadline_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(facility_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_import_job_batch ON import_job(facility_id, import_batch_id, status);

CREATE TABLE IF NOT EXISTS staged_session (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  source_object_id TEXT REFERENCES source_object(id),
  source_locator_json TEXT NOT NULL,
  source_classification TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'unresolved',
  revision INTEGER NOT NULL DEFAULT 1,
  validation_revision INTEGER NOT NULL DEFAULT 0,
  athlete_id TEXT REFERENCES athlete(id),
  protocol_id TEXT,
  protocol_version INTEGER,
  calculation_version TEXT,
  setup_variant TEXT,
  setup_metadata_json TEXT,
  test_type TEXT,
  session_datetime TEXT,
  timezone_name TEXT,
  timezone_assumption_json TEXT,
  session_label TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staged_session_queue
  ON staged_session(facility_id, lifecycle_state, import_batch_id);

CREATE TABLE IF NOT EXISTS staged_attempt (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  staged_session_id TEXT NOT NULL REFERENCES staged_session(id),
  attempt_number INTEGER NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'needs_review', -- valid | quality_limited | invalid | needs_metadata | needs_review
  source_sample_range_json TEXT,
  channel_metadata_json TEXT NOT NULL DEFAULT '{}',
  waveform_storage_reference TEXT,
  event_markers_json TEXT,
  inclusion_state TEXT NOT NULL DEFAULT 'included',     -- included | excluded
  exclusion_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(staged_session_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS staged_metric (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  staged_session_id TEXT NOT NULL REFERENCES staged_session(id),
  staged_attempt_id TEXT REFERENCES staged_attempt(id),
  metric_key TEXT NOT NULL,
  side TEXT NOT NULL,
  original_value REAL,
  original_unit TEXT,
  canonical_value REAL,
  canonical_unit TEXT,
  conversion_method TEXT,
  conversion_version TEXT,
  calculation_version TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  source_locator_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staged_metric_session ON staged_metric(facility_id, staged_session_id);

CREATE TABLE IF NOT EXISTS athlete_source_identity (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  source_profile_id TEXT REFERENCES source_profile(id),
  external_namespace TEXT NOT NULL,
  external_identifier TEXT NOT NULL,
  normalized_identity TEXT,
  athlete_id TEXT REFERENCES athlete(id),
  status TEXT NOT NULL DEFAULT 'confirmed',      -- confirmed | disputed | superseded
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(facility_id, external_namespace, external_identifier)
);

CREATE TABLE IF NOT EXISTS athlete_match (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  staged_session_id TEXT NOT NULL REFERENCES staged_session(id),
  athlete_source_identity_id TEXT REFERENCES athlete_source_identity(id),
  athlete_id TEXT REFERENCES athlete(id),
  match_state TEXT NOT NULL,                     -- unresolved | suggested | confirmed | rejected | superseded
  match_method TEXT NOT NULL,
  confidence REAL,
  reason_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_match_session ON athlete_match(facility_id, staged_session_id);

CREATE TABLE IF NOT EXISTS duplicate_candidate (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  staged_session_id TEXT NOT NULL REFERENCES staged_session(id),
  existing_session_id TEXT REFERENCES session(id),
  other_staged_session_id TEXT REFERENCES staged_session(id),
  classification TEXT NOT NULL,                  -- exact | probable | possible | not_duplicate
  evidence_json TEXT NOT NULL,
  resolution TEXT,                               -- link | distinct | reject | supersede
  resolution_reason TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidate_session
  ON duplicate_candidate(facility_id, staged_session_id, classification);

CREATE TABLE IF NOT EXISTS validation_issue (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  staged_session_id TEXT REFERENCES staged_session(id),
  staged_attempt_id TEXT REFERENCES staged_attempt(id),
  staged_metric_id TEXT REFERENCES staged_metric(id),
  code TEXT NOT NULL,
  explanation TEXT NOT NULL,
  severity TEXT NOT NULL,                        -- info | warning | error
  blocks_approval INTEGER NOT NULL,
  suggested_action TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | resolved | waived | superseded
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_issue_queue
  ON validation_issue(facility_id, import_batch_id, status, blocks_approval);

CREATE TABLE IF NOT EXISTS import_approval (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  staged_session_id TEXT REFERENCES staged_session(id),
  approved_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,                        -- approved | rejected
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_approval_batch ON import_approval(facility_id, import_batch_id);

CREATE TABLE IF NOT EXISTS import_commit (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  staged_session_id TEXT NOT NULL REFERENCES staged_session(id),
  import_approval_id TEXT NOT NULL REFERENCES import_approval(id),
  official_session_id TEXT REFERENCES session(id),
  status TEXT NOT NULL,                          -- pending | committed | downstream_pending | completed | failed
  idempotency_key TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE(facility_id, idempotency_key),
  UNIQUE(staged_session_id)
);

CREATE TABLE IF NOT EXISTS manual_entry (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id),
  created_by TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft', -- draft | submitted | approved | rejected | superseded
  revision INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS athlete_submission (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  submitter_user_id TEXT NOT NULL,
  import_batch_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft', -- draft | submitted | needs_more_information | under_review | approved | rejected | superseded
  revision INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_submission_review
  ON athlete_submission(facility_id, lifecycle_state, athlete_id);

CREATE TABLE IF NOT EXISTS data_correction (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  official_session_id TEXT NOT NULL REFERENCES session(id),
  metric_id TEXT REFERENCES metric(id),
  correction_type TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_values_json TEXT NOT NULL,
  new_values_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft', -- draft | approved | applying | completed | failed | superseded
  supersedes_correction_id TEXT REFERENCES data_correction(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS reprocessing_run (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  official_session_id TEXT NOT NULL REFERENCES session(id),
  requested_by TEXT NOT NULL,
  target_protocol_id TEXT,
  target_protocol_version INTEGER,
  target_calculation_version TEXT,
  target_mapping_template_version_id TEXT REFERENCES mapping_template_version(id),
  lifecycle_state TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed | cancelled
  idempotency_key TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(facility_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS official_result_lineage (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  official_session_id TEXT NOT NULL REFERENCES session(id),
  metric_id TEXT REFERENCES metric(id),
  import_batch_id TEXT REFERENCES import_batch(id),
  source_object_id TEXT REFERENCES source_object(id),
  source_locator_json TEXT,
  source_profile_version_id TEXT REFERENCES source_profile_version(id),
  mapping_template_version_id TEXT REFERENCES mapping_template_version(id),
  unit_transformation_json TEXT,
  athlete_match_id TEXT REFERENCES athlete_match(id),
  protocol_id TEXT,
  protocol_version INTEGER,
  calculation_version TEXT,
  import_approval_id TEXT REFERENCES import_approval(id),
  import_commit_id TEXT REFERENCES import_commit(id),
  committed_by TEXT,
  verification_state TEXT NOT NULL,
  source_classification TEXT NOT NULL,
  correction_id TEXT REFERENCES data_correction(id),
  authoritative_status TEXT NOT NULL DEFAULT 'current', -- current | superseded | invalid
  created_at TEXT NOT NULL,
  UNIQUE(official_session_id, metric_id)
);
CREATE INDEX IF NOT EXISTS idx_official_lineage_current
  ON official_result_lineage(facility_id, official_session_id, authoritative_status);

CREATE TABLE IF NOT EXISTS ingestion_transition (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  entity_type TEXT NOT NULL,                     -- import_batch | staged_session
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_transition_entity
  ON ingestion_transition(facility_id, entity_type, entity_id, revision);

CREATE TABLE IF NOT EXISTS permission_record (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  scope TEXT NOT NULL,                           -- performance_monitoring | report_sharing | demo_display
  granted_by TEXT NOT NULL,                      -- role of granting person
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  device_id TEXT REFERENCES device(id),
  import_batch_id TEXT REFERENCES import_batch(id),
  test_type TEXT NOT NULL,                       -- config-driven key
  protocol_id TEXT,                              -- built-in protocol identity; null for protocols not implemented in Milestone A
  protocol_version INTEGER,
  calculation_version TEXT,
  setup_variant TEXT,
  setup_metadata_json TEXT,
  session_date TEXT NOT NULL,                    -- ISO date
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_facility_athlete ON session(facility_id, athlete_id, session_date);

CREATE TABLE IF NOT EXISTS trial (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  trial_number INTEGER NOT NULL,
  protocol_id TEXT,
  protocol_version INTEGER,
  calculation_version TEXT,
  setup_variant TEXT,
  raw_meta_json TEXT,                            -- adapter-specific raw metadata
  waveform_json TEXT,                            -- downsampled display waveform {hz, force, left?, right?}
  event_markers_json TEXT,                       -- full-rate-derived alignment markers {kind, methodVersion, ...msFields}; NULL for trials predating this contract or test types with no defined events — never backfilled
  quality_flag TEXT,                             -- null | warning text
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_session ON trial(session_id);

CREATE TABLE IF NOT EXISTS metric (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  trial_id TEXT REFERENCES trial(id),            -- null for session-level / derived metrics
  metric_type TEXT NOT NULL,                     -- key into metric registry
  protocol_id TEXT,
  protocol_version INTEGER,
  calculation_version TEXT,
  setup_variant TEXT,
  side TEXT NOT NULL DEFAULT 'bilateral',        -- left | right | bilateral
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  method_version TEXT NOT NULL,
  quality_flag TEXT,                             -- null | sanity-range or trial warning
  source TEXT NOT NULL DEFAULT 'computed',       -- computed | imported | manual
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_lookup ON metric(facility_id, athlete_id, metric_type, side);
CREATE INDEX IF NOT EXISTS idx_metric_session ON metric(session_id);

CREATE TABLE IF NOT EXISTS threshold_setting (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  key TEXT NOT NULL,                             -- e.g. asymmetry_watch_pct, asymmetry_flag_pct
  metric_type TEXT,                              -- null = applies to all
  value REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  set_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS injury_record (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  label TEXT NOT NULL,                           -- practitioner-entered description
  involved_side TEXT,                            -- left | right | null
  occurred_on TEXT NOT NULL,
  resolved_on TEXT,
  entered_by TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rts_protocol (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  injury_record_id TEXT REFERENCES injury_record(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',         -- active | completed | archived
  defined_by TEXT NOT NULL,                      -- practitioner name/role
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rts_stage (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  protocol_id TEXT NOT NULL REFERENCES rts_protocol(id),
  stage_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  criteria_json TEXT NOT NULL,                   -- [{id,label,metric_type,side?,kind:'lsi'|'absolute'|'baseline_pct',operator,target,unit}]
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | current | completed (set by practitioner, not auto)
  entered_on TEXT,
  completed_on TEXT
);

CREATE TABLE IF NOT EXISTS clinical_assessment (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  assessed_on TEXT NOT NULL,
  assessor TEXT NOT NULL,
  category TEXT NOT NULL,                        -- e.g. clearance_note | subjective_readiness | screening
  summary TEXT NOT NULL,                         -- human-authored, displayed verbatim
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  category TEXT NOT NULL,                        -- baseline_deviation | rts_stage_status | asymmetry_flag | training_context_note | data_gap
  severity TEXT NOT NULL,                        -- info | watch | flag
  headline TEXT NOT NULL,
  detail TEXT NOT NULL,
  refs_json TEXT NOT NULL,                       -- {metricIds, sessionIds, metricType, methodVersion, thresholdKey/Version, protocolId/Version, stageId, annotates?}
  session_date TEXT,                             -- date the finding refers to
  generated_at TEXT NOT NULL,
  engine_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finding_facility_athlete ON finding(facility_id, athlete_id);

CREATE TABLE IF NOT EXISTS training_session (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  session_date TEXT NOT NULL,
  session_type TEXT NOT NULL,                    -- strength | speed | conditioning | practice | rehab
  duration_min INTEGER,
  rpe REAL,                                      -- session RPE 0-10
  load_au REAL,                                  -- duration × RPE (arbitrary units)
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_facility_athlete ON training_session(facility_id, athlete_id, session_date);

CREATE TABLE IF NOT EXISTS exercise_set (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  training_session_id TEXT NOT NULL REFERENCES training_session(id),
  exercise TEXT NOT NULL,
  set_number INTEGER NOT NULL,
  load_kg REAL,
  reps INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS velocity_rep (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  exercise_set_id TEXT NOT NULL REFERENCES exercise_set(id),
  rep_number INTEGER NOT NULL,
  mean_velocity_ms REAL NOT NULL,
  peak_velocity_ms REAL,
  method_version TEXT NOT NULL,
  quality_flag TEXT,                             -- null | explicit exclusion reason (reps are NEVER auto-discarded)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS load_velocity_profile (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  exercise TEXT NOT NULL,
  slope REAL NOT NULL,
  intercept REAL NOT NULL,
  r2 REAL NOT NULL,
  n_points INTEGER NOT NULL,
  method_version TEXT NOT NULL,                  -- 0.1.0-provisional
  provisional INTEGER NOT NULL DEFAULT 1,
  fitted_on TEXT NOT NULL,
  points_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestone (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  milestone_date TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- injury | surgery | stage_change | benchmark | note
  created_at TEXT NOT NULL
);

-- Future-ready only: no ingestion, no findings, no correlation logic in V1.
CREATE TABLE IF NOT EXISTS external_test_result (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  test_name TEXT NOT NULL,
  test_date TEXT NOT NULL,
  value REAL,
  unit TEXT,
  source_label TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

/* ================= commercial security foundation (additive) ================= */

CREATE TABLE IF NOT EXISTS organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,                            -- null until activation completes
  status TEXT NOT NULL DEFAULT 'invited',        -- invited | active | disabled
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facility_membership (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  facility_id TEXT NOT NULL REFERENCES facility(id),
  role TEXT NOT NULL,                            -- admin | coach | analyst | readonly
  created_at TEXT NOT NULL,
  UNIQUE(user_id, facility_id)
);

CREATE TABLE IF NOT EXISTS user_session (
  id TEXT PRIMARY KEY,                           -- sha256 of the bearer token; raw token never stored
  user_id TEXT NOT NULL REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitation (
  id TEXT PRIMARY KEY,                           -- sha256 of the invitation token
  email TEXT NOT NULL,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  role TEXT NOT NULL,
  invited_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  facility_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,                          -- e.g. auth.signin, agent.question, alert.acknowledge
  resource_type TEXT,
  resource_id TEXT,
  outcome TEXT NOT NULL,                         -- ok | denied | error
  versions_json TEXT,                            -- relevant version identifiers
  metadata_json TEXT,                            -- SAFE metadata only: no secrets, no raw prompts
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_facility_time ON audit_event(facility_id, created_at);
CREATE TRIGGER IF NOT EXISTS audit_event_append_only_update
BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_event_append_only_delete
BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

CREATE TABLE IF NOT EXISTS agent_run_record (
  run_id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  user_id TEXT,
  task TEXT NOT NULL,
  question TEXT,
  eval_status TEXT NOT NULL,
  mode TEXT NOT NULL,
  run_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_run_facility ON agent_run_record(facility_id, athlete_id, created_at);

CREATE TABLE IF NOT EXISTS agent_review (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  run_id TEXT NOT NULL REFERENCES agent_run_record(run_id),
  user_id TEXT,
  action TEXT NOT NULL,                          -- approve | edit | reject | needs_more_data
  reason TEXT,
  revised_summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_review_run ON agent_review(facility_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  run_id TEXT NOT NULL,
  user_id TEXT,
  rating TEXT NOT NULL,                          -- helpful | not_what_i_asked | wrong_context | too_technical | missing_option
  query_version TEXT,
  answer_mode TEXT,
  eval_status TEXT,
  latency_ms INTEGER,
  user_role TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, user_id, rating)
);

/* ================= monitoring policy + results (additive) ================= */

CREATE TABLE IF NOT EXISTS monitoring_policy (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  scope TEXT NOT NULL,                           -- facility | coach | athlete
  coach_user_id TEXT,                            -- scope=coach
  athlete_id TEXT,                               -- scope=athlete
  version INTEGER NOT NULL,                      -- bumps per scope-target; old rows preserved
  config_json TEXT NOT NULL,                     -- partial MonitoringPolicyV1 overrides
  created_by TEXT,
  active INTEGER NOT NULL DEFAULT 1,             -- exactly one active row per scope-target
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monpolicy ON monitoring_policy(facility_id, scope, athlete_id, coach_user_id, active);

CREATE TABLE IF NOT EXISTS monitoring_result (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  metric_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES session(id),
  session_date TEXT NOT NULL,
  monitoring_state TEXT NOT NULL,                -- within_expected_range | review_suggested | repeated_low_signal | collecting_baseline | insufficient_reliable_data
  range_state TEXT NOT NULL,                     -- above_expected | within_expected | below_expected | insufficient_data
  noise_state TEXT NOT NULL,                     -- exceeds_threshold | within_noise | reliability_unavailable | reliability_poor
  current_value REAL NOT NULL,
  reference_mean REAL,
  reference_sd REAL,
  band_low REAL,
  band_high REAL,
  reference_count INTEGER NOT NULL,
  policy_fingerprint TEXT NOT NULL,              -- versioned identity of the effective policy used
  policy_snapshot_json TEXT NOT NULL,            -- full effective policy at generation time (immutable)
  calc_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(facility_id, athlete_id, metric_key, session_id, policy_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_monresult ON monitoring_result(facility_id, athlete_id, metric_key, session_date);

CREATE TABLE IF NOT EXISTS alert (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facility(id),
  athlete_id TEXT NOT NULL REFERENCES athlete(id),
  test_type TEXT,
  metric_key TEXT,
  session_id TEXT,
  session_date TEXT,
  alert_type TEXT NOT NULL,                      -- review_suggested | repeated_low_signal | new_pr | asymmetry_crossing | reliability_concern | monitoring_data_gap | baseline_completed
  severity TEXT NOT NULL,                        -- info | review | high
  monitoring_result_id TEXT,
  policy_fingerprint TEXT,
  calc_version TEXT,
  evidence_json TEXT NOT NULL,                   -- values/refs supporting the alert
  dedupe_key TEXT NOT NULL UNIQUE,               -- same source event never duplicates
  status TEXT NOT NULL DEFAULT 'new',            -- new | acknowledged | resolved | dismissed
  created_at TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  closed_by TEXT,
  closed_at TEXT,
  close_reason TEXT,                             -- resolution or dismissal reason
  coach_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_facility ON alert(facility_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_athlete ON alert(facility_id, athlete_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_key (
  key TEXT PRIMARY KEY,                          -- caller-scoped: facility:user:operation:hash
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
