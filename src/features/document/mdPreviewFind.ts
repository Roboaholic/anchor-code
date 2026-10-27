/** Pure helpers for Markdown rendered-preview find-in-file. */

export type FindSpan = { start: number; end: number };

/**
 * Non-overlapping literal matches of `query` in `text`.
 * Empty query → no matches (find bar stays open but inactive).
 */
export function findTextSpans(
  text: string,
  query: string,
  caseSensitive = false,
): FindSpan[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const out: FindSpan[] = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return out;
}

/** Advance/retreat active match index with wrap-around. `-1` means none yet. */
export function stepMatchIndex(
  current: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return (current + direction + total) % total;
}

export type TextChunk = { node: Text; start: number; end: number };

/** Flatten visible text nodes under `root` into absolute offset chunks. */
export function collectTextChunks(root: HTMLElement): {
  text: string;
  chunks: TextChunk[];
} {
  const chunks: TextChunk[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const t = node as Text;
    // Skip empty nodes so offsets stay aligned with rendered text.
    if (t.data.length > 0) {
      const start = text.length;
      text += t.data;
      chunks.push({ node: t, start, end: text.length });
    }
    node = walker.nextNode();
  }
  return { text, chunks };
}

/** Map an absolute [start, end) span onto a DOM Range across text chunks. */
export function rangeForSpan(
  chunks: TextChunk[],
  span: FindSpan,
): Range | null {
  if (span.start >= span.end || chunks.length === 0) return null;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const chunk of chunks) {
    if (!startNode && span.start >= chunk.start && span.start < chunk.end) {
      startNode = chunk.node;
      startOffset = span.start - chunk.start;
    }
    // end is exclusive; a span ending exactly at chunk.end lands at offset length.
    if (!endNode && span.end > chunk.start && span.end <= chunk.end) {
      endNode = chunk.node;
      endOffset = span.end - chunk.start;
    }
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

export function rangesForSpans(
  chunks: TextChunk[],
  spans: FindSpan[],
): Range[] {
  const ranges: Range[] = [];
  for (const span of spans) {
    const range = rangeForSpan(chunks, span);
    if (range) ranges.push(range);
  }
  return ranges;
}

const HIGHLIGHT_ALL = "md-find";
const HIGHLIGHT_CURRENT = "md-find-current";

export function clearMdFindHighlights(): void {
  const highlights = (
    globalThis as unknown as { CSS?: { highlights?: { delete(name: string): void } } }
  ).CSS?.highlights;
  if (!highlights) return;
  highlights.delete(HIGHLIGHT_ALL);
  highlights.delete(HIGHLIGHT_CURRENT);
}

/** Paint matches via CSS Custom Highlight API (Chromium / Electron). */
export function applyMdFindHighlights(
  ranges: Range[],
  activeIndex: number,
): boolean {
  const CSSRef = (
    globalThis as unknown as {
      CSS?: {
        highlights?: {
          set(name: string, value: unknown): void;
          delete(name: string): void;
        };
      };
      Highlight?: new (...ranges: Range[]) => unknown;
    }
  );
  const highlights = CSSRef.CSS?.highlights;
  const HighlightCtor = CSSRef.Highlight;
  if (!highlights || !HighlightCtor) {
    clearMdFindHighlights();
    return false;
  }
  if (ranges.length === 0) {
    clearMdFindHighlights();
    return true;
  }
  highlights.set(HIGHLIGHT_ALL, new HighlightCtor(...ranges));
  if (activeIndex >= 0 && activeIndex < ranges.length) {
    highlights.set(HIGHLIGHT_CURRENT, new HighlightCtor(ranges[activeIndex]!));
  } else {
    highlights.delete(HIGHLIGHT_CURRENT);
  }
  return true;
}

/** Scroll the active match into view inside `container` (nearest scrollport). */
export function scrollRangeIntoView(
  range: Range,
  container: HTMLElement,
): void {
  // jsdom Ranges lack getClientRects; skip scrolling in that environment.
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
  const rect = (rects && rects[0]) || (typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : null);
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) return;
  const crect = container.getBoundingClientRect();
  const top = rect.top - crect.top + container.scrollTop;
  const margin = 64;
  if (top < container.scrollTop + margin) {
    container.scrollTo({ top: Math.max(0, top - margin), behavior: "smooth" });
  } else if (top + rect.height > container.scrollTop + container.clientHeight - margin) {
    container.scrollTo({
      top: Math.max(0, top - container.clientHeight / 2 + rect.height / 2),
      behavior: "smooth",
    });
  }
}

/**
 * Whether the Markdown rendered-preview Ctrl/Cmd+F handler should claim the
 * keydown. Inactive/hidden document panes must not steal find from Monaco
 * (or another tab) — DocumentArea keeps previously opened panes mounted.
 *
 * When there is no `.document-area__pane` ancestor (unit tests / standalone),
 * the pane is treated as active.
 */
export function shouldClaimMarkdownFindShortcut(input: {
  pane: Element | null;
  surface: Element;
  activeElement: Element | null;
  findOpen: boolean;
  selectionInsideSurface: boolean;
}): boolean {
  const { pane, surface, activeElement, findOpen, selectionInsideSurface } = input;
  if (pane) {
    if (pane instanceof HTMLElement && pane.hidden) return false;
    if (pane.getAttribute("aria-hidden") === "true") return false;
    if (!pane.classList.contains("is-active")) return false;
  }

  if (findOpen) return true;
  if (selectionInsideSurface) return true;

  const active = activeElement;
  if (!active) return true;
  if (active === document.body || active === document.documentElement) return true;
  if (surface.contains(active)) return true;
  if (active.closest(".md-find-bar, .md-viewer__rendered")) return true;
  // Focus lives elsewhere (terminal, file tree, Monaco in another view, …).
  return false;
}
