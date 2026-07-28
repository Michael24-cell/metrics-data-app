import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase } from "../src/lib/db/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracelab-migration-"));
const file = path.join(dir, "legacy.db");
const db = new DatabaseSync(file);

try {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE facility (id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE trial (
      id TEXT PRIMARY KEY, facility_id TEXT NOT NULL, session_id TEXT NOT NULL,
      trial_number INTEGER NOT NULL, raw_meta_json TEXT, waveform_json TEXT,
      quality_flag TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE velocity_rep (
      id TEXT PRIMARY KEY, facility_id TEXT NOT NULL, exercise_set_id TEXT NOT NULL,
      rep_number INTEGER NOT NULL, mean_velocity_ms REAL NOT NULL, peak_velocity_ms REAL,
      method_version TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  initializeDatabase(db);
  db.prepare(
    `INSERT INTO facility (id, name, short_name, created_at) VALUES ('legacy-fac', 'Legacy', 'LEG', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO athlete
     (id, facility_id, display_name, sport, position, team, sex, birth_year, height_cm, mass_kg, status, created_at)
     VALUES ('legacy-ath', 'legacy-fac', 'Legacy Athlete', 'test', NULL, NULL, NULL, NULL, NULL, NULL, 'active', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO session
     (id, facility_id, athlete_id, test_type, session_date, created_at)
     VALUES ('legacy-session', 'legacy-fac', 'legacy-ath', 'cmj', '2026-01-01', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO trial
     (id, facility_id, session_id, trial_number, raw_meta_json, waveform_json, quality_flag, created_at)
     VALUES ('legacy-trial', 'legacy-fac', 'legacy-session', 1, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO metric
     (id, facility_id, athlete_id, session_id, trial_id, metric_type, side, value, unit, method_version, source, created_at)
     VALUES ('legacy-metric', 'legacy-fac', 'legacy-ath', 'legacy-session', 'legacy-trial',
             'cmj_jump_height', 'bilateral', 30, 'cm', '1.0.0', 'computed', '2026-01-01T00:00:00.000Z')`
  ).run();
  initializeDatabase(db); // migrations and protocol backfill must be safe to rerun
  const has = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some((c) => c.name === column);
  for (const [table, column] of [
    ["trial", "event_markers_json"],
    ["velocity_rep", "quality_flag"],
    ["facility", "organization_id"],
    ["session", "protocol_id"],
    ["session", "protocol_version"],
    ["session", "calculation_version"],
    ["session", "setup_variant"],
    ["session", "setup_metadata_json"],
    ["trial", "protocol_id"],
    ["trial", "protocol_version"],
    ["trial", "calculation_version"],
    ["trial", "setup_variant"],
    ["metric", "protocol_id"],
    ["metric", "protocol_version"],
    ["metric", "calculation_version"],
    ["metric", "setup_variant"],
  ]) {
    if (!has(table, column)) throw new Error(`Missing migrated column ${table}.${column}`);
  }
  const protocols = db
    .prepare(`SELECT protocol_id, version, calculation_version, contract_hash FROM test_protocol_version ORDER BY protocol_id`)
    .all() as unknown as {
      protocol_id: string;
      version: number;
      calculation_version: string;
      contract_hash: string;
    }[];
  if (protocols.length !== 2 || protocols.some((p) => p.version !== 1 || p.contract_hash.length !== 64)) {
    throw new Error("Built-in protocol catalog was not installed deterministically.");
  }
  const lineage = db
    .prepare(
      `SELECT s.protocol_id AS session_protocol, t.protocol_id AS trial_protocol,
              m.protocol_id AS metric_protocol, m.calculation_version AS metric_calculation
       FROM session s
       JOIN trial t ON t.session_id = s.id
       JOIN metric m ON m.session_id = s.id
       WHERE s.id = 'legacy-session'`
    )
    .get() as {
      session_protocol: string;
      trial_protocol: string;
      metric_protocol: string;
      metric_calculation: string;
    };
  if (
    lineage.session_protocol !== "tracelab.cmj" ||
    lineage.trial_protocol !== "tracelab.cmj" ||
    lineage.metric_protocol !== "tracelab.cmj" ||
    lineage.metric_calculation !== "1.0.0"
  ) {
    throw new Error("Legacy CMJ protocol lineage was not backfilled.");
  }
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") throw new Error(`Integrity check failed: ${integrity.integrity_check}`);
  console.log(
    "Migration verification OK: additive protocol catalog/lineage, legacy backfill, idempotent rerun, schema integrity."
  );
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
