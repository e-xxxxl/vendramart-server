import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One shared in-memory mongod for the run, one database per file (see tests/globalSetup.ts), so files can
    // run at the same time. Kept to a few workers because password hashing and the app itself are CPU heavy.
    globalSetup: ["tests/globalSetup.ts"],
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 60000,
    hookTimeout: 120000,
    setupFiles: ["tests/setupEnv.ts"],
  },
});
