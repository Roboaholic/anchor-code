import { describe, expect, it } from "vitest";
import {
  PREVIEW_CONTEXT,
  PREVIEW_MAX_LEAD,
  appendHitsToGroups,
  buildSearchPreview,
  computeVirtualWindow,
  countHits,
  excludeRegexError,
  flattenSearchRows,
  groupHitsByFile,
  loadSearchSettings,
  parseExcludeList,
  saveSearchSettings,
  searchCompletionStatus,
  actionableSearchDiagnostics,
  searchResultsSummary,
  searchTimedOut,
} from "./searchResults";

const h = (path: string, line: number) => ({ path, line, text: `l${line}` });

describe("search coverage", () => {
  it("honors coverage and legacy cancellation without treating pagination as partial", () => {
    expect(searchCompletionStatus({})).toBe("complete");
    expect(searchCompletionStatus({ status: "partial" })).toBe("partial");
    expect(searchCompletionStatus({ aborted: true })).toBe("cancelled");
    expect(searchCompletionStatus({ status: "complete", aborted: true })).toBe("cancelled");
  });

  it("never presents a running, incomplete, failed or stopped search as complete", () => {
    const base = { searching: false, hitCount: 0, fileCount: 0, truncated: false };
    expect(searchResultsSummary({ ...base, status: null })).toBe("Waiting to search…");
    expect(searchResultsSummary({ ...base, status: null, searching: true })).toBe("Searching…");
    expect(searchResultsSummary({ ...base, status: "complete" })).toBe("No matches in searched files");
    expect(searchResultsSummary({ ...base, status: "partial" })).toBe("Search incomplete · No matches in searched files");
    expect(searchResultsSummary({ ...base, status: "failed" })).toBe("Search failed");
    expect(searchResultsSummary({ ...base, status: "cancelled" })).toBe("Search stopped · No matches found so far");
  });

  it("keeps result counts with incomplete coverage or failure", () => {
    const base = { searching: false, hitCount: 3, fileCount: 2, truncated: false };
    expect(searchResultsSummary({ ...base, status: "partial" })).toBe("Search incomplete · 3 results in 2 files");
    expect(searchResultsSummary({ ...base, status: "failed" })).toBe("Search failed · 3 results in 2 files kept");
    expect(searchResultsSummary({ ...base, status: "cancelled" })).toBe("Search stopped · 3 results in 2 files kept");
    expect(searchResultsSummary({ ...base, status: "complete", truncated: true })).toBe("3 results in 2 files+");
  });

  it("says timed out instead of failed when the engine hit its time limit", () => {
    const base = { searching: false, fileCount: 0, truncated: false, timedOut: true };
    expect(searchResultsSummary({ ...base, hitCount: 0, status: "failed" })).toBe("Timed out · No matches so far");
    expect(searchResultsSummary({ ...base, hitCount: 3, fileCount: 2, status: "partial" })).toBe("Timed out · 3 results in 2 files");
    expect(searchResultsSummary({ ...base, hitCount: 0, status: "cancelled" })).toBe("Search stopped · No matches found so far");
    expect(searchTimedOut([{ code: "rg-scope", message: "" }, { code: "timeout", message: "" }])).toBe(true);
    expect(searchTimedOut([{ code: "search-failed", message: "" }])).toBe(false);
  });
});

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

describe("actionableSearchDiagnostics", () => {
  it("drops always-on scope notes and keeps real warnings", () => {
    expect(
      actionableSearchDiagnostics([
        { code: "rg-scope", message: "scope" },
        { code: "tracked-only", message: "tracked" },
        { code: "scan-scope", message: "scan" },
        { code: "anchorignore", message: "ignore" },
        { code: "result-limit", message: "limit" },
        { code: "timeout", message: "slow" },
      ]).map((d) => d.code),
    ).toEqual(["result-limit", "timeout"]);
  });
});

describe("buildSearchPreview", () => {
  it("trims leading indentation and splits around the first match", () => {
    expect(buildSearchPreview("\t    useState,", "usestate", false, false)).toEqual({
      clipped: false,
      before: "",
      match: "useState",
      after: ",",
    });
  });

  it("windows long lead-ins so the match stays visible", () => {
    const line = "    const [value, setValue] = React.useState<number | null>(initial);";
    const p = buildSearchPreview(line, "useState", false, true);
    expect(p.clipped).toBe(true);
    expect(p.match).toBe("useState");
    expect(p.before.length).toBeLessThanOrEqual(PREVIEW_CONTEXT);
    expect(p.before).toBe("React.");
    expect(p.after).toBe("<number | null>(initial);");
  });

  it("keeps short lead-ins intact", () => {
    const p = buildSearchPreview("import { useState } from 'react';", "useState", false, true);
    expect(p).toEqual({ clipped: false, before: "import { ", match: "useState", after: " } from 'react';" });
    expect("import { ".length).toBeLessThanOrEqual(PREVIEW_MAX_LEAD);
  });

  it("honors case sensitivity, regex queries and literal special characters", () => {
    expect(buildSearchPreview("Foo foo", "foo", false, true).before).toBe("Foo ");
    expect(buildSearchPreview("a1 b22", "b\\d+", true, false).match).toBe("b22");
    expect(buildSearchPreview("call(x)", "(x", false, false).match).toBe("(x");
  });

  it("falls back to the trimmed line for no match, empty or invalid queries", () => {
    const none = { clipped: false, match: "", after: "" };
    expect(buildSearchPreview("  plain  ", "zzz", false, false)).toEqual({ ...none, before: "plain" });
    expect(buildSearchPreview("  plain", "", false, false)).toEqual({ ...none, before: "plain" });
    expect(buildSearchPreview("plain", "[", true, false)).toEqual({ ...none, before: "plain" });
  });
});
