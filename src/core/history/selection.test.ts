import { describe, expect, it } from "vitest";
import {
  WORKTREE_SELECTION,
  compareLabel,
  orderSelectionByHistory,
  resolveCompareRange,
  swapSelection,
  toggleCommitSelection,
} from "./selection";

describe("toggleCommitSelection", () => {
  it("selects first commit as base", () => {
    const r = toggleCommitSelection([], "aaa");
    expect(r).toEqual({ ok: true, selectedHashes: ["aaa"] });
  });

  it("selects second commit as head (order preserved)", () => {
    const r = toggleCommitSelection(["aaa"], "bbb");
    expect(r).toEqual({ ok: true, selectedHashes: ["aaa", "bbb"] });
  });

  it("rejects a third selection without mutating state", () => {
    const r = toggleCommitSelection(["aaa", "bbb"], "ccc");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/two/i);
      expect(r.selectedHashes).toEqual(["aaa", "bbb"]);
    }
  });

  it("deselects an already selected hash and reorders remaining", () => {
    const r = toggleCommitSelection(["aaa", "bbb"], "aaa");
    expect(r).toEqual({ ok: true, selectedHashes: ["bbb"] });
  });

  it("deselects head leaving base only", () => {
    const r = toggleCommitSelection(["aaa", "bbb"], "bbb");
    expect(r).toEqual({ ok: true, selectedHashes: ["aaa"] });
  });
});

describe("swapSelection", () => {
  it("swaps base and head when two selected", () => {
    expect(swapSelection(["base", "head"])).toEqual(["head", "base"]);
  });

  it("is a no-op for fewer than two", () => {
    expect(swapSelection([])).toEqual([]);
    expect(swapSelection(["only"])).toEqual(["only"]);
  });
});

describe("compareLabel", () => {
  const shortOf = (h: string) => h.slice(0, 3);

  it("shows base → head for two commits", () => {
    expect(compareLabel(["abcdef", "123456"], shortOf)).toBe("abc → 123");
  });

  it("shows base → worktree for one commit", () => {
    expect(compareLabel(["abcdef"], shortOf)).toBe("abc → worktree");
  });

  it("shows HEAD → worktree for uncommitted alone", () => {
    expect(compareLabel([WORKTREE_SELECTION], shortOf)).toBe("HEAD → worktree");
  });

  it("returns null when empty", () => {
    expect(compareLabel([], shortOf)).toBeNull();
  });
});

describe("orderSelectionByHistory", () => {
  const newestFirst = ["new", "middle", "old"];

  it("places the older selected commit first regardless of click order", () => {
    expect(orderSelectionByHistory(["new", "old"], newestFirst)).toEqual([
      "old",
      "new",
    ]);
    expect(orderSelectionByHistory(["old", "new"], newestFirst)).toEqual([
      "old",
      "new",
    ]);
  });

  it("always places worktree on the newer side", () => {
    expect(
      orderSelectionByHistory([WORKTREE_SELECTION, "middle"], newestFirst),
    ).toEqual(["middle", WORKTREE_SELECTION]);
  });
});

describe("resolveCompareRange", () => {
  it("maps worktree alone to HEAD → worktree", () => {
    expect(resolveCompareRange([WORKTREE_SELECTION])).toEqual({
      base: "HEAD",
      head: "worktree",
    });
  });

  it("maps commit + worktree", () => {
    expect(resolveCompareRange(["aaa", WORKTREE_SELECTION])).toEqual({
      base: "aaa",
      head: "worktree",
    });
  });

  it("maps two commits", () => {
    expect(resolveCompareRange(["aaa", "bbb"])).toEqual({
      base: "aaa",
      head: "bbb",
    });
  });
});
