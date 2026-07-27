import { describe, expect, it } from "vitest";
import {
  filterDirEntries,
  isValidExcludePattern,
  normalizeExcludePattern,
  normalizeRelPath,
  pathMatchesExclude,
  patternToRegExp,
  pruneExcludedPaths,
} from "./pathFilter";

describe("normalizeRelPath", () => {
  it("strips slashes and dots", () => {
    expect(normalizeRelPath("\\a\\b\\")).toBe("a/b");
    expect(normalizeRelPath("./src/x")).toBe("src/x");
    expect(normalizeRelPath("/src")).toBe("src");
  });
});

describe("pathMatchesExclude", () => {
  it("matches plain dir and descendants", () => {
    const p = ["vendor"];
    expect(pathMatchesExclude("vendor", p)).toBe(true);
    expect(pathMatchesExclude("vendor/lib/a.ts", p)).toBe(true);
    expect(pathMatchesExclude("src/vendor", p)).toBe(false);
    expect(pathMatchesExclude("src", p)).toBe(false);
  });

  it("matches nested path", () => {
    const p = ["packages/legacy"];
    expect(pathMatchesExclude("packages/legacy", p)).toBe(true);
    expect(pathMatchesExclude("packages/legacy/x", p)).toBe(true);
    expect(pathMatchesExclude("packages/new", p)).toBe(false);
  });

  it("matches simple globs", () => {
    expect(pathMatchesExclude("foo.log", ["*.log"])).toBe(true);
    expect(pathMatchesExclude("dir/foo.log", ["*.log"])).toBe(false);
    expect(pathMatchesExclude("dir/foo.log", ["**/*.log"])).toBe(true);
  });

  it("rejects empty root patterns", () => {
    expect(isValidExcludePattern(".")).toBe(false);
    expect(isValidExcludePattern("")).toBe(false);
    expect(isValidExcludePattern("src")).toBe(true);
    expect(patternToRegExp(".")).toBeNull();
  });
});

describe("filterDirEntries", () => {
  it("filters children under parent", () => {
    const entries = [
      { name: "src" },
      { name: "vendor" },
      { name: "README.md" },
    ];
    expect(filterDirEntries(entries, "", ["vendor"]).map((e) => e.name)).toEqual(
      ["src", "README.md"],
    );
  });
});

describe("pruneExcludedPaths", () => {
  it("removes matching nodes", () => {
    type N = { path: string; children?: N[] };
    const nodes: N[] = [
      { path: "/ws/src", children: [{ path: "/ws/src/a.ts" }] },
      { path: "/ws/vendor", children: [{ path: "/ws/vendor/x" }] },
    ];
    const next = pruneExcludedPaths(
      nodes,
      "/ws",
      ["vendor"],
      (root, abs) => abs.slice(root.length + 1),
    );
    expect(next.map((n) => n.path)).toEqual(["/ws/src"]);
  });
});

describe("normalizeExcludePattern", () => {
  it("normalizes separators", () => {
    expect(normalizeExcludePattern("a\\b\\")).toBe("a/b");
  });
});
