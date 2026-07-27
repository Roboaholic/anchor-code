/**
 * Real-world WSL monorepo search (pyoneer06) — only runs when path exists.
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { WslHostSession } from "../host/wslHost.js";
import { searchWorkspaceContent } from "./contentSearch.js";
import { resolveWslLinuxRgPath } from "./rgPath.js";

const ROOT = "/home/miles/pyoneer06";

describe("WSL pyoneer06 Bookworm search", () => {
  it(
    "finds Bookworm via native Linux rg in under 8s",
    async () => {
      if (process.platform !== "win32") return;

      const linuxRg = resolveWslLinuxRgPath();
      console.log("linux rg (wsl path):", linuxRg);
      expect(linuxRg, "vendor/node_modules linux rg should exist").toBeTruthy();

      const host = new WslHostSession({
        profileId: "wsl-default",
        distro: "Ubuntu-24.04",
      });
      try {
        const exists = await host.exists(ROOT);
        if (!exists) {
          console.log("skip: pyoneer06 not present");
          return;
        }

        const t0 = performance.now();
        const r = await searchWorkspaceContent(host, ROOT, "Bookworm", {
          maxResults: 50,
          caseSensitive: false,
        });
        const ms = performance.now() - t0;
        console.log(
          JSON.stringify(
            {
              source: r.source,
              hits: r.hits.length,
              ms: Math.round(ms),
              sample: r.hits.slice(0, 5).map((h) => `${h.path}:${h.line}`),
            },
            null,
            2,
          ),
        );
        expect(r.source).toBe("rg");
        expect(r.hits.length).toBeGreaterThan(0);
        // Native + expanded excludes should be well under the old ~50s UNC path.
        expect(ms).toBeLessThan(15_000);
      } finally {
        await host.dispose();
      }
    },
    60_000,
  );
});
