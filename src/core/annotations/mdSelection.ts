/**
 * Map a browser selection (from rendered Markdown) back onto the raw
 * Markdown source so comments still store line/column anchors.
 */

export type MarkdownSourceAnchor = {
  startLine: number;
  endLine: number;
  /** 1-based columns, same as Monaco / session targets. */
  startColumn: number;
  endColumn: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  lineText: string;
};

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Collapse runs of whitespace to a single space for fuzzy locate. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < safe; i++) {
    if (content[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, column: col };
}

function lineAt(lines: string[], line1: number): string {
  return lines[line1 - 1] ?? "";
}

function buildAnchorFromOffsets(
  content: string,
  start: number,
  end: number,
  selectedText: string,
): MarkdownSourceAnchor {
  const lines = content.split("\n");
  const a = offsetToLineCol(content, start);
  const endPos = offsetToLineCol(content, end);
  const startLine = a.line;
  const endLine = endPos.line;
  const startColumn = a.column;
  const endColumn = endPos.column;
  return {
    startLine,
    endLine,
    startColumn,
    endColumn,
    selectedText,
    beforeContext: startLine > 1 ? lineAt(lines, startLine - 1) : "",
    afterContext:
      endLine < lines.length ? lineAt(lines, endLine + 1) : "",
    lineText: lineAt(lines, startLine),
  };
}

/** All start offsets of `needle` in `haystack`. */
export function findAllIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + Math.max(1, needle.length);
  }
  return out;
}

/**
 * Locate selected browser text inside raw Markdown source.
 * Prefer exact match; fall back to collapsed-whitespace match.
 */
export function locateSelectionInMarkdown(
  source: string,
  selectedRaw: string,
): MarkdownSourceAnchor | null {
  const content = normalizeNewlines(source);
  const selected = normalizeNewlines(selectedRaw);
  const trimmed = selected.trim();
  if (!trimmed) return null;

  // 1) Exact substring (preserve user selection text when possible).
  const exactHits = findAllIndices(content, selected);
  if (exactHits.length === 1) {
    const start = exactHits[0]!;
    return buildAnchorFromOffsets(
      content,
      start,
      start + selected.length,
      selected,
    );
  }
  if (exactHits.length > 1) {
    // Prefer first hit; context sandwich improves later relocate.
    const start = exactHits[0]!;
    return buildAnchorFromOffsets(
      content,
      start,
      start + selected.length,
      selected,
    );
  }

  const trimmedHits = findAllIndices(content, trimmed);
  if (trimmedHits.length >= 1) {
    const start = trimmedHits[0]!;
    return buildAnchorFromOffsets(
      content,
      start,
      start + trimmed.length,
      trimmed,
    );
  }

  // 2) Collapsed whitespace + strip light markdown markers from source.
  const needle = collapseWs(trimmed);
  if (!needle) return null;

  const stripMdLight = (s: string) =>
    s.replace(/[*_`~\[\]()>#]/g, " ").replace(/\s+/g, " ").trim();

  const lines = content.split("\n");
  let best: { start: number; end: number; score: number } | null = null;

  const lineStarts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(acc);
    acc += lines[i]!.length + (i < lines.length - 1 ? 1 : 0);
  }

  const needlePlain = stripMdLight(needle);

  for (let i = 0; i < lines.length; i++) {
    let chunk = "";
    for (let j = i; j < lines.length; j++) {
      chunk = j === i ? lines[i]! : `${chunk}\n${lines[j]!}`;
      const collapsed = collapseWs(chunk);
      const plain = stripMdLight(collapsed);
      if (plain.length < needlePlain.length) continue;

      const atPlain = plain.indexOf(needlePlain);
      const atRaw = collapsed.indexOf(needle);
      if (atPlain < 0 && atRaw < 0) {
        if (plain.length > needlePlain.length * 4) break;
        continue;
      }

      const start = lineStarts[i]!;
      const end = lineStarts[j]! + lines[j]!.length;
      const score =
        1000 -
        (j - i) * 10 -
        Math.abs(plain.length - needlePlain.length) +
        (atRaw >= 0 ? 20 : 0);
      if (!best || score > best.score) {
        best = { start, end, score };
      }
      break;
    }
  }

  if (!best) return null;

  const slice = content.slice(best.start, best.end);
  const exactInSlice = slice.indexOf(trimmed);
  if (exactInSlice >= 0) {
    const start = best.start + exactInSlice;
    return buildAnchorFromOffsets(
      content,
      start,
      start + trimmed.length,
      trimmed,
    );
  }

  // Prefer the shortest source line window that still contains distinctive tokens.
  return buildAnchorFromOffsets(
    content,
    best.start,
    best.end,
    slice.trim() || trimmed,
  );
}

/**
 * Read the current window Selection if it lies inside `root`.
 * Returns null when empty or outside.
 */
export function readDomSelectionIn(
  root: HTMLElement | null,
): { text: string; range: Range } | null {
  if (!root || typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  return { text, range: range.cloneRange() };
}

export type MdMarkRect = {
  commentId: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Build overlay rects for annotation highlights by searching text nodes
 * under `root` for each comment's selected_text / line_text.
 */
export function measureCommentMarks(
  root: HTMLElement,
  comments: Array<{
    id: string;
    selectedText: string;
    lineText?: string;
  }>,
  container: HTMLElement,
): MdMarkRect[] {
  const rects: MdMarkRect[] = [];
  const containerRect = container.getBoundingClientRect();
  const full = root.textContent ?? "";

  for (const c of comments) {
    const needle = (c.selectedText || c.lineText || "").trim();
    if (!needle) continue;

    // Prefer exact textContent search index, then walk nodes for a Range.
    let idx = full.indexOf(needle);
    if (idx < 0) {
      const collapsedNeedle = collapseWs(needle);
      // fuzzy: find first text node containing a distinctive token
      const token = collapsedNeedle.split(" ").find((t) => t.length >= 4) ?? "";
      if (!token) continue;
      idx = full.indexOf(token);
      if (idx < 0) continue;
    }

    const range = rangeFromTextIndex(root, idx, Math.min(needle.length, 120));
    if (!range) continue;
    const clientRects = range.getClientRects();
    if (!clientRects.length) continue;
    const r = clientRects[0]!;
    rects.push({
      commentId: c.id,
      left: r.left - containerRect.left + container.scrollLeft,
      top: r.top - containerRect.top + container.scrollTop,
      width: Math.max(8, r.width),
      height: Math.max(14, r.height),
    });
  }
  return rects;
}

/** Create a DOM Range covering [start, start+len) in the concatenated text of root. */
export function rangeFromTextIndex(
  root: HTMLElement,
  start: number,
  length: number,
): Range | null {
  if (length <= 0) return null;
  const end = start + length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (!startNode && pos + len > start) {
      startNode = node;
      startOffset = start - pos;
    }
    if (startNode && pos + len >= end) {
      endNode = node;
      endOffset = end - pos;
      break;
    }
    pos += len;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startOffset));
    range.setEnd(endNode, Math.max(0, Math.min(endNode.data.length, endOffset)));
    return range;
  } catch {
    return null;
  }
}
