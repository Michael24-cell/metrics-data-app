import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites exercise the real seeded SQLite database; running test
    // FILES sequentially avoids cross-process write-lock contention that
    // silently skips suites. Total runtime stays ~2s.
    fileParallelism: false,
  },
});
