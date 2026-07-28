import fs from "node:fs";
import path from "node:path";

export default function setup() {
  const source = path.resolve(process.cwd(), "data", "tracelab.db");
  const target = process.env.TRACELAB_DB_PATH;
  if (!target) throw new Error("TRACELAB_DB_PATH was not configured for Vitest.");
  if (!fs.existsSync(source)) throw new Error("Seed database missing; run npm run db:seed before tests.");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = target + suffix;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  fs.copyFileSync(source, target);
  return () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = target + suffix;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
  };
}
