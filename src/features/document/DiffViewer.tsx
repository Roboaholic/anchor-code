import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  buildDiffCommentPrefix,
  shortRev,
} from "@/core/history/diffComment";
import { joinPath, languageFromPath } from "@/core/workspace/paths";
import {
  addCommentFromSelection,
  openWorktreeFileFromDiff,
} from "@/features/shell/orchestrate";
import { CommentBubble } from "@/features/annotations/CommentBubble";
import {
  overlapRegionsForModel,
  useAnnotationsStore,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";
import type { OpenItem } from "./documentStore";
import { useDocumentStore } from "./documentStore";
import {
  loadFileDiff,
  peekFileDiff,
  prefetchFileDiff,
} from "./fileDiffCache";
import { useThemeStore } from "@/features/shell/themeStore";
import {
  accentHex,
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  monacoThemeId,
} from "@/core/theme/theme";
import type { CommentRecord } from "@/shared/anchor-api";
import "./monacoSetup";

type DiffItem = Extract<OpenItem, { kind: "diff" }>;

type ComposerState = {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  lineText: string;
  forceNewSession: boolean;
};

type BubbleState = {
  commentId: string;
  /** Every annotation thread hit at the clicked source position. */
  relatedCommentIds: string[];
  left: number;
  top: number;
};

function positionForSpec(
  ed: MonacoEditor.IStandaloneCodeEditor,
  spec: DecorationSpec,
  overlayWidth: number,
): { left: number; top: number } | null {
  const pos = ed.getScrolledVisiblePosition({
    lineNumber: spec.startLine,
    column: Math.max(1, spec.startColumn || 1),
  });
  if (!pos) return null;
  const left = Math.min(
    Math.max(8, pos.left + 12),
    Math.max(8, overlayWidth - 320),
  );
  const top = Math.max(8, pos.top + pos.height + 6);
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

export function DiffViewer({ item }: { item: DiffItem }) {
  const theme = useThemeStore((s) => s.theme);
  const setDiffActiveFile = useDocumentStore((s) => s.setDiffActiveFile);
  const decorationsFor = useAnnotationsStore((s) => s.decorationsFor);
  const activeSession = useAnnotationsStore((s) => s.activeSession);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const activePath = item.activeFilePath;
  const activeMeta = item.files.find((f) => f.path === activePath);
  const absActivePath = activePath
    ? joinPath(item.repoRoot, activePath)
    : null;
  const [oldText, setOldText] = useState("");
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const modifiedEditorRef =
    useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const diffEditorRef =
    useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const specsRef = useRef<DecorationSpec[]>([]);
  const bubbleRef = useRef<BubbleState | null>(null);
  bubbleRef.current = bubble;

  useEffect(() => {
    if (!activePath || !activeMeta) {
      setOldText("");
      setNewText("");
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const status = activeMeta.status;
    const req = {
      repoRoot: item.repoRoot,
      base: item.base,
      head: item.head,
      path: activePath,
      status,
    };
    const cached = peekFileDiff(req);
    if (cached) {
      setOldText(cached.oldText);
      setNewText(cached.newText);
      setLoading(false);
      setError(null);
      setComposer(null);
    } else {
      setLoading(true);
      setError(null);
      setComposer(null);
      void loadFileDiff(req)
        .then((res) => {
          if (cancelled) return;
          setOldText(res.oldText);
          setNewText(res.newText);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }

    // Warm the next/prev files so sequential clicks feel instant.
    const idx = item.files.findIndex((f) => f.path === activePath);
    for (const offset of [1, -1, 2]) {
      const f = item.files[idx + offset];
      if (!f) continue;
      prefetchFileDiff({
        repoRoot: item.repoRoot,
        base: item.base,
        head: item.head,
        path: f.path,
        status: f.status,
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    activePath,
    activeMeta?.status,
    item.repoRoot,
    item.base,
    item.head,
    item.files,
  ]);

  // Diff comments are stored under item.repoRoot — keep session loaded.
  useEffect(() => {
    if (!item.repoRoot) return;
    const current = useAnnotationsStore.getState().repoRoot;
    if (current !== item.repoRoot) {
      void loadForRepo(item.repoRoot);
    }
  }, [item.repoRoot, loadForRepo]);

  // Monaco DiffEditor does not always re-apply layout options from React props.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  const rangeLabel = useMemo(() => {
    const base = shortRev(item.base);
    const head =
      item.head === "worktree" ? "worktree" : shortRev(item.head);
    const br = item.branch ? `${item.branch} · ` : "";
    return `${br}${base} → ${head}`;
  }, [item.base, item.head, item.branch]);

  const openComposer = (
    ed: MonacoEditor.IStandaloneCodeEditor,
    forceNewSession = false,
  ) => {
    // Comments only make sense in side-by-side (clear newer column).
    if (!sideBySide) return;
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
      const ed = modifiedEditorRef.current;
      if (!ed || !absActivePath || !sideBySide) return;
      const specs = decorationsFor(absActivePath, newText);
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
        bubbleRef.current = null;
        setBubble(null);
        return;
      }
      const overlayW = overlayRef.current?.clientWidth ?? 480;
      const pos = positionForSpec(ed, still, overlayW);
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
    [absActivePath, decorationsFor, newText, sideBySide, theme],
  );

  useEffect(() => {
    applyDecorations();
  }, [
    applyDecorations,
    activeSession,
    expandedSessionId,
    sessions,
    newText,
    activePath,
  ]);

  // Wait for the bubble state to commit, then repaint Monaco decorations.
  // This avoids losing them during the editor's mouse-selection pass.
  useEffect(() => {
    applyDecorations(bubble?.commentId ?? null);
  }, [applyDecorations, bubble?.commentId]);

  const openBubbleForSpecs = (hits: DecorationSpec[]) => {
    const ed = modifiedEditorRef.current;
    if (!ed || hits.length === 0) return;
    const primary = hits[0]!;
    const overlayW = overlayRef.current?.clientWidth ?? 480;
    const pos = positionForSpec(ed, primary, overlayW);
    if (!pos) return;
    setComposer(null);
    const next = {
      commentId: primary.commentId,
      relatedCommentIds: hits.slice(1).map((h) => h.commentId),
      ...pos,
    };
    bubbleRef.current = next;
    setBubble(next);
    applyDecorations(primary.commentId);
  };

  const closeBubble = useCallback(() => {
    bubbleRef.current = null;
    setBubble(null);
    requestAnimationFrame(() => applyDecorations(null));
  }, [applyDecorations]);

  const onDiffMount: DiffOnMount = (editor, monaco) => {
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    diffEditorRef.current = editor;
    editor.updateOptions({ renderSideBySide: sideBySide });

    const modified = editor.getModifiedEditor();
    modifiedEditorRef.current = modified;
    decorationsRef.current?.clear();
    decorationsRef.current = modified.createDecorationsCollection();

    // Only register comment actions in side-by-side mode (newer column).
    if (!sideBySide) {
      applyDecorations();
      return;
    }

    disposablesRef.current.push(
      modified.addAction({
        id: "anchor.addComment",
        label: "Add comment",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyM],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.5,
        run: (ed) =>
          openComposer(ed as MonacoEditor.IStandaloneCodeEditor, false),
      }),
    );
    disposablesRef.current.push(
      modified.addAction({
        id: "anchor.addCommentNewSession",
        label: "Add comment (new session)",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.6,
        run: (ed) =>
          openComposer(ed as MonacoEditor.IStandaloneCodeEditor, true),
      }),
    );
    disposablesRef.current.push(
      modified.onMouseDown((e) => {
        if (!e.target.position) return;
        // Left click on text — open bubble if hitting an annotation.
        if (e.event.leftButton !== true) return;
        const hits = findSpecsAt(
          specsRef.current,
          e.target.position.lineNumber,
          e.target.position.column,
        );
        if (hits.length > 0) {
          openBubbleForSpecs(hits);
        } else if (bubbleRef.current) {
          closeBubble();
        }
      }),
    );
    applyDecorations();
  };

  useEffect(() => {
    // Drop open composer when leaving side-by-side.
    if (!sideBySide) {
      setComposer(null);
      setBubble(null);
    }
  }, [sideBySide]);

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      diffEditorRef.current = null;
      modifiedEditorRef.current = null;
    };
  }, []);

  const submit = async () => {
    if (!composer || !body.trim() || !activePath || !sideBySide) return;
    setSaving(true);
    try {
      const abs = joinPath(item.repoRoot, activePath);
      const prefix = buildDiffCommentPrefix({
        branch: item.branch,
        base: item.base,
        head: item.head,
        filePath: activePath,
        startLine: composer.startLine,
        endLine: composer.endLine,
      });
      await addCommentFromSelection({
        filePath: abs,
        kind: "source",
        startLine: composer.startLine,
        endLine: composer.endLine,
        startColumn: composer.startColumn,
        endColumn: composer.endColumn,
        selectedText: composer.selectedText,
        beforeContext: composer.beforeContext,
        afterContext: composer.afterContext,
        lineText: composer.lineText,
        body: `${prefix}${body.trim()}`,
        repoRoot: item.repoRoot,
        forceNewSession: composer.forceNewSession,
      });
      setComposer(null);
      setBody("");
      requestAnimationFrame(() => applyDecorations());
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
    <div
      className={`diff-viewer${item.hideFileList ? " diff-viewer--focus" : ""}`}
    >
      {item.hideFileList ? null : (
        <aside className="diff-viewer__files">
          <div className="diff-viewer__range" title={item.title}>
            {item.title}
          </div>
          <div className="diff-viewer__meta" title={rangeLabel}>
            {rangeLabel}
          </div>
          <div className="files-pane__title">
            CHANGED FILES · {item.files.length}
          </div>
          {item.files.length === 0 ? (
            <p className="pane-hint">No file changes in this compare.</p>
          ) : (
            <ul className="diff-file-list">
              {item.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className={`diff-file-list__row${
                      f.path === activePath ? " is-selected" : ""
                    }`}
                    onClick={() => setDiffActiveFile(item.id, f.path)}
                  >
                    <span
                      className={`diff-file-list__status status-${f.status[0] ?? "M"}`}
                    >
                      {f.status[0]}
                    </span>
                    <span className="diff-file-list__path" title={f.path}>
                      {f.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {activePath && item.head === "worktree" ? (
            <button
              type="button"
              className="btn btn--ghost btn--small diff-open-wt"
              onClick={() =>
                void openWorktreeFileFromDiff(item.repoRoot, activePath)
              }
            >
              Open worktree file
            </button>
          ) : null}
        </aside>
      )}

      <div className="diff-viewer__main">
        <div className="diff-viewer__toolbar">
          <div className="diff-viewer__toolbar-left">
            {item.hideFileList && activePath ? (
              <span className="diff-viewer__focus-title" title={item.title}>
                {activePath}
                <span className="diff-viewer__focus-range">
                  {" "}
                  · HEAD → worktree
                </span>
              </span>
            ) : null}
            <div
              className="diff-viewer__layout-toggle"
              role="group"
              aria-label="Diff layout"
            >
              <button
                type="button"
                className={`diff-viewer__layout-btn${sideBySide ? " is-active" : ""}`}
                onClick={() => setSideBySide(true)}
                title="Side-by-side (two columns)"
              >
                Side by side
              </button>
              <button
                type="button"
                className={`diff-viewer__layout-btn${!sideBySide ? " is-active" : ""}`}
                onClick={() => setSideBySide(false)}
                title="Inline (single column)"
              >
                Inline
              </button>
            </div>
          </div>
          <span className="diff-viewer__hint">
            {sideBySide
              ? "Right column · Ctrl/Cmd+M · Add comment"
              : "Switch to Side by side to comment"}
          </span>
        </div>

        <div className="diff-viewer__editor" ref={overlayRef}>
          {!activePath ? (
            <div className="empty-center">
              <p className="muted">Select a file to view the diff.</p>
            </div>
          ) : loading ? (
            <div className="viewer-loading">Loading diff…</div>
          ) : error ? (
            <div className="empty-center">
              <p className="error-text">{error}</p>
            </div>
          ) : (
            <>
              <DiffEditor
                // Force remount when layout changes — updateOptions is unreliable
                // for renderSideBySide in some monaco-react / monaco versions.
                key={`diff-${activePath}-${sideBySide ? "split" : "inline"}`}
                original={oldText}
                modified={newText}
                language={languageFromPath(activePath)}
                theme={monacoThemeId(theme)}
                keepCurrentOriginalModel={false}
                keepCurrentModifiedModel={false}
                onMount={onDiffMount}
                options={{
                  readOnly: true,
                  renderSideBySide: sideBySide,
                  renderSideBySideInlineBreakpoint: sideBySide ? 0 : 1e9,
                  useInlineViewWhenSpaceIsLimited: !sideBySide,
                  minimap: { enabled: false },
                  fontSize: EDITOR_FONT_SIZE,
                  lineHeight: EDITOR_LINE_HEIGHT,
                  fontFamily: EDITOR_FONT_FAMILY,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  originalEditable: false,
                  // Hide +/- in the line-number gutter (side-by-side).
                  renderIndicators: false,
                  renderMarginRevertIcon: false,
                  renderLineHighlight: "none",
                  selectionHighlight: false,
                  occurrencesHighlight: "off",
                  matchBrackets: "never",
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: true },
                  unicodeHighlight: {
                    ambiguousCharacters: false,
                    invisibleCharacters: false,
                    nonBasicASCII: false,
                    includeComments: false,
                    includeStrings: false,
                  },
                }}
              />
              {bubble && bubbleComment && sideBySide ? (
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
            </>
          )}
        </div>
        {composer && sideBySide ? (
          <div className="composer">
            <div className="composer__meta">
              L{composer.startLine}–{composer.endLine}:{" "}
              <code>{composer.selectedText.slice(0, 80)}</code>
              {composer.forceNewSession ? (
                <span
                  className="composer__badge"
                  title="Will end the active session (export) and write this comment into a new session"
                >
                  new session
                </span>
              ) : null}
            </div>
            <p className="composer__hint">
              Comment targets the <strong>right (newer)</strong> column
              {item.branch ? (
                <>
                  {" "}
                  · branch <code>{item.branch}</code>
                </>
              ) : null}
              {" · "}
              <code>{shortRev(item.base)}</code> →{" "}
              <code>
                {item.head === "worktree" ? "worktree" : shortRev(item.head)}
              </code>
              . Branch and commit range are prepended to the comment body.
              {composer.forceNewSession ? (
                <>
                  {" "}
                  Saves under a <strong>new session</strong>.
                </>
              ) : null}
            </p>
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
    </div>
  );
}
