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
              external: [
                "electron",
                "electron-updater",
                "node-pty",
                "ws",
                "yaml",
                "ssh2",
                "cpu-features",
                "@vscode/ripgrep",
                /^@vscode\/ripgrep-/,
                /^ssh2\//,
              ],
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
  optimizeDeps: {
    include: ["@monaco-editor/react"],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    // Monaco alone is ~3 MB; it is loaded on first document open (lazy viewers).
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's preload helper must not land inside a lazy vendor chunk, or
          // the entry would statically import that whole chunk.
          if (id.includes("vite/preload-helper") || id.includes("commonjsHelpers")) return "runtime";
          if (!id.includes("node_modules")) return undefined;
          // Keep big vendors in stable, separately cached chunks. Mermaid and its
          // diagram/katex/cytoscape deps are left to Rollup's dynamic-import split.
          if (id.includes("/monaco-editor/") || id.includes("/@monaco-editor/")) return "monaco";
          if (id.includes("/@xterm/")) return "xterm";
          if (
            id.includes("/react-markdown/") ||
            id.includes("/remark-") ||
            id.includes("/mdast-") ||
            id.includes("/micromark") ||
            id.includes("/unified/") ||
            id.includes("/hast-")
          )
            return "markdown";
          if (/\/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return "react";
          return undefined;
        },
      },
    },
  },
});
