import { describe, expect, it } from "vitest";
import { fitBlameText } from "./blameDisplay";

function editor(contentWidth: number, usedWidth: number) {
  return {
    getModel: () => ({ getLineCount: () => 1, getLineMaxColumn: () => 10 }),
    getOffsetForColumn: () => usedWidth,
    getLayoutInfo: () => ({ contentWidth }),
  } as never;
}

describe("fitBlameText", () => {
  it("truncates with an ellipsis to fit the remaining line width", () => {
    const text = fitBlameText(editor(200, 80), 1, "Author · 2d ago · a very long title", 13);
    expect(text).toMatch(/^  Author/);
    expect(text).toMatch(/…$/);
  });

  it("returns empty when the source line has no display room", () => {
    expect(fitBlameText(editor(100, 98), 1, "Author", 13)).toBe("");
  });
});
