import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // The harness bridge (tests/harnesses.test.ts) spawns each scripts/
    // test-*.mjs as a subprocess; generous per-test timeout because tsx
    // cold-starts the TypeScript pipeline in every child.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
