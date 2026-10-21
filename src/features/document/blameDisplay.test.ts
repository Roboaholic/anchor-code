import { describe, expect, it } from "vitest";
import { fitBlameText, formatBlameTime } from "./blameDisplay";

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
    expect(text).toMatch(/^Author/);
    expect(text).toMatch(/…$/);
  });

  it("returns empty when the source line has no display room", () => {
    expect(fitBlameText(editor(100, 98), 1, "Author", 13)).toBe("");
  });
});

describe("formatBlameTime", () => {
  it("formats relative ages", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(formatBlameTime("2026-01-10T11:30:00Z", now)).toBe("30m ago");
    expect(formatBlameTime("2026-01-09T12:00:00Z", now)).toBe("1d ago");
  });
});
