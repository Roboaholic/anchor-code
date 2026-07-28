import { describe, expect, it } from "vitest";
import {
  collapseWs,
  findAllIndices,
  locateSelectionInMarkdown,
} from "./mdSelection";

const SAMPLE = `# Title

Hello **world** and more.

## Section

This paragraph has a distinctive phrase for review.
Another line follows.
`;

describe("locateSelectionInMarkdown", () => {
  it("maps exact multi-word selection to source lines", () => {
    const anchor = locateSelectionInMarkdown(
      SAMPLE,
      "distinctive phrase for review",
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.selectedText).toBe("distinctive phrase for review");
    expect(anchor!.startLine).toBe(7);
    expect(SAMPLE.split("\n")[anchor!.startLine - 1]).toContain(
      "distinctive phrase",
    );
    // Immediate previous source line (blank in this fixture).
    expect(anchor!.beforeContext).toBe("");
    expect(anchor!.afterContext).toBe("Another line follows.");
  });

  it("maps heading text", () => {
    const anchor = locateSelectionInMarkdown(SAMPLE, "Title");
    expect(anchor).not.toBeNull();
    expect(anchor!.startLine).toBe(1);
    expect(anchor!.lineText).toContain("Title");
  });

  it("returns null for empty selection", () => {
    expect(locateSelectionInMarkdown(SAMPLE, "   ")).toBeNull();
  });

  it("fuzzy-matches collapsed whitespace / stripped emphasis", () => {
    // Rendered selection often drops ** markers and collapses spaces.
    const anchor = locateSelectionInMarkdown(
      SAMPLE,
      "Hello  world  and more.",
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.startLine).toBe(3);
    expect(anchor!.lineText).toContain("world");
  });
});

describe("findAllIndices / collapseWs", () => {
  it("finds multiple hits", () => {
    expect(findAllIndices("aa ba aa", "aa")).toEqual([0, 6]);
  });

  it("collapses whitespace", () => {
    expect(collapseWs(" a \n\n b  ")).toBe("a b");
  });
});
