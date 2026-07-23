import { describe, expect, it } from "vitest";
import {
  buildDiffCommentPrefix,
  isSelectionLockedOut,
  shortRev,
} from "./diffComment";

describe("shortRev", () => {
  it("keeps worktree and HEAD", () => {
    expect(shortRev("worktree")).toBe("worktree");
    expect(shortRev("HEAD")).toBe("HEAD");
  });

  it("shortens long hashes", () => {
    expect(shortRev("1571048abcdef0123456789")).toBe("1571048");
  });

  it("keeps short tokens", () => {
    expect(shortRev("abc1234")).toBe("abc1234");
  });
});

describe("buildDiffCommentPrefix", () => {
  it("includes branch, base, head, and file line range", () => {
    const p = buildDiffCommentPrefix({
      branch: "master",
      base: "aaaaaaaaaaaaaaaa",
      head: "worktree",
      filePath: "docs/a.md",
      startLine: 10,
      endLine: 12,
    });
    expect(p).toContain("[diff context]");
    expect(p).toContain("branch: master");
    expect(p).toContain("base: aaaaaaa");
    expect(p).toContain("head: worktree");
    expect(p).toContain("file: docs/a.md (L10–12, newer side)");
    expect(p.endsWith("\n")).toBe(true);
  });

  it("uses unknown branch when missing", () => {
    const p = buildDiffCommentPrefix({
      branch: null,
      base: "HEAD",
      head: "bbbbbbbbbbbbbbbb",
      filePath: "x.ts",
      startLine: 3,
      endLine: 3,
    });
    expect(p).toContain("branch: (detached/unknown)");
    expect(p).toContain("base: HEAD");
    expect(p).toContain("head: bbbbbbb");
    expect(p).toContain("L3, newer side");
  });
});

describe("isSelectionLockedOut", () => {
  it("locks unselected rows when two selected", () => {
    expect(isSelectionLockedOut(["a", "b"], "c")).toBe(true);
    expect(isSelectionLockedOut(["a", "b"], "a")).toBe(false);
  });

  it("does not lock when fewer than max", () => {
    expect(isSelectionLockedOut(["a"], "b")).toBe(false);
    expect(isSelectionLockedOut([], "a")).toBe(false);
  });
});
