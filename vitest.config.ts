import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/lib/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    // DB-backed tests share one test database; run files serially.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
    },
  },
});
