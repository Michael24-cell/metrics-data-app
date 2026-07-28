import { defineConfig } from "vitest/config";
import path from "node:path";

const testDbPath = path.resolve(process.cwd(), "data", `tracelab.test.${process.pid}.db`);
process.env.TRACELAB_DB_PATH = testDbPath;

export default defineConfig({
  test: {
    // Several suites exercise the real seeded SQLite database; running test
    // FILES sequentially avoids cross-process write-lock contention that
    // silently skips suites. Total runtime stays ~2s.
    fileParallelism: false,
    globalSetup: ["./vitest.global.ts"],
    env: {
      TRACELAB_DB_PATH: testDbPath,
    },
  },
});
