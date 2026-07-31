import { describe, expect, it } from "vitest";
import {
  focusedSessionForDecorations,
  overlapRegionsForModel,
  visualDecorationSpec,
  type DecorationSpec,
} from "./annotationsStore";

function spec(
  commentId: string,
  startColumn: number,
  endColumn: number,
): DecorationSpec {
  return {
    commentId,
    startLine: 71,
    endLine: 71,
    startColumn,
    endColumn,
    hover: "",
    status: "discussing",
    anchorStatus: "resolved",
    overlapCount: 1,
  };
}

describe("visualDecorationSpec", () => {
  it("stops a multiline column-one endpoint at the previous line end", () => {
    const multiline = { ...spec("multi", 4, 1), startLine: 10, endLine: 12 };

    expect(visualDecorationSpec(multiline, (line) => (line === 11 ? 24 : 1))).toMatchObject({
      startLine: 10,
      startColumn: 4,
      endLine: 11,
      endColumn: 24,
    });
  });

  it("keeps other ranges unchanged", () => {
    const range = { ...spec("multi", 4, 7), startLine: 10, endLine: 12 };
    expect(visualDecorationSpec(range, () => 99)).toBe(range);
  });
});

describe("overlapRegionsForModel", () => {
  it("darkens only the intersection of contained comments", () => {
    const regions = overlapRegionsForModel(
      [spec("what", 24, 28), spec("yo", 19, 45)],
      () => 60,
    );

    expect(regions).toEqual([
      {
        startLine: 71,
        endLine: 71,
        startColumn: 24,
        endColumn: 28,
        depth: 2,
      },
    ]);
  });

  it("splits regions when overlap depth changes", () => {
    const regions = overlapRegionsForModel(
      [spec("wide", 10, 40), spec("middle", 20, 35), spec("inner", 25, 30)],
      () => 60,
    );

    expect(regions.map(({ startColumn, endColumn, depth }) => ({
      startColumn,
      endColumn,
      depth,
    }))).toEqual([
      { startColumn: 20, endColumn: 25, depth: 2 },
      { startColumn: 25, endColumn: 30, depth: 3 },
      { startColumn: 30, endColumn: 35, depth: 2 },
    ]);
  });
});

describe("focusedSessionForDecorations", () => {
  const first = { id: "first", comments: [] } as never;
  const active = { id: "active", comments: [] } as never;

  it("uses the explicitly selected sidebar session", () => {
    expect(focusedSessionForDecorations([active, first], "first", active)).toBe(
      first,
    );
  });

  it("falls back to active then first session", () => {
    expect(focusedSessionForDecorations([active, first], null, active)).toBe(
      active,
    );
    expect(focusedSessionForDecorations([first], null, null)).toBe(first);
  });
});
