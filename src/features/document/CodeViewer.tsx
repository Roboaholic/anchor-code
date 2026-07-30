import {
  accentHex,
  EDITOR_FONT_FAMILY,
  editorLineHeight,
  monacoThemeId,
} from "@/core/theme/theme";
import { useThemeStore } from "@/features/shell/themeStore";
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { CommentBubble } from "@/features/annotations/CommentBubble";
import {
  overlapRegionsForModel,
  useAnnotationsStore,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";
import { addCommentFromSelection } from "@/features/shell/orchestrate";
import type { BlameLine, CommentRecord } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import { relativeToRoot } from "@/core/workspace/paths";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { SearchHighlight } from "./documentStore";
import { fitBlameText } from "./blameDisplay";
import "./monacoSetup";

type BubbleState = {
  commentId: string;
  /** Every annotation thread hit at the same source position. */
  relatedCommentIds: string[];
  left: number;
  top: number;
};

type SelectionToolbarState = {
  left: number;
  top: number;
};

const HOVER_OPEN_MS = 420;
const HOVER_CLOSE_MS = 220;

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

/** Resolve the column range of a search hit on a single line (1-based columns). */
export function matchRangeOnLine(
  lineText: string,
  query: string,
  useRegex: boolean,
  caseSensitive: boolean,
): { startColumn: number; endColumn: number } | null {
  if (!query || !lineText) return null;
  try {
    let re: RegExp;
    if (useRegex) {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } else {
      const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(esc, caseSensitive ? "" : "i");
    }
    const m = lineText.match(re);
    if (!m || m.index === undefined || m[0] === "") return null;
    return {
      startColumn: m.index + 1,
      endColumn: m.index + m[0].length + 1,
    };
  } catch {
    return null;
  }
}

/** Map anchor coords into the overlay (editor-local → container-local). */
function positionForSpec(
  ed: MonacoEditor.IStandaloneCodeEditor,
  spec: DecorationSpec,
  overlay: HTMLElement,
): { left: number; top: number } | null {
  const pos = ed.getScrolledVisiblePosition({
    lineNumber: spec.startLine,
    column: Math.max(1, spec.startColumn || 1),
  });
  if (!pos) return null;
  const edDom = ed.getDomNode();
  if (!edDom) return null;
  const edRect = edDom.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const rawLeft = edRect.left - overlayRect.left + pos.left + 12;
  const rawTop = edRect.top - overlayRect.top + pos.top + pos.height + 6;
  const left = Math.min(
    Math.max(8, rawLeft),
    Math.max(8, overlay.clientWidth - 320),
  );
  const top = Math.max(8, rawTop);
  return { left, top };
}

/** Top-right of the selection block → overlay-local coords for the add-comment chip. */
function positionForSelectionTopRight(
  ed: MonacoEditor.IStandaloneCodeEditor,
  sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  overlay: HTMLElement,
): { left: number; top: number } | null {
  const model = ed.getModel();
  if (!model) return null;
  const startLine = Math.min(sel.startLineNumber, sel.endLineNumber);
  const endLine = Math.max(sel.startLineNumber, sel.endLineNumber);
  const forward =
    sel.startLineNumber < sel.endLineNumber ||
    (sel.startLineNumber === sel.endLineNumber &&
      sel.startColumn <= sel.endColumn);
  const startCol = forward ? sel.startColumn : sel.endColumn;
  const endCol = forward ? sel.endColumn : sel.startColumn;
  const colOnFirst =
    startLine === endLine
      ? Math.max(startCol, endCol)
      : model.getLineMaxColumn(startLine);
  const pos = ed.getScrolledVisiblePosition({
    lineNumber: startLine,
    column: colOnFirst,
  });
  if (!pos) return null;
  const edDom = ed.getDomNode();
  if (!edDom) return null;
  const edRect = edDom.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const iconSize = 28;
  const rawLeft = edRect.left - overlayRect.left + pos.left + 2;
  const rawTop = edRect.top - overlayRect.top + pos.top - iconSize - 4;
  const left = Math.min(
    Math.max(4, rawLeft),
    Math.max(4, overlay.clientWidth - iconSize - 4),
  );
  const top = Math.max(4, rawTop);
  return { left, top };
}

function findSpecsAt(
  specs: DecorationSpec[],
  line: number,
  column: number,
): DecorationSpec[] {
  const hits: Array<{ spec: DecorationSpec; span: number }> = [];
  for (const s of specs) {
    if (s.anchorStatus === "unresolved") continue;
    if (line < s.startLine || line > s.endLine) continue;
    const startCol = Math.max(1, s.startColumn || 1);
    const endCol = Math.max(startCol, s.endColumn || 1);
    if (s.startLine === s.endLine) {
      if (column < startCol || column > endCol + 1) continue;
    } else {
      if (line === s.startLine && column < startCol) continue;
      if (line === s.endLine && column > endCol + 1) continue;
    }
    hits.push({
      spec: s,
      span: (s.endLine - s.startLine) * 1000 + endCol - startCol,
    });
  }
  return hits.sort((a, b) => a.span - b.span).map((hit) => hit.spec);
}

export function CodeViewer({
  path,
  content,
  language,
  truncated,
  revealLine,
  focusCommentId,
  revealNonce,
  searchHighlight = null,
  kind = "source",
}: {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  revealLine?: number;
  focusCommentId?: string | null;
  revealNonce?: number;
  searchHighlight?: SearchHighlight | null;
  kind?: "source" | "markdown";
}) {
  const theme = useThemeStore((s) => s.theme);
  const fontSize = useThemeStore((s) => s.fontSize);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const lineHeight = editorLineHeight(fontSize);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const searchHighlightRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const blameDecorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const specsRef = useRef<DecorationSpec[]>([]);
  const bubbleRef = useRef<BubbleState | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const pointerOverBubbleRef = useRef(false);
  const pointerOverAnnoRef = useRef(false);
  const mouseDownRef = useRef(false);
  const composerOpenRef = useRef(false);

  const decorationsFor = useAnnotationsStore((s) => s.decorationsFor);
  const activeSession = useAnnotationsStore((s) => s.activeSession);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const sessions = useAnnotationsStore((s) => s.sessions);

  const [composer, setComposer] = useState<{
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    selectedText: string;
    beforeContext: string;
    afterContext: string;
    lineText: string;
    forceNewSession: boolean;
  } | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [selToolbar, setSelToolbar] = useState<SelectionToolbarState | null>(
    null,
  );
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [activeBlameLine, setActiveBlameLine] = useState<number | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  bubbleRef.current = bubble;
  composerOpenRef.current = Boolean(composer);

  useEffect(() => {
    if (!composer) return;
    // Monaco steals focus after selection; re-focus the bar on the next frame.
    const id = window.requestAnimationFrame(() => {
      composerInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [composer]);


  const liveComment = (id: string): CommentRecord | null => {
    const state = useAnnotationsStore.getState();
    for (const session of state.sessions) {
      const found = session.comments.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  };

  const applyDecorations = useCallback(
    (activeCommentId?: string | null) => {
      const ed = editorRef.current;
      if (!ed) return;
      const specs = decorationsFor(path, content);
      specsRef.current = specs;
      const activeId =
        activeCommentId !== undefined
          ? activeCommentId
          : bubbleRef.current?.commentId ?? null;
      const decorations: MonacoEditor.IModelDeltaDecoration[] = specs
        .filter(
          (s) =>
            s.anchorStatus === "resolved" || s.anchorStatus === "relocated",
        )
        .map((s) => {
          const selected = activeId === s.commentId;
          return {
            range: {
              startLineNumber: s.startLine,
              startColumn: Math.max(1, s.startColumn || 1),
              endLineNumber: s.endLine,
              endColumn: Math.max(1, s.endColumn || 1),
            },
            options: {
              inlineClassName: `anno-inline${selected ? " anno-inline--active" : ""}`,
              overviewRuler: {
                color: accentHex(theme),
                position: 4,
              },
              minimap: {
                color: accentHex(theme),
                position: 1,
              },
            },
          };
        });
      const model = ed.getModel();
      if (model) {
        decorations.push(
          ...overlapRegionsForModel(specs, (line) => model.getLineMaxColumn(line)).map(
            (region) => ({
              range: {
                startLineNumber: region.startLine,
                startColumn: region.startColumn,
                endLineNumber: region.endLine,
                endColumn: region.endColumn,
              },
              options: {
                inlineClassName: `anno-inline-intersection anno-inline-intersection--${Math.min(3, region.depth)}`,
              },
            }),
          ),
        );
      }
      if (!decorationsRef.current) {
        decorationsRef.current = ed.createDecorationsCollection();
      }
      decorationsRef.current.set(decorations);

      const open = bubbleRef.current;
      if (!open) return;
      const still = specs.find((s) => s.commentId === open.commentId);
      if (!still) {
        // Spec gone (session switched / comment deleted) — close bubble only.
        bubbleRef.current = null;
        setBubble(null);
        return;
      }
      const overlay = overlayRef.current;
      if (!overlay) return;
      const pos = positionForSpec(ed, still, overlay);
      if (pos) {
        const next = {
          commentId: open.commentId,
          relatedCommentIds: open.relatedCommentIds ?? [],
          ...pos,
        };
        bubbleRef.current = next;
        setBubble(next);
      }
    },
    [content, decorationsFor, path, theme],
  );

  useEffect(() => {
    applyDecorations(focusCommentId ?? bubble?.commentId ?? null);
  }, [
    applyDecorations,
    activeSession,
    expandedSessionId,
    sessions,
    content,
    focusCommentId,
  ]);

  useEffect(() => {
    applyDecorations(bubble?.commentId ?? focusCommentId ?? null);
  }, [applyDecorations, bubble?.commentId, focusCommentId]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.updateOptions({ fontSize, lineHeight });
  }, [fontSize, lineHeight]);

  const paintBlame = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!blameDecorationsRef.current) {
      blameDecorationsRef.current = ed.createDecorationsCollection();
    }
    const model = ed.getModel();
    if (!model || kind !== "source") {
      blameDecorationsRef.current.clear();
      return;
    }
    blameDecorationsRef.current.set(
      blameLines
        .filter(
          (entry) =>
            entry.line === activeBlameLine &&
            entry.line >= 1 &&
            entry.line <= model.getLineCount(),
        )
        .map((entry) => ({
          range: {
            startLineNumber: entry.line,
            startColumn: model.getLineMaxColumn(entry.line),
            endLineNumber: entry.line,
            endColumn: model.getLineMaxColumn(entry.line),
          },
          options: {
            showIfCollapsed: true,
            after: {
              content: fitBlameText(
                ed,
                entry.line,
                `${entry.author} · ${formatBlameTime(entry.dateIso)} · ${entry.subject || "No commit message"}`,
                fontSize,
              ),
              inlineClassName: "git-blame-inline",
            },
          },
        })),
    );
  }, [activeBlameLine, blameLines, fontSize, kind]);

  useEffect(() => {
    let cancelled = false;
    setBlameLines([]);
    setActiveBlameLine(null);
    if (kind !== "source" || truncated) return;
    void (async () => {
      try {
        const repoRoot = await window.anchor.annotations.locateGitRoot(path);
        if (!repoRoot || cancelled) return;
        const lines = await window.anchor.history.fileBlame({ repoRoot, filePath: path });
        if (!cancelled) setBlameLines(lines);
      } catch {
        if (!cancelled) setBlameLines([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, path, content, truncated]);

  useEffect(() => {
    paintBlame();
  }, [paintBlame]);

  /**
   * First open often has clientHeight 0 until flex layout settles — revealLineInCenter
   * then pins the line to the top. Retry until the editor has a real viewport.
   */
  const revealLineWhenReady = useCallback(
    (
      ed: MonacoEditor.IStandaloneCodeEditor,
      line: number,
      range?: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      },
    ) => {
      let tries = 0;
      const maxTries = 40;
      const run = () => {
        const dom = ed.getDomNode();
        const h = dom?.clientHeight ?? 0;
        if (h < 40 && tries < maxTries) {
          tries += 1;
          requestAnimationFrame(run);
          return;
        }
        try {
          ed.layout();
        } catch {
          // ignore
        }
        ed.revealLineInCenter(line);
        if (range) {
          ed.setSelection(range);
        } else {
          ed.setPosition({ lineNumber: line, column: 1 });
        }
        // One more pass after layout paints (first-open safety).
        requestAnimationFrame(() => {
          ed.revealLineInCenter(line);
          if (range) ed.setSelection(range);
        });
      };
      requestAnimationFrame(run);
    },
    [],
  );

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (revealLine) {
      revealLineWhenReady(ed, revealLine);
    }
    requestAnimationFrame(() => {
      applyDecorations(focusCommentId ?? bubbleRef.current?.commentId ?? null);
    });
  }, [
    revealLine,
    revealNonce,
    content,
    applyDecorations,
    focusCommentId,
    revealLineWhenReady,
  ]);

  const paintSearchHighlight = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!searchHighlightRef.current) {
      searchHighlightRef.current = ed.createDecorationsCollection();
    }
    const hl = searchHighlight;
    if (!hl) {
      searchHighlightRef.current.clear();
      return;
    }
    const model = ed.getModel();
    if (!model) return;
    const line = hl.line;
    if (line < 1 || line > model.getLineCount()) {
      searchHighlightRef.current.clear();
      return;
    }
    const lineText = model.getLineContent(line);
    const match = matchRangeOnLine(
      lineText,
      hl.query,
      hl.useRegex === true,
      hl.caseSensitive === true,
    );
    const startColumn = match?.startColumn ?? 1;
    const endColumn = match?.endColumn ?? model.getLineMaxColumn(line);
    const range = {
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn,
    };
    searchHighlightRef.current.set([
      {
        range,
        options: {
          className: "search-jump-line",
          inlineClassName: "search-jump-match",
          isWholeLine: !match,
          overviewRuler: {
            color: accentHex(theme),
            position: 1,
          },
          minimap: {
            color: accentHex(theme),
            position: 1,
          },
        },
      },
    ]);
    revealLineWhenReady(ed, line, range);
    ed.focus();
  }, [searchHighlight, theme, revealLineWhenReady]);

  useEffect(() => {
    paintSearchHighlight();
  }, [paintSearchHighlight, content, searchHighlight?.nonce]);

  useEffect(() => {
    return () => {
      clearHoverOpenTimer();
      clearHoverCloseTimer();
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      searchHighlightRef.current?.clear();
      searchHighlightRef.current = null;
      editorRef.current = null;
    };
  }, []);

  const clearHoverOpenTimer = () => {
    if (hoverOpenTimerRef.current != null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
  };

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const closeBubble = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    pointerOverAnnoRef.current = false;
    pointerOverBubbleRef.current = false;
    bubbleRef.current = null;
    setBubble(null);
    // Re-paint without active modifier after state is cleared.
    requestAnimationFrame(() => applyDecorations(null));
  }, [applyDecorations]);

  const openBubbleForSpecs = useCallback(
    (hits: DecorationSpec[]) => {
      const ed = editorRef.current;
      const overlay = overlayRef.current;
      if (!ed || !overlay || hits.length === 0) return;
      const primary = hits[0]!;
      const pos = positionForSpec(ed, primary, overlay);
      if (!pos) return;
      setComposer(null);
      setSelToolbar(null);
      const next = {
        commentId: primary.commentId,
        relatedCommentIds: hits.slice(1).map((h) => h.commentId),
        ...pos,
      };
      // Sync ref immediately so applyDecorations sees the open bubble.
      bubbleRef.current = next;
      setBubble(next);
      applyDecorations(primary.commentId);
    },
    [applyDecorations],
  );

  const scheduleHoverClose = useCallback(() => {
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      if (pointerOverBubbleRef.current || pointerOverAnnoRef.current) return;
      closeBubble();
    }, HOVER_CLOSE_MS);
  }, [closeBubble]);

  const updateSelectionToolbar = useCallback(() => {
    const ed = editorRef.current;
    const overlay = overlayRef.current;
    // Only show after selection finishes — never while the mouse is still dragging.
    if (!ed || !overlay || composerOpenRef.current || mouseDownRef.current) {
      setSelToolbar(null);
      return;
    }
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) {
      setSelToolbar(null);
      return;
    }
    const pos = positionForSelectionTopRight(ed, sel, overlay);
    setSelToolbar(pos);
  }, []);

  /** End a mouse-drag selection and show the chip after Monaco commits the range. */
  const finishMouseSelection = useCallback(() => {
    if (!mouseDownRef.current) return;
    mouseDownRef.current = false;
    // Double-rAF: wait until Monaco applies the final selection after pointerup.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateSelectionToolbarRef.current();
      });
    });
  }, []);

  // onMount only runs once — always call latest handlers via refs.
  const openBubbleForSpecsRef = useRef(openBubbleForSpecs);
  openBubbleForSpecsRef.current = openBubbleForSpecs;
  const scheduleHoverCloseRef = useRef(scheduleHoverClose);
  scheduleHoverCloseRef.current = scheduleHoverClose;
  const updateSelectionToolbarRef = useRef(updateSelectionToolbar);
  updateSelectionToolbarRef.current = updateSelectionToolbar;
  const finishMouseSelectionRef = useRef(finishMouseSelection);
  finishMouseSelectionRef.current = finishMouseSelection;

  const openComposer = (
    ed: MonacoEditor.IStandaloneCodeEditor,
    forceNewSession = false,
  ) => {
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || !model || sel.isEmpty()) return;
    const selectedText = model.getValueInRange(sel);
    const startLine = sel.startLineNumber;
    const endLine = sel.endLineNumber;
    const beforeContext =
      startLine > 1 ? model.getLineContent(startLine - 1) : "";
    const afterContext =
      endLine < model.getLineCount() ? model.getLineContent(endLine + 1) : "";
    const lineText = model.getLineContent(startLine);
    clearHoverOpenTimer();
    bubbleRef.current = null;
    setBubble(null);
    setSelToolbar(null);
    setComposer({
      startLine,
      endLine,
      startColumn: sel.startColumn,
      endColumn: sel.endColumn,
      selectedText,
      beforeContext,
      afterContext,
      lineText,
      forceNewSession,
    });
    setBody("");
  };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    decorationsRef.current?.clear();
    decorationsRef.current = ed.createDecorationsCollection();
    searchHighlightRef.current?.clear();
    searchHighlightRef.current = ed.createDecorationsCollection();
    blameDecorationsRef.current?.clear();
    blameDecorationsRef.current = ed.createDecorationsCollection();
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    // Re-apply after model is ready (open-from-search before mount).
    requestAnimationFrame(() => {
      applyDecorations(focusCommentId ?? null);
      paintSearchHighlight();
      paintBlame();
    });


    // Hover dwell on annotation highlight → open bubble (not click).
    disposablesRef.current.push(
      ed.onMouseDown((e) => {
        setActiveBlameLine(e.target.position?.lineNumber ?? null);
        const be = e.event.browserEvent as MouseEvent | undefined;
        // Primary button only (0). Treat as potential drag-select.
        if (be && be.button === 0) {
          mouseDownRef.current = true;
          clearHoverOpenTimer();
          // Hide chip immediately when a new drag starts.
          setSelToolbar(null);
          // New click / reselect while comment bar is open → dismiss bar.
          if (composerOpenRef.current) {
            setComposer(null);
            setBody("");
          }
        }
      }),
    );
    // Capture-phase pointer/mouse up on window so we always end the drag
    // (Monaco may not emit onMouseUp if release is outside the editor).
    const onGlobalPointerUp = () => {
      finishMouseSelectionRef.current();
    };
    window.addEventListener("pointerup", onGlobalPointerUp, true);
    window.addEventListener("mouseup", onGlobalPointerUp, true);
    window.addEventListener("blur", onGlobalPointerUp);
    disposablesRef.current.push({
      dispose: () => {
        window.removeEventListener("pointerup", onGlobalPointerUp, true);
        window.removeEventListener("mouseup", onGlobalPointerUp, true);
        window.removeEventListener("blur", onGlobalPointerUp);
      },
    });
    disposablesRef.current.push(
      ed.onMouseLeave(() => {
        pointerOverAnnoRef.current = false;
        clearHoverOpenTimer();
        scheduleHoverCloseRef.current();
      }),
    );
    disposablesRef.current.push(
      ed.onMouseMove((e) => {
        if (mouseDownRef.current || composerOpenRef.current) return;
        if (!e.target.position) {
          if (pointerOverAnnoRef.current) {
            pointerOverAnnoRef.current = false;
            clearHoverOpenTimer();
            scheduleHoverCloseRef.current();
          }
          return;
        }
        const { lineNumber, column } = e.target.position;
        const hits = findSpecsAt(specsRef.current, lineNumber, column);
        if (hits.length === 0) {
          if (pointerOverAnnoRef.current) {
            pointerOverAnnoRef.current = false;
            clearHoverOpenTimer();
            scheduleHoverCloseRef.current();
          }
          return;
        }
        pointerOverAnnoRef.current = true;
        clearHoverCloseTimer();
        const primaryId = hits[0]!.commentId;
        if (bubbleRef.current?.commentId === primaryId) return;
        clearHoverOpenTimer();
        hoverOpenTimerRef.current = window.setTimeout(() => {
          openBubbleForSpecsRef.current(hits);
        }, HOVER_OPEN_MS);
      }),
    );

    disposablesRef.current.push(
      ed.onDidChangeCursorSelection(() => {
        // While dragging, keep chip hidden; after release, finishMouseSelection shows it.
        if (mouseDownRef.current) {
          setSelToolbar(null);
          return;
        }
        updateSelectionToolbarRef.current();
      }),
    );

    disposablesRef.current.push(
      ed.onDidScrollChange(() => {
        updateSelectionToolbarRef.current();
        const open = bubbleRef.current;
        if (!open) return;
        const spec = specsRef.current.find(
          (s) => s.commentId === open.commentId,
        );
        if (!spec) {
          bubbleRef.current = null;
          setBubble(null);
          return;
        }
        const overlay = overlayRef.current;
        if (!overlay) return;
        const pos = positionForSpec(ed, spec, overlay);
        if (pos) {
          const next = {
            commentId: open.commentId,
            relatedCommentIds: open.relatedCommentIds ?? [],
            ...pos,
          };
          bubbleRef.current = next;
          setBubble(next);
        }
      }),
    );

    // Context-menu actions: copy relative path, and copy path with cursor line.
    disposablesRef.current.push(
      ed.addAction({
        id: "anchor-copy-relative-path",
        label: "Copy Relative Path",
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 10,
        run: () => {
          const rel = workspaceRoot
            ? relativeToRoot(workspaceRoot, path)
            : path;
          void navigator.clipboard?.writeText?.(rel);
        },
      }),
    );
    disposablesRef.current.push(
      ed.addAction({
        id: "anchor-copy-path-with-line",
        label: "Copy Path with Line",
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 11,
        precondition: undefined,
        run: (editor) => {
          const sel = editor.getSelection();
          const rel = workspaceRoot
            ? relativeToRoot(workspaceRoot, path)
            : path;
          // Use the selection if present, else the cursor position.
          const start = sel?.startLineNumber;
          const end = sel?.endLineNumber;
          // No selection / cursor on one line → "path:line".
          if (!start || !end || start === end) {
            void navigator.clipboard?.writeText?.(
              `${rel}:${start ?? end ?? 1}`,
            );
            return;
          }
          // Multi-line selection → "path:start-end".
          void navigator.clipboard?.writeText?.(`${rel}:${start}-${end}`);
        },
      }),
    );

    applyDecorations();
  };

  const submit = async (forceNewSession = composer?.forceNewSession ?? false) => {
    if (!composer || !body.trim()) return;
    setSaving(true);
    try {
      await addCommentFromSelection({
        filePath: path,
        kind,
        startLine: composer.startLine,
        endLine: composer.endLine,
        startColumn: composer.startColumn,
        endColumn: composer.endColumn,
        selectedText: composer.selectedText,
        beforeContext: composer.beforeContext,
        afterContext: composer.afterContext,
        lineText: composer.lineText,
        body: body.trim(),
        forceNewSession,
      });
      setComposer(null);
      setBody("");
      applyDecorations();
    } finally {
      setSaving(false);
    }
  };

  const bubbleComment = bubble ? liveComment(bubble.commentId) : null;
  const relatedBubbleComments = bubble
    ? bubble.relatedCommentIds
        .map((id) => liveComment(id))
        .filter((c): c is CommentRecord => Boolean(c))
    : [];

  return (
    <div className="code-viewer">
      {truncated ? (
        <div className="banner banner--warn">
          File is larger than 1 MB — showing the first portion only ({path}).
        </div>
      ) : null}
      <div className="code-viewer__editor" ref={overlayRef}>
        <Editor
          path={path}
          language={language}
          value={content}
          theme={monacoThemeId(theme)}
          onMount={onMount}
          options={{
            readOnly: true,
            // Keep DOM editable enough for reliable select + copy; edits still blocked.
            domReadOnly: false,
            minimap: { enabled: false },
            fontSize,
            lineHeight,
            fontFamily: EDITOR_FONT_FAMILY,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            // No current-line flash on single click; double-click still selects word.
            renderLineHighlight: "none",
            selectionHighlight: false,
            occurrencesHighlight: "off",
            matchBrackets: "never",
            // Don't flag fullwidth Chinese punctuation (（） etc.) as errors.
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true },
            unicodeHighlight: {
              ambiguousCharacters: false,
              invisibleCharacters: false,
              nonBasicASCII: false,
              includeComments: false,
              includeStrings: false,
            },
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            contextmenu: true,
            folding: true,
            stickyScroll: { enabled: false },
          }}
          loading={<div className="viewer-loading">Loading editor…</div>}
        />
        {selToolbar && !composer ? (
          <button
            type="button"
            className="anno-sel-chip"
            style={{ left: selToolbar.left, top: selToolbar.top }}
            title="Add comment"
            aria-label="Add comment"
            onMouseDown={(e) => {
              // Keep selection; don't steal focus before click handler.
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const ed = editorRef.current;
              if (ed) openComposer(ed, false);
            }}
          >
            <Icon name="comment" />
          </button>
        ) : null}
        {bubble && bubbleComment ? (
          <CommentBubble
            key={bubble.commentId}
            comment={bubbleComment}
            relatedComments={relatedBubbleComments}
            left={bubble.left}
            top={bubble.top}
            onClose={closeBubble}
            onPointerEnter={() => {
              pointerOverBubbleRef.current = true;
              clearHoverCloseTimer();
            }}
            onPointerLeave={() => {
              pointerOverBubbleRef.current = false;
              scheduleHoverClose();
            }}
            onMutated={() => {
              applyDecorations();
              if (bubble && !liveComment(bubble.commentId)) {
                closeBubble();
              }
            }}
          />
        ) : null}
      </div>

      {composer ? (
        <div className="composer">
          <div className="composer__meta">
            L{composer.startLine}–{composer.endLine}:{" "}
            <code>{composer.selectedText.slice(0, 80)}</code>
            {composer.forceNewSession ? (
              <span className="composer__badge" title="Will end the active session (export) and write this comment into a new session">
                new session
              </span>
            ) : null}
          </div>
          {composer.forceNewSession ? (
            <p className="composer__hint">
              Saves under a <strong>new session</strong>: current active session
              is ended (export written), then this comment is the first note in
              the fresh session.
            </p>
          ) : null}
          <textarea
            ref={composerInputRef}
            className="composer__input"
            rows={3}
            placeholder="Write feedback for the AI CLI…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            autoFocus
          />
          <div className="composer__actions">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setComposer(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit(true)}
              title="End the active session and save this comment in a new session"
            >
              Save comment (new session)
            </button>
            <button
              type="button"
              className="btn btn--accent btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit(false)}
            >
              {saving ? "Saving…" : "Save comment"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
