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
  filename TEXT,
  row_count INTEGER,
  error_json TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_facility ON import_batch(facility_id);

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

CREATE TABLE IF NOT EXISTS idempotency_key (
  key TEXT PRIMARY KEY,                          -- caller-scoped: facility:user:operation:hash
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
