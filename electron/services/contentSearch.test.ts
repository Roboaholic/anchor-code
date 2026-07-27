import { describe, expect, it } from "vitest";
import {
  globToRegExp,
  parseGrepLine,
  parseGrepOutput,
  pathMatchesGlobs,
  splitPatterns,
} from "./contentSearch.js";

describe("parseGrepLine", () => {
  it("parses path:line:text", () => {
    expect(parseGrepLine("src/app.ts:12:const x = 1")).toEqual({
      path: "src/app.ts",
      line: 12,
      text: "const x = 1",
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
