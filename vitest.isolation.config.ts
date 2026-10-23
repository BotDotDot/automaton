import { defineConfig } from "vitest/config";

// Container isolation tests. Needs Docker; run with `npm run test:isolation`.
export default defineConfig({
  test: {
    include: ["tests/isolation/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
