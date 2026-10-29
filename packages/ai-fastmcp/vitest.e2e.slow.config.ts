import { defineConfig } from "vitest/config";

// Slow real-tenant specs: they wait for real tokens to expire.
// Run through `npm run e2e -- --slow`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/slow/**/*.e2e.slow.spec.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
