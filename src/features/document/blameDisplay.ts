import type { editor as MonacoEditor } from "monaco-editor";

/** Fit injected blame text into the remainder of one visual editor line. */
export function fitBlameText(
  editor: MonacoEditor.IStandaloneCodeEditor,
  line: number,
  text: string,
  fontSize: number,
): string {
  const model = editor.getModel();
  if (!model || line < 1 || line > model.getLineCount()) return "";
  const lineEnd = model.getLineMaxColumn(line);
  const usedWidth = editor.getOffsetForColumn(line, lineEnd);
  const availableWidth = Math.max(0, editor.getLayoutInfo().contentWidth - usedWidth - 16);
  const averageGlyphWidth = Math.max(6, fontSize * 0.62);
  const maxChars = Math.floor(availableWidth / averageGlyphWidth);
  if (maxChars < 3) return "";
  const prefix = "  ";
  const availableTextChars = maxChars - prefix.length;
  if (text.length <= availableTextChars) return `${prefix}${text}`;
  if (availableTextChars < 2) return "";
  return `${prefix}${text.slice(0, availableTextChars - 1).trimEnd()}…`;
}
