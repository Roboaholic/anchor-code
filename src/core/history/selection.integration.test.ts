/**
 * Integration-style pure flow: dual-select → compare label → swap.
 * Keeps the HITL compare UX rules locked without Electron.
 */
import { describe, expect, it } from "vitest";
import {
  compareLabel,
  swapSelection,
  toggleCommitSelection,
} from "./selection";
import { formatCompareTitle } from "./diffParse";

describe("compare UX flow", () => {
  it("first=base, second=head, swap flips title", () => {
    let sel: string[] = [];
    let r = toggleCommitSelection(sel, "aaaaaaaa");
    expect(r.ok).toBe(true);
    if (r.ok) sel = r.selectedHashes;

    r = toggleCommitSelection(sel, "bbbbbbbb");
    expect(r.ok).toBe(true);
    if (r.ok) sel = r.selectedHashes;

    const shortOf = (h: string) => h.slice(0, 7);
    expect(compareLabel(sel, shortOf)).toBe("aaaaaaa → bbbbbbb");

    sel = swapSelection(sel);
    expect(compareLabel(sel, shortOf)).toBe("bbbbbbb → aaaaaaa");
    expect(
      formatCompareTitle(shortOf(sel[0]!), sel[1]!, shortOf(sel[1]!)),
    ).toBe("bbbbbbb → aaaaaaa");
  });

  it("single selection labels worktree compare", () => {
    const r = toggleCommitSelection([], "cccccccc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(compareLabel(r.selectedHashes, (h) => h.slice(0, 7))).toBe(
      "ccccccc → worktree",
    );
    expect(formatCompareTitle("ccccccc", "worktree")).toBe(
      "ccccccc → worktree",
    );
  });
});
