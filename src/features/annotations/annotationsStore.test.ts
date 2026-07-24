import { describe, expect, it } from "vitest";
import {
  overlapRegionsForModel,
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
