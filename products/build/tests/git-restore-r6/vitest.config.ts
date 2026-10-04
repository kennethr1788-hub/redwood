import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/git-restore-r6/*.test.ts"], fileParallelism: false, testTimeout: 30000 } });
