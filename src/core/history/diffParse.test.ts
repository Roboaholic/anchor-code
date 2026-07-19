import { describe, expect, it } from "vitest";
import { formatCompareTitle, parseNameStatus } from "./diffParse";

describe("parseNameStatus", () => {
  it("parses modified / added / deleted", () => {
    const out = parseNameStatus(
      ["M\tsrc/a.ts", "A\tsrc/b.ts", "D\told.ts"].join("\n"),
    );
    expect(out).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "old.ts", status: "D" },
    ]);
  });

  it("uses new path for renames and copies", () => {
    const out = parseNameStatus(
      ["R100\told/name.ts\tnew/name.ts", "C050\ta.ts\tb.ts"].join("\n"),
    );
    expect(out).toEqual([
      { path: "new/name.ts", status: "R100" },
      { path: "b.ts", status: "C050" },
    ]);
  });

  it("ignores empty lines and empty paths", () => {
    expect(parseNameStatus("\n\nM\t\n")).toEqual([]);
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("formatCompareTitle", () => {
  it("formats commit vs commit", () => {
    expect(formatCompareTitle("a1b2c3d", "deadbeef", "deadbee")).toBe(
      "a1b2c3d → deadbee",
    );
  });

  it("formats commit vs worktree", () => {
    expect(formatCompareTitle("a1b2c3d", "worktree")).toBe(
      "a1b2c3d → worktree",
    );
  });
});
