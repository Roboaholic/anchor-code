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
  const prefix = "";
  const availableTextChars = maxChars - prefix.length;
  if (text.length <= availableTextChars) return `${prefix}${text}`;
  if (availableTextChars < 2) return "";
  return `${prefix}${text.slice(0, availableTextChars - 1).trimEnd()}…`;
}


/** Relative age for inline blame (shared by code + diff viewers). */
export function formatBlameTime(dateIso: string, nowMs = Date.now()): string {
  const timestamp = Date.parse(dateIso);
  if (!Number.isFinite(timestamp)) return "unknown time";
  const elapsed = Math.max(0, nowMs - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const year = 365 * day;
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < year) return `${Math.floor(elapsed / day)}d ago`;
  return `${Math.floor(elapsed / year)}y ago`;
}
