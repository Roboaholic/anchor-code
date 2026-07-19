/**
 * Best-effort anchor relocation for annotations.
 * Order: exact line+text → window search → context sandwich → unresolved.
 */

export type AnchorStatus = "resolved" | "unresolved";

export interface AnchorTarget {
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  selected_text: string;
  before_context: string;
  after_context: string;
}

export interface ResolvedAnchor {
  status: AnchorStatus;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export function resolveAnchor(
  content: string,
  target: AnchorTarget,
): ResolvedAnchor {
  const lines = content.split("\n");
  const selected = target.selected_text;
  const startIdx = Math.max(0, target.start_line - 1);
  const endIdx = Math.min(lines.length - 1, target.end_line - 1);

  // 1) Same line range + selected_text
  if (selected && startIdx <= endIdx && startIdx < lines.length) {
    const slice = lines.slice(startIdx, endIdx + 1).join("\n");
    if (slice.includes(selected) || lines[startIdx]?.includes(selected)) {
      return {
        status: "resolved",
        startLine: target.start_line,
        endLine: target.end_line,
        startColumn: target.start_column,
        endColumn: target.end_column,
      };
    }
  }

  // 2) Expand window search for selected_text
  if (selected) {
    const window = 40;
    const from = Math.max(0, startIdx - window);
    const to = Math.min(lines.length, endIdx + window + 1);
    for (let i = from; i < to; i++) {
      const col = lines[i]!.indexOf(selected);
      if (col >= 0) {
        const endCol = col + selected.length;
        const endLineOffset = selected.includes("\n")
          ? selected.split("\n").length - 1
          : 0;
        return {
          status: "resolved",
          startLine: i + 1,
          endLine: i + 1 + endLineOffset,
          startColumn: col + 1,
          endColumn: endCol + 1,
        };
      }
    }
    // full file fallback
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i]!.indexOf(selected);
      if (col >= 0) {
        return {
          status: "resolved",
          startLine: i + 1,
          endLine: i + 1,
          startColumn: col + 1,
          endColumn: col + selected.length + 1,
        };
      }
    }
  }

  // 3) before + after context sandwich
  const before = target.before_context?.trim();
  const after = target.after_context?.trim();
  if (before && after) {
    let beforeLine = -1;
    let afterLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (beforeLine < 0 && lines[i]!.includes(before)) beforeLine = i;
      if (beforeLine >= 0 && lines[i]!.includes(after) && i > beforeLine) {
        afterLine = i;
        break;
      }
    }
    if (beforeLine >= 0 && afterLine > beforeLine) {
      return {
        status: "resolved",
        startLine: beforeLine + 2,
        endLine: Math.max(beforeLine + 2, afterLine),
        startColumn: 1,
        endColumn: 1,
      };
    }
  }

  return {
    status: "unresolved",
    startLine: target.start_line,
    endLine: target.end_line,
    startColumn: target.start_column,
    endColumn: target.end_column,
  };
}
