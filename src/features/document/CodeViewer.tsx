import {
  accentHex,
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
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
import type { CommentRecord } from "@/shared/anchor-api";
import type { SearchHighlight } from "./documentStore";
import "./monacoSetup";

type BubbleState = {
  commentId: string;
  /** Every annotation thread hit at the clicked source position. */
  relatedCommentIds: string[];
  left: number;
  top: number;
};

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
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const searchHighlightRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const specsRef = useRef<DecorationSpec[]>([]);
  const bubbleRef = useRef<BubbleState | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

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
  bubbleRef.current = bubble;

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
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      searchHighlightRef.current?.clear();
      searchHighlightRef.current = null;
      editorRef.current = null;
    };
  }, []);

  const closeBubble = useCallback(() => {
    bubbleRef.current = null;
    setBubble(null);
    // Re-paint without active modifier after state is cleared.
    requestAnimationFrame(() => applyDecorations(null));
  }, [applyDecorations]);

  const openBubbleForSpecs = (hits: DecorationSpec[]) => {
    const ed = editorRef.current;
    const overlay = overlayRef.current;
    if (!ed || !overlay || hits.length === 0) return;
    const primary = hits[0]!;
    const pos = positionForSpec(ed, primary, overlay);
    if (!pos) return;
    setComposer(null);
    const next = {
      commentId: primary.commentId,
      relatedCommentIds: hits.slice(1).map((h) => h.commentId),
      ...pos,
    };
    // Sync ref immediately so applyDecorations sees the open bubble.
    bubbleRef.current = next;
    setBubble(next);
    applyDecorations(primary.commentId);
  };

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    decorationsRef.current?.clear();
    decorationsRef.current = ed.createDecorationsCollection();
    searchHighlightRef.current?.clear();
    searchHighlightRef.current = ed.createDecorationsCollection();
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    // Re-apply after model is ready (open-from-search before mount).
    requestAnimationFrame(() => {
      applyDecorations(focusCommentId ?? null);
      paintSearchHighlight();
    });

    ed.addAction({
      id: "anchor.addComment",
      label: "Add comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyM],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      run: () => openComposer(ed, false),
    });
    ed.addAction({
      id: "anchor.addCommentNewSession",
      label: "Add comment (new session)",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.6,
      run: () => openComposer(ed, true),
    });

    // mouseDown: open sticky bubble on highlight, dismiss on empty editor area.
    disposablesRef.current.push(
      ed.onMouseDown((e) => {
        const be = e.event.browserEvent as MouseEvent | undefined;
        if (be && be.button !== 0) return;

        if (!e.target.position) {
          if (bubbleRef.current) closeBubble();
          return;
        }
        const { lineNumber, column } = e.target.position;
        const hits = findSpecsAt(specsRef.current, lineNumber, column);
        if (hits.length > 0) {
          openBubbleForSpecs(hits);
        } else if (bubbleRef.current) {
          closeBubble();
        }
      }),
    );

    disposablesRef.current.push(
      ed.onDidScrollChange(() => {
        const open = bubbleRef.current;
        if (!open) return;
        const spec = specsRef.current.find(
          (s) => s.commentId === open.commentId,
        );
        if (!spec) {
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

    applyDecorations();
  };

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
    setBubble(null);
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

  const submit = async () => {
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
        forceNewSession: composer.forceNewSession,
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
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: EDITOR_FONT_SIZE,
            lineHeight: EDITOR_LINE_HEIGHT,
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
        {bubble && bubbleComment ? (
          <CommentBubble
            key={bubble.commentId}
            comment={bubbleComment}
            relatedComments={relatedBubbleComments}
            left={bubble.left}
            top={bubble.top}
            onClose={closeBubble}
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
              className="btn btn--accent btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit()}
            >
              {saving
                ? "Saving…"
                : composer.forceNewSession
                  ? "Save in new session"
                  : "Save comment"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
