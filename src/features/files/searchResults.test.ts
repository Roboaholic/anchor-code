import { describe, expect, it } from "vitest";
import {
  appendHitsToGroups,
  computeVirtualWindow,
  countHits,
  excludeRegexError,
  flattenSearchRows,
  groupHitsByFile,
  loadSearchSettings,
  parseExcludeList,
  saveSearchSettings,
} from "./searchResults";

const h = (path: string, line: number) => ({ path, line, text: `l${line}` });

describe("appendHitsToGroups", () => {
  it("appends to existing groups and keeps untouched group identity", () => {
    const g1 = groupHitsByFile([h("a.ts", 1), h("b.ts", 2)]);
    const g2 = appendHitsToGroups(g1, [h("a.ts", 5), h("c.ts", 1)]);
    expect(g2.map((g) => g.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(g2[0]!.hits.map((x) => x.line)).toEqual([1, 5]);
    expect(g2[1]).toBe(g1[1]);
    expect(g2[0]).not.toBe(g1[0]);
    // Original is not mutated.
    expect(g1[0]!.hits).toHaveLength(1);
    expect(countHits(g2)).toBe(4);
  });

  it("returns the same array for an empty batch", () => {
    const g = groupHitsByFile([h("a.ts", 1)]);
    expect(appendHitsToGroups(g, [])).toBe(g);
  });
});

describe("flattenSearchRows", () => {
  it("emits header + hits, skipping collapsed files", () => {
    const groups = groupHitsByFile([h("a.ts", 1), h("a.ts", 2), h("b.ts", 3)]);
    const rows = flattenSearchRows(groups, new Set(["b.ts"]));
    expect(rows.map((r) => r.kind)).toEqual(["file", "hit", "hit", "file"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("computeVirtualWindow", () => {
  it("clamps to bounds with overscan", () => {
    expect(computeVirtualWindow(0, 22, 0, 400)).toEqual({ start: 0, end: 0 });
    expect(computeVirtualWindow(1000, 20, 0, 200, 5)).toEqual({ start: 0, end: 16 });
    expect(computeVirtualWindow(1000, 20, 2000, 200, 5)).toEqual({ start: 95, end: 116 });
    expect(computeVirtualWindow(10, 20, 5000, 200, 5).end).toBe(10);
  });
});

describe("search settings persistence", () => {
  function memStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  }

  it("round-trips per workspace root", () => {
    const st = memStorage();
    saveSearchSettings(
      "/repo/a",
      {
        include: "src/**",
        exclude: "dist",
        respectIgnore: false,
        excludeRegex: "\\.snap$",
        defaultExcludes: ["node_modules"],
      },
      st,
    );
    expect(loadSearchSettings("/repo/a", st)).toEqual({
      include: "src/**",
      exclude: "dist",
      respectIgnore: false,
      excludeRegex: "\\.snap$",
      defaultExcludes: ["node_modules"],
    });
    expect(loadSearchSettings("/repo/b", st).respectIgnore).toBe(true);
  });

  it("tolerates corrupt JSON", () => {
    const st = memStorage();
    st.setItem("anchor.search.v1:/x", "{nope");
    expect(loadSearchSettings("/x", st).defaultExcludes).toBeNull();
  });
});

describe("misc", () => {
  it("parses exclude lists and validates regex", () => {
    expect(parseExcludeList("a\n b ,c\n\n")).toEqual(["a", "b", "c"]);
    expect(excludeRegexError("")).toBeNull();
    expect(excludeRegexError("(")).toMatch(/./);
  });
});
