import { defineConfig } from "vitest/config";

// Real-tenant specs. They run only through this config (npm run e2e or npm run test:e2e); the
// default config excludes them. The server under test listens on the loopback address and port of
// the MCP API identifier, so files run one at a time.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.spec.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
