/**
 * Best-effort anchor relocation for annotations (anch-review-style).
 *
 * Order:
 *  1) original range still exact-matches selected_text / line_text
 *  2) scored full-doc search of selected_text snippets + line_text
 *  3) before/after context sandwich
 *  4) unresolved (keeps stored coords as fallback paint target)
 */

export type AnchorStatus = "resolved" | "relocated" | "unresolved";

export interface AnchorTarget {
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  selected_text: string;
  before_context: string;
  after_context: string;
  /** First line of selection at capture time (optional, improves match). */
  line_text?: string;
}

export interface ResolvedAnchor {
  status: AnchorStatus;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

type Range = {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
};

function splitLines(content: string): string[] {
  // Keep empty trailing line behavior consistent with indexOf searches on joined text.
  return content.split(/\n/);
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sliceRange(lines: string[], range: Range): string {
  const parts: string[] = [];
  const startIdx = range.startLine - 1;
  const endIdx = range.endLine - 1;
  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i] ?? "";
    if (i === startIdx && i === endIdx) {
      parts.push(line.slice(range.startColumn - 1, range.endColumn - 1));
    } else if (i === startIdx) {
      parts.push(line.slice(range.startColumn - 1));
    } else if (i === endIdx) {
      parts.push(line.slice(0, range.endColumn - 1));
    } else {
      parts.push(line);
    }
  }
  return parts.join("\n");
}

function originalRange(target: AnchorTarget): Range {
  return {
    startLine: target.start_line,
    endLine: target.end_line,
    startColumn: Math.max(1, target.start_column),
    endColumn: Math.max(1, target.end_column),
  };
}

function rangeInBounds(lines: string[], range: Range): boolean {
  if (lines.length === 0) return false;
  if (range.startLine < 1 || range.endLine < range.startLine) return false;
  if (range.endLine > lines.length) return false;
  return true;
}

function rangeStillMatches(
  lines: string[],
  target: AnchorTarget,
  range: Range,
): boolean {
  if (!rangeInBounds(lines, range)) return false;
  const selected = normalizeNewlines(target.selected_text || "");
  if (selected) {
    return sliceRange(lines, range) === selected;
  }
  const lineText = target.line_text ?? "";
  if (lineText) {
    return (lines[range.startLine - 1] ?? "") === lineText;
  }
  return false;
}

function buildSearchSnippets(target: AnchorTarget): string[] {
  const snippets: string[] = [];
  const selected = normalizeNewlines(target.selected_text || "").trim();
  if (selected) snippets.push(selected);

  if (selected) {
    const lines = selected
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) {
      snippets.push(lines.slice(0, 2).join("\n"));
      snippets.push(lines.slice(-2).join("\n"));
      snippets.push(lines[0]!);
    } else if (lines.length === 1) {
      snippets.push(lines[0]!);
    }
  }

  const lineText = (target.line_text || "").trim();
  if (lineText) snippets.push(lineText);

  return Array.from(new Set(snippets.filter(Boolean)));
}

/** Convert absolute char offset → 1-based line/column in `content`. */
function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, column: col };
}

function findSnippetRanges(content: string, snippet: string): Range[] {
  const ranges: Range[] = [];
  if (!snippet) return ranges;
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(snippet, from);
    if (index < 0) break;
    const start = offsetToLineCol(content, index);
    const end = offsetToLineCol(content, index + snippet.length);
    ranges.push({
      startLine: start.line,
      endLine: end.line,
      startColumn: start.column,
      endColumn: end.column,
    });
    from = index + Math.max(1, snippet.length);
  }
  return ranges;
}

function contextLines(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

function scoreCandidate(
  lines: string[],
  target: AnchorTarget,
  range: Range,
): number {
  let score = 0;
  const originalLine = Math.max(1, target.start_line);
  score -= Math.abs(range.startLine - originalLine);

  const before = contextLines(target.before_context);
  const after = contextLines(target.after_context);

  for (let i = 0; i < before.length; i++) {
    const candidateLine = range.startLine - before.length + i;
    if (candidateLine < 1) continue;
    if ((lines[candidateLine - 1] ?? "") === before[i]) score += 20;
  }
  for (let i = 0; i < after.length; i++) {
    const candidateLine = range.endLine + 1 + i;
    if (candidateLine > lines.length) continue;
    if ((lines[candidateLine - 1] ?? "") === after[i]) score += 20;
  }

  // Prefer exact selected_text length matches over truncated snippets.
  const selected = normalizeNewlines(target.selected_text || "");
  if (selected && sliceRange(lines, range) === selected) {
    score += 50;
  }

  return score;
}

function findBestRelocated(
  content: string,
  lines: string[],
  target: AnchorTarget,
): Range | null {
  const snippets = buildSearchSnippets(target);
  if (snippets.length === 0) return null;

  const seen = new Set<string>();
  const candidates: Range[] = [];
  for (const snippet of snippets) {
    for (const range of findSnippetRanges(content, snippet)) {
      const key = `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(range);
    }
  }
  if (candidates.length === 0) return null;

  let best: Range | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const range of candidates) {
    const score = scoreCandidate(lines, target, range);
    if (score > bestScore) {
      bestScore = score;
      best = range;
    }
  }
  return best;
}

function contextSandwich(
  lines: string[],
  target: AnchorTarget,
): Range | null {
  const before = contextLines(target.before_context);
  const after = contextLines(target.after_context);
  if (before.length === 0 || after.length === 0) return null;

  const beforeNeedle = before[before.length - 1]!;
  const afterNeedle = after[0]!;

  let beforeLine = -1;
  let afterLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (beforeLine < 0 && (lines[i] ?? "").includes(beforeNeedle)) {
      beforeLine = i;
    }
    if (
      beforeLine >= 0 &&
      (lines[i] ?? "").includes(afterNeedle) &&
      i > beforeLine
    ) {
      afterLine = i;
      break;
    }
  }
  if (beforeLine < 0 || afterLine <= beforeLine) return null;

  const startLine = beforeLine + 2;
  const endLine = Math.max(startLine, afterLine);
  const startCol = 1;
  const endCol = Math.max(1, (lines[endLine - 1] ?? "").length + 1);
  return {
    startLine,
    endLine,
    startColumn: startCol,
    endColumn: endCol,
  };
}

export function resolveAnchor(
  content: string,
  target: AnchorTarget,
): ResolvedAnchor {
  const normalized = normalizeNewlines(content);
  const lines = splitLines(normalized);
  const original = originalRange(target);

  // 1) Same coords still match
  if (rangeStillMatches(lines, target, original)) {
    return {
      status: "resolved",
      startLine: original.startLine,
      endLine: original.endLine,
      startColumn: original.startColumn,
      endColumn: original.endColumn,
    };
  }

  // 2) Scored relocate via selected_text / line_text snippets
  const relocated = findBestRelocated(normalized, lines, target);
  if (relocated) {
    return {
      status: "relocated",
      startLine: relocated.startLine,
      endLine: relocated.endLine,
      startColumn: relocated.startColumn,
      endColumn: relocated.endColumn,
    };
  }

  // 3) before/after context sandwich
  const sandwich = contextSandwich(lines, target);
  if (sandwich) {
    return {
      status: "relocated",
      startLine: sandwich.startLine,
      endLine: sandwich.endLine,
      startColumn: sandwich.startColumn,
      endColumn: sandwich.endColumn,
    };
  }

  return {
    status: "unresolved",
    startLine: target.start_line,
    endLine: target.end_line,
    startColumn: Math.max(1, target.start_column),
    endColumn: Math.max(1, target.end_column),
  };
}
