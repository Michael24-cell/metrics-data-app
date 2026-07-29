import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { SCHEMA_SQL } from "./schema";
import {
  backfillBuiltinProtocolLineage,
  ensureBuiltinProtocolCatalog,
} from "../protocols/persistence";
import { backfillIngestionDomain } from "../ingestion/migrations";

const DB_PATH = process.env.TRACELAB_DB_PATH || path.join(process.cwd(), "data", "tracelab.db");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  try {
    initializeDatabase(_db);
  } catch (error) {
    _db.close();
    _db = null;
    throw error;
  }
  return _db;
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function initializeDatabase(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  addColumnIfMissing(db, "trial", "event_markers_json", "TEXT");
  addColumnIfMissing(db, "velocity_rep", "quality_flag", "TEXT");
  addColumnIfMissing(db, "facility", "organization_id", "TEXT");
  addColumnIfMissing(db, "session", "protocol_id", "TEXT");
  addColumnIfMissing(db, "session", "protocol_version", "INTEGER");
  addColumnIfMissing(db, "session", "calculation_version", "TEXT");
  addColumnIfMissing(db, "session", "setup_variant", "TEXT");
  addColumnIfMissing(db, "session", "setup_metadata_json", "TEXT");
  addColumnIfMissing(db, "trial", "protocol_id", "TEXT");
  addColumnIfMissing(db, "trial", "protocol_version", "INTEGER");
  addColumnIfMissing(db, "trial", "calculation_version", "TEXT");
  addColumnIfMissing(db, "trial", "setup_variant", "TEXT");
  addColumnIfMissing(db, "metric", "protocol_id", "TEXT");
  addColumnIfMissing(db, "metric", "protocol_version", "INTEGER");
  addColumnIfMissing(db, "metric", "calculation_version", "TEXT");
  addColumnIfMissing(db, "metric", "setup_variant", "TEXT");
  addColumnIfMissing(db, "import_batch", "lifecycle_state", "TEXT NOT NULL DEFAULT 'draft'");
  addColumnIfMissing(db, "import_batch", "revision", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "import_batch", "created_by", "TEXT");
  addColumnIfMissing(db, "import_batch", "idempotency_key", "TEXT");
  addColumnIfMissing(db, "import_batch", "updated_at", "TEXT");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_idempotency
     ON import_batch(facility_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`
  );
  ensureBuiltinProtocolCatalog(db);
  backfillBuiltinProtocolLineage(db);
  backfillIngestionDomain(db);
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function nowIso(): string {
  return new Date().toISOString();
}
