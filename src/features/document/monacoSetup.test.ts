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
    // Variables / C tokens must not stay monochrome.
    expect(src).toContain('token: "identifier"');
    expect(src).toContain("9cdcfe");
    expect(src).toContain('setMonarchTokensProvider("c"');
    expect(src).toContain('setMonarchTokensProvider("cpp"');
    // Type suffixes: _t/_e/_s/… — not bare `_type` (would paint buffer_type).
    expect(src).toContain("_(?:t|e|s|st|et|tt|handle)");
    expect(src).toContain("do NOT match bare `_type`");
    // No PascalCase→type heuristic (Amba vars like AmbaImu…RingCtrl stay identifier).
    expect(src).toContain("never paint variables green");
    expect(src).toContain("(?=\\s*\\()");
  });
});
