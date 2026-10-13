import { describe, expect, it } from "vitest";
import {
  rankFuzzyPaths,
  scoreFuzzyBasename,
  scoreFuzzyPath,
  scoreFuzzyText,
} from "./fuzzy";

describe("scoreFuzzyText", () => {
  it("scores contiguous basename hits", () => {
    const m = scoreFuzzyText("TopBar.tsx", "topbar");
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThan(50);
  });

  it("returns null when no subsequence", () => {
    expect(scoreFuzzyText("c.ts", "xyz")).toBeNull();
  });
});

describe("scoreFuzzyBasename", () => {
  it("matches basename only", () => {
    expect(scoreFuzzyBasename("src/design/foo.ts", "design")).toBeNull();
    const hit = scoreFuzzyBasename("docs/DESIGN.md", "design.md");
    expect(hit?.name).toBe("DESIGN.md");
  });
});

describe("scoreFuzzyPath", () => {
  it("matches path segments like VS Code (src/foo)", () => {
    const hit = scoreFuzzyPath("packages/src/foo/bar.ts", "src/foo");
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe("packages/src/foo/bar.ts");
  });

  it("still prefers basename-only queries", () => {
    const hit = scoreFuzzyPath("src/features/TopBar.tsx", "topbar");
    expect(hit?.name).toBe("TopBar.tsx");
    expect(hit!.indices.length).toBeGreaterThan(0);
  });

  it("ranks path segment hits above unrelated basenames", () => {
    const ranked = rankFuzzyPaths(
      ["other/TopBar.tsx", "src/foo/util.ts", "src/foo.ts"],
      "src/foo",
      10,
    );
    expect(ranked[0]?.path).toMatch(/src\/foo/);
  });
});

describe("rankFuzzyPaths", () => {
  it("returns empty-query slice", () => {
    const ranked = rankFuzzyPaths(["b.ts", "a.ts"], "", 10);
    expect(ranked.map((r) => r.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("filters non-matches", () => {
    const ranked = rankFuzzyPaths(["a.ts", "b.md"], "ts", 10);
    expect(ranked.every((r) => r.path.endsWith(".ts") || r.path.includes("ts"))).toBe(
      true,
    );
  });
});
