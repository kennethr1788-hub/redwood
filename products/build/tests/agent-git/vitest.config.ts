import { defineConfig } from "vitest/config";
// Run from products/build. The root config intentionally only discovers tests/*.test.ts.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts", "tests/agent-git/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
