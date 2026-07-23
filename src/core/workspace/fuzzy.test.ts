import { describe, expect, it } from "vitest";
import {
  basenameOf,
  rankFuzzyPaths,
  scoreFuzzyBasename,
  scoreFuzzyText,
} from "./fuzzy";

describe("basenameOf", () => {
  it("strips directories", () => {
    expect(basenameOf("docs/DESIGN.md")).toBe("DESIGN.md");
    expect(basenameOf("a\\b\\c.ts")).toBe("c.ts");
  });
});

describe("scoreFuzzyText", () => {
  it("matches subsequence case-insensitively", () => {
    const m = scoreFuzzyText("TopBar.tsx", "topbar");
    expect(m).not.toBeNull();
    expect(m!.indices.length).toBe(6);
  });

  it("rejects non-subsequence", () => {
    expect(scoreFuzzyText("c.ts", "xyz")).toBeNull();
  });
});

describe("scoreFuzzyBasename", () => {
  it("matches filename only, not parent path segments", () => {
    // path contains "design" but basename does not
    expect(scoreFuzzyBasename("src/design/foo.ts", "design")).toBeNull();
    // basename is DESIGN.md
    const hit = scoreFuzzyBasename("docs/DESIGN.md", "design.md");
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe("DESIGN.md");
  });

  it("ranks exact basename above partial", () => {
    const ranked = rankFuzzyPaths(
      ["docs/DESIGN.md", "docs/design-notes.txt", "src/x.ts"],
      "DESIGN.md",
    );
    expect(ranked[0]!.path).toBe("docs/DESIGN.md");
  });

  it("empty query returns paths in order", () => {
    const ranked = rankFuzzyPaths(["b.ts", "a.ts"], "", 10);
    expect(ranked.map((r) => r.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("does not match query only present in directory name", () => {
    const ranked = rankFuzzyPaths(
      ["src/design/system/tokens.ts", "docs/DESIGN.md"],
      "design",
    );
    expect(ranked.map((r) => r.path)).toEqual(["docs/DESIGN.md"]);
  });

  it("matches dotted basenames for extension queries", () => {
    const ranked = rankFuzzyPaths(
      ["a/b/foo.ts", "a/b/bar.tsx", "a/b/readme.md"],
      ".md",
    );
    expect(ranked.map((r) => r.path)).toEqual(["a/b/readme.md"]);
  });
});
