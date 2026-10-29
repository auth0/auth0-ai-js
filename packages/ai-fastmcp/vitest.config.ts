import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
    },
  },
});
