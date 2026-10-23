import type { editor as MonacoEditor } from "monaco-editor";
import {
  visualDecorationSpec,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";

type AnnotationModel = Pick<
  MonacoEditor.ITextModel,
  "getLineCount" | "getLineMaxColumn" | "isDisposed"
>;

function isCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Stored anchors and newly loaded text can describe a different model version.
 * Discard invalid ranges before calling Monaco's strict line accessors; moving
 * an out-of-range anchor onto the nearest line would highlight unrelated code.
 */
export function decorationSpecsForModel(
  specs: DecorationSpec[],
  model: AnnotationModel,
): DecorationSpec[] {
  if (model.isDisposed()) return [];
  const lineCount = model.getLineCount();
  if (!isCoordinate(lineCount)) return [];

  const columns = new Map<number, number>();
  const lineMaxColumn = (line: number): number => {
    let column = columns.get(line);
    if (column === undefined) {
      column = model.getLineMaxColumn(line);
      columns.set(line, column);
    }
    return column;
  };

  const valid: DecorationSpec[] = [];
  for (const spec of specs) {
    if (
      !isCoordinate(spec.startLine) || !isCoordinate(spec.endLine) ||
      !isCoordinate(spec.startColumn) || !isCoordinate(spec.endColumn) ||
      spec.startLine > spec.endLine || spec.endLine > lineCount ||
      (spec.startLine === spec.endLine && spec.startColumn > spec.endColumn)
    ) continue;

    if (
      spec.startColumn > lineMaxColumn(spec.startLine) ||
      spec.endColumn > lineMaxColumn(spec.endLine)
    ) continue;

    // Unresolved coordinates remain metadata, not a range we paint or extend.
    valid.push(spec.anchorStatus === "unresolved"
      ? spec
      : visualDecorationSpec(spec, lineMaxColumn));
  }
  return valid;
}
