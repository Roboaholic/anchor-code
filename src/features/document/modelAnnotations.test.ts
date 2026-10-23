import { describe, expect, it, vi } from "vitest";
import {
  overlapRegionsForModel,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";
import { decorationSpecsForModel } from "./modelAnnotations";

function spec(overrides: Partial<DecorationSpec> = {}): DecorationSpec {
  return {
    commentId: "comment",
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 3,
    hover: "Review this code",
    status: "discussing",
    anchorStatus: "resolved",
    overlapCount: 1,
    ...overrides,
  };
}

/** Match Monaco's strict line access rather than silently accepting bad ranges. */
function model(lines: string[]) {
  return {
    isDisposed: vi.fn(() => false),
    getLineCount: vi.fn(() => lines.length),
    getLineMaxColumn: vi.fn((line: number) => {
      if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
        throw new Error("Illegal value for lineNumber");
      }
      return lines[line - 1]!.length + 1;
    }),
  };
}

describe("decorationSpecsForModel", () => {
  it("does not read a removed line for an unresolved multiline comment", () => {
    const current = model(["shorter file", "remaining text", ""]);
    const stale = spec({ startLine: 40, endLine: 50, endColumn: 1, anchorStatus: "unresolved" });

    expect(decorationSpecsForModel([stale], current)).toEqual([]);
    expect(current.getLineMaxColumn).not.toHaveBeenCalled();
  });

  it("waits for the model to contain ranges resolved against newly loaded text", () => {
    const pending = model(["nonempty older content"]);
    const newer = spec({ startLine: 2, endLine: 3, endColumn: 1 });
    expect(decorationSpecsForModel([newer], pending)).toEqual([]);
    expect(pending.getLineMaxColumn).not.toHaveBeenCalled();

    const loaded = model(["header", "newer content", ""]);
    expect(decorationSpecsForModel([newer], loaded)).toEqual([
      { ...newer, endLine: 2, endColumn: 14 },
    ]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    "rejects malformed coordinate %s before reading the model",
    (coordinate) => {
      for (const key of ["startLine", "endLine", "startColumn", "endColumn"] as const) {
        const current = model(["first line", "second line"]);
        expect(decorationSpecsForModel([spec({ [key]: coordinate })], current)).toEqual([]);
        expect(current.getLineMaxColumn).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects reversed ranges before reading the model", () => {
    const current = model(["first line", "second line"]);
    expect(decorationSpecsForModel([
      spec({ startLine: 2, endLine: 1 }),
      spec({ startColumn: 4, endColumn: 2 }),
    ], current)).toEqual([]);
    expect(current.getLineMaxColumn).not.toHaveBeenCalled();
  });

  it("does not clamp stale columns onto unrelated text", () => {
    const current = model(["abc", "def"]);
    expect(decorationSpecsForModel([
      spec({ startColumn: 5, endColumn: 6 }),
      spec({ endLine: 2, endColumn: 99 }),
    ], current)).toEqual([]);
  });

  it("preserves valid unresolved metadata without converting its visual endpoint", () => {
    const current = model(["first", "second", ""]);
    const unresolved = spec({ endLine: 3, endColumn: 1, anchorStatus: "unresolved" });
    expect(decorationSpecsForModel([unresolved], current)[0]).toBe(unresolved);
    expect(current.getLineMaxColumn.mock.calls).toEqual([[1], [3]]);
  });

  it("converts a valid column-one endpoint at EOF to the previous line end", () => {
    const current = model(["first", "second", ""]);
    const selection = spec({ endLine: 3, endColumn: 1 });
    expect(decorationSpecsForModel([selection], current)).toEqual([
      { ...selection, endLine: 2, endColumn: 7 },
    ]);
  });

  it("keeps overlap calculations within the current model even with huge stale ranges", () => {
    const current = model(["abcdefgh", "abcdefgh", ""]);
    const validated = decorationSpecsForModel([
      spec({ commentId: "wide", startColumn: 2, endLine: 3, endColumn: 1 }),
      spec({ commentId: "inner", startLine: 2, endLine: 2, startColumn: 3, endColumn: 6 }),
      spec({ commentId: "stale", endLine: Number.MAX_SAFE_INTEGER, endColumn: 1 }),
    ], current);
    expect(validated.map((range) => range.commentId)).toEqual(["wide", "inner"]);
    expect(overlapRegionsForModel(validated, current.getLineMaxColumn)).toEqual([
      { startLine: 2, endLine: 2, startColumn: 3, endColumn: 6, depth: 2 },
    ]);
  });

  it("does not read a disposed model", () => {
    const current = model(["first"]);
    current.isDisposed.mockReturnValue(true);
    expect(decorationSpecsForModel([spec()], current)).toEqual([]);
    expect(current.getLineCount).not.toHaveBeenCalled();
    expect(current.getLineMaxColumn).not.toHaveBeenCalled();
  });
});
