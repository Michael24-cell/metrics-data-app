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
  initializeDatabase(db); // migrations must be safe to rerun
  const has = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some((c) => c.name === column);
  for (const [table, column] of [
    ["trial", "event_markers_json"],
    ["velocity_rep", "quality_flag"],
    ["facility", "organization_id"],
  ]) {
    if (!has(table, column)) throw new Error(`Missing migrated column ${table}.${column}`);
  }
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") throw new Error(`Integrity check failed: ${integrity.integrity_check}`);
  console.log("Migration verification OK: legacy additive columns, idempotent rerun, schema integrity.");
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
