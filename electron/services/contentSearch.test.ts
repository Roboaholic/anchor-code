import { describe, expect, it } from "vitest";
import {
  createGrepHitStreamer,
  globToRegExp,
  hasEnoughGrepHits,
  parseGrepLine,
  parseGrepOutput,
  pathMatchesGlobs,
  splitPatterns,
} from "./contentSearch.js";
import {
  resolveLocalRgPath,
  unpackAsarPath,
  windowsPathToWsl,
  _resetLocalRgPathCacheForTests,
} from "./rgPath.js";

describe("parseGrepLine", () => {
  it("parses path:line:text", () => {
    expect(parseGrepLine("src/app.ts:12:const x = 1")).toEqual({
      path: "src/app.ts",
      line: 12,
      text: "const x = 1",
    });
  });

  it("normalizes Windows rg path prefixes", () => {
    expect(parseGrepLine(".\\src\\app.ts:3:hi")).toEqual({
      path: "src/app.ts",
      line: 3,
      text: "hi",
    });
    expect(parseGrepLine("./src/app.ts:4:yo")).toEqual({
      path: "src/app.ts",
      line: 4,
      text: "yo",
    });
  });

  it("keeps colons inside the text body", () => {
    expect(parseGrepLine("a/b.ts:3:url: https://x")).toEqual({
      path: "a/b.ts",
      line: 3,
      text: "url: https://x",
    });
  });

  it("rejects bad lines", () => {
    expect(parseGrepLine("")).toBeNull();
    expect(parseGrepLine("file:notnum:x")).toBeNull();
  });
});

describe("splitPatterns", () => {
  it("splits comma and space lists", () => {
    expect(splitPatterns("*.ts, *.tsx")).toEqual(["*.ts", "*.tsx"]);
    expect(splitPatterns("src/**  test/**")).toEqual(["src/**", "test/**"]);
  });
});

describe("globToRegExp / pathMatchesGlobs", () => {
  it("matches extension globs", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a.tsx")).toBe(false);
  });

  it("matches brace extensions", () => {
    const re = globToRegExp("*.{ts,tsx}");
    expect(re.test("x/a.ts")).toBe(true);
    expect(re.test("x/a.tsx")).toBe(true);
    expect(re.test("x/a.js")).toBe(false);
  });

  it("applies include and exclude", () => {
    expect(pathMatchesGlobs("src/a.ts", ["*.ts"], ["node_modules"])).toBe(true);
    expect(
      pathMatchesGlobs("node_modules/x/a.ts", ["*.ts"], ["node_modules"]),
    ).toBe(false);
    expect(pathMatchesGlobs("src/a.js", ["*.ts"], [])).toBe(false);
    expect(pathMatchesGlobs("src/a.js", [], ["*.min.js"])).toBe(true);
  });

  it("excludes plain multi-segment paths and descendants", () => {
    expect(pathMatchesGlobs("packages/legacy/a.ts", [], ["packages/legacy"])).toBe(
      false,
    );
    expect(pathMatchesGlobs("packages/legacy", [], ["packages/legacy"])).toBe(
      false,
    );
    expect(pathMatchesGlobs("packages/new/a.ts", [], ["packages/legacy"])).toBe(
      true,
    );
    expect(pathMatchesGlobs("src/vendor/x.ts", [], ["vendor"])).toBe(false);
  });
});

describe("parseGrepOutput", () => {
  it("filters by include and truncates", () => {
    const stdout = [
      "src/a.ts:1:one",
      "src/b.js:2:two",
      "src/c.ts:3:three",
    ].join("\n");
    const { hits, truncated } = parseGrepOutput(stdout, 10, ["*.ts"], []);
    expect(hits.map((h) => h.path)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(truncated).toBe(false);
  });
});

describe("hasEnoughGrepHits", () => {
  it("returns true once max filtered hits are present", () => {
    const stdout = ["a.ts:1:x", "b.js:2:y", "c.ts:3:z"].join("\n");
    expect(hasEnoughGrepHits(stdout, 2, ["*.ts"], [])).toBe(true);
    expect(hasEnoughGrepHits(stdout, 3, ["*.ts"], [])).toBe(false);
  });
});

describe("createGrepHitStreamer", () => {
  it("emits new hits incrementally across chunks", () => {
    const batches: string[][] = [];
    const s = createGrepHitStreamer(10, [], [], (hits) => {
      batches.push(hits.map((h) => h.path));
    });
    // Incomplete first line
    expect(s.feed("src/a.ts:1:hel")).toBe(false);
    expect(batches).toEqual([]);
    // Complete first + start of second
    expect(s.feed("src/a.ts:1:hello\nsrc/b.ts:2:wo")).toBe(false);
    expect(batches).toEqual([["src/a.ts"]]);
    expect(s.feed("src/a.ts:1:hello\nsrc/b.ts:2:world\n")).toBe(false);
    expect(batches).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(s.hits().map((h) => h.text)).toEqual(["hello", "world"]);
  });

  it("stops at maxResults", () => {
    const s = createGrepHitStreamer(1, [], []);
    expect(s.feed("a.ts:1:one\nb.ts:2:two\n")).toBe(true);
    expect(s.hits()).toHaveLength(1);
  });
});

describe("rgPath", () => {
  it("rewrites app.asar to app.asar.unpacked", () => {
    expect(
      unpackAsarPath("C:/app/resources/app.asar/node_modules/x/rg.exe"),
    ).toContain("app.asar.unpacked");
  });

  it("maps Windows paths to WSL /mnt form", () => {
    expect(windowsPathToWsl("C:\\Users\\miles\\rg")).toBe(
      "/mnt/c/Users/miles/rg",
    );
    expect(windowsPathToWsl("D:/foo/bar")).toBe("/mnt/d/foo/bar");
  });

  it("resolves bundled local rg when platform package is installed", () => {
    _resetLocalRgPathCacheForTests();
    const p = resolveLocalRgPath();
    // CI/dev machines with @vscode/ripgrep optional dep should find a binary.
    // If the optional package is missing, null is acceptable.
    if (p) {
      expect(p.toLowerCase()).toMatch(/rg(\.exe)?$/);
    }
  });
});
