import { describe, expect, it } from "vitest";
import {
  rankFuzzyPaths,
  scoreFuzzyBasename,
  scoreFuzzyPath,
  scoreFuzzyText,
  FuzzyPathIndex,
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
  it("retains exactly the same top results as exhaustive ranking, including ties and path highlights", () => {
    const paths = Array.from({ length: 2200 }, (_, i) =>
      `${i % 2 ? "packages" : "src"}/feature-${i % 19}/${i % 3 ? "View" : "view"}${i}.tsx`);
    paths.push("src\\feature-2\\view.tsx", "src/Feature.tsx", "README.md", "src/café.ts", "view.tsx");
    for (const query of ["view", "src/fea", "s\\f", "42", "CAFÉ", "not-found"]) {
      const expected = paths.flatMap((path) => {
        const hit = scoreFuzzyPath(path, query);
        return hit ? [hit] : [];
      }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      for (const limit of [0, 1, 8, 80, 3000]) {
        expect(rankFuzzyPaths(paths, query, limit)).toEqual(expected.slice(0, limit));
      }
      expect(new FuzzyPathIndex(paths).rank(query, 80)).toEqual(expected.slice(0, 80));
    }
  });

  it("stops an obsolete query between batches and reuses the index for the next query", async () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `src/View${i}.ts`);
    const index = new FuzzyPathIndex(paths);
    let cancelled = false;
    let yielded = 0;
    const old = await index.rankAsync("view", 80, () => cancelled, async () => {
      yielded += 1;
      cancelled = true;
    });
    expect(yielded).toBe(1);
    expect(old).toEqual([]);
    expect(await index.rankAsync("4999", 80, () => false)).toEqual(rankFuzzyPaths(paths, "4999", 80));
  });

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
