import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { SCHEMA_SQL } from "./schema";

const DB_PATH = path.join(process.cwd(), "data", "tracelab.db");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(SCHEMA_SQL);
  // Additive column for a pre-existing on-disk database created before this
  // column existed. CREATE TABLE IF NOT EXISTS above does not add columns to
  // an already-existing table, so this guards that case. A reseed (not this
  // guard) is what actually populates the column for demo data — this only
  // prevents a hard crash on an older db file.
  try {
    _db.exec(`ALTER TABLE trial ADD COLUMN event_markers_json TEXT`);
  } catch {
    /* column already exists — expected on any db created with the current schema */
  }
  try {
    _db.exec(`ALTER TABLE velocity_rep ADD COLUMN quality_flag TEXT`);
  } catch {
    /* column already exists — expected on any db created with the current schema */
  }
  try {
    _db.exec(`ALTER TABLE facility ADD COLUMN organization_id TEXT`);
  } catch {
    /* column already exists — expected on any db created with the current schema */
  }
  return _db;
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function nowIso(): string {
  return new Date().toISOString();
}
