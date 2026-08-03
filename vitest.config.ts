import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "electron/**/*.test.ts",
      "contracts/**/*.test.ts",
      "mobile/web/src/**/*.test.ts",
      "mobile/web/src/**/*.test.tsx",
    ],
    exclude: ["node_modules", "dist", "dist-electron"],
  },
});
