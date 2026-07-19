import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: Monaco must not default to CDN in our setup module.
 * (Full browser worker test needs a browser env; this locks the config intent.)
 */
describe("monacoSetup source contract", () => {
  it("configures loader with local monaco package, not CDN URL", () => {
    const file = path.join(
      process.cwd(),
      "src/features/document/monacoSetup.ts",
    );
    const src = fs.readFileSync(file, "utf8");
    expect(src).toContain("loader.config({ monaco })");
    expect(src).toContain("monaco-editor");
    expect(src).not.toMatch(/cdn\.jsdelivr\.net/);
    expect(src).not.toMatch(/unpkg\.com/);
    expect(src).toContain("MonacoEnvironment");
    expect(src).toContain("?worker");
  });
});
