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

describe("locateSelectionInMarkdown with a line scope", () => {
  const DOC = [
    "# Doc", // 1
    "", // 2
    'Node V["预览启停"] is described here.', // 3
    "", // 4
    "```mermaid", // 5
    "flowchart TB", // 6
    '    V["预览启停"]', // 7
    "    V --> R", // 8
    "```", // 9
    "",
  ].join("\n");

  it("anchors inside the scoped fence even when the text appears earlier", () => {
    const global = locateSelectionInMarkdown(DOC, 'V["预览启停"]');
    expect(global?.startLine).toBe(3);

    const scoped = locateSelectionInMarkdown(DOC, 'V["预览启停"]', {
      startLine: 5,
      endLine: 9,
    });
    expect(scoped).toMatchObject({
      startLine: 7,
      endLine: 7,
      startColumn: 5,
      lineText: '    V["预览启停"]',
      beforeContext: "flowchart TB",
      afterContext: "    V --> R",
    });
  });

  it("maps multi-line selections inside the scope to whole-file lines", () => {
    const scoped = locateSelectionInMarkdown(DOC, 'flowchart TB\n    V["预览启停"]', {
      startLine: 5,
      endLine: 9,
    });
    expect(scoped?.startLine).toBe(6);
    expect(scoped?.endLine).toBe(7);
  });

  it("falls back to the whole file when the scope has no match", () => {
    const anchor = locateSelectionInMarkdown(DOC, "is described here", {
      startLine: 5,
      endLine: 9,
    });
    expect(anchor?.startLine).toBe(3);
  });
});
