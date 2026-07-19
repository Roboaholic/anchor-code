import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron", "node-pty", "yaml"],
            },
          },
        },
      },
      preload: {
        // Must be CJS (.cjs): package.json has "type":"module", and a .mjs
        // file that still contains require() will fail to load — no window.anchor.
        input: "electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            lib: {
              entry: "electron/preload.ts",
              formats: ["cjs"],
            },
            rollupOptions: {
              external: ["electron"],
              output: {
                entryFileNames: "preload.cjs",
                format: "cjs",
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
