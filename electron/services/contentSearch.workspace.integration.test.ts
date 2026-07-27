import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import { searchWorkspaceContent } from "./contentSearch.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("searchWorkspaceContent on real workspace", () => {
  it("finds hits via rg with clean relative paths", async () => {
    const host = new LocalHostSession("bench");
    const t0 = performance.now();
    const result = await searchWorkspaceContent(host, root, "searchWorkspaceContent", {
      maxResults: 50,
      caseSensitive: false,
    });
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ source: result.source, hits: result.hits.length, ms: Math.round(ms), sample: result.hits.slice(0, 3) }, null, 2));
    expect(result.source).toBe("rg");
    expect(result.hits.length).toBeGreaterThan(0);
    for (const h of result.hits) {
      expect(h.path.startsWith("./")).toBe(false);
      expect(h.path.includes("\\")).toBe(false);
      expect(h.line).toBeGreaterThan(0);
    }
    await host.dispose();
  }, 30_000);
});
