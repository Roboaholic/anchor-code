import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["mobile/verification/**/*.test.ts"],
    exclude: ["node_modules", "dist", "dist-electron"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
