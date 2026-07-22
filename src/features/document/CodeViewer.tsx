import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { CommentBubble } from "@/features/annotations/CommentBubble";
import {
  useAnnotationsStore,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";
import { addCommentFromSelection } from "@/features/shell/orchestrate";
import type { CommentRecord } from "@/shared/anchor-api";
import "./monacoSetup";

type BubbleState = {
  commentId: string;
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

function findSpecAt(
  specs: DecorationSpec[],
  line: number,
  column: number,
): DecorationSpec | null {
  let best: DecorationSpec | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const s of specs) {
    if (s.anchorStatus === "unresolved") continue;
    if (line < s.startLine || line > s.endLine) continue;
    const startCol = Math.max(1, s.startColumn || 1);
    const endCol = Math.max(startCol, s.endColumn || 1);
    // Single-line: require column inside range (pad 1 for click ease).
    if (s.startLine === s.endLine) {
      if (column < startCol || column > endCol + 1) continue;
    } else {
      if (line === s.startLine && column < startCol) continue;
      if (line === s.endLine && column > endCol + 1) continue;
    }
    const span =
      (s.endLine - s.startLine) * 1000 + endCol - startCol;
    if (span < bestSpan) {
      bestSpan = span;
      best = s;
    }
  }
  return best;
}

export function CodeViewer({
  path,
  content,
  language,
  truncated,
  revealLine,
  kind = "source",
}: {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  revealLine?: number;
  kind?: "source" | "markdown";
}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const specsRef = useRef<DecorationSpec[]>([]);
  const bubbleRef = useRef<BubbleState | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  const decorationsFor = useAnnotationsStore((s) => s.decorationsFor);
  const activeSession = useAnnotationsStore((s) => s.activeSession);

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
    const session = useAnnotationsStore.getState().activeSession;
    return session?.comments.find((c) => c.id === id) ?? null;
  };

  const applyDecorations = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const specs = decorationsFor(path, content);
    specsRef.current = specs;
    const prev =
      (ed as unknown as { __annoIds?: string[] }).__annoIds ?? [];
    const activeId = bubbleRef.current?.commentId;
    const ids = ed.deltaDecorations(
      prev,
      specs
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
              className: selected
                ? "anno-decoration anno-decoration--active"
                : "anno-decoration",
              inlineClassName: selected
                ? "anno-inline anno-inline--active"
                : "anno-inline",
              hoverMessage: {
                value: `**${s.status}** — click highlight to open`,
              },
              isWholeLine: s.startLine !== s.endLine,
              overviewRuler: {
                color: selected ? "#1d4ed8" : "#2563eb",
                position: 4,
              },
              minimap: {
                color: selected ? "#1d4ed8" : "#2563eb",
                position: 1,
              },
            },
          };
        }),
    );
    (ed as unknown as { __annoIds?: string[] }).__annoIds = ids;

    const open = bubbleRef.current;
    if (!open) return;
    const still = specs.find((s) => s.commentId === open.commentId);
    if (!still || !liveComment(open.commentId)) {
      setBubble(null);
      return;
    }
    const overlayW = overlayRef.current?.clientWidth ?? 480;
    const pos = positionForSpec(ed, still, overlayW);
    if (pos) setBubble({ commentId: open.commentId, ...pos });
  }, [content, decorationsFor, path]);

  useEffect(() => {
    applyDecorations();
  }, [applyDecorations, activeSession]);

  useEffect(() => {
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
    }
  }, [revealLine, content]);

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
    };
  }, []);

  const closeBubble = useCallback(() => {
    setBubble(null);
    // Refresh decoration "active" styles after state commits.
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      if (!ed) return;
      // applyDecorations reads bubbleRef; clear it first.
      bubbleRef.current = null;
      // Re-run via latest closure by calling decorationsFor path again.
      const specs = decorationsFor(path, content);
      specsRef.current = specs;
      const prev =
        (ed as unknown as { __annoIds?: string[] }).__annoIds ?? [];
      const ids = ed.deltaDecorations(
        prev,
        specs
          .filter(
            (s) =>
              s.anchorStatus === "resolved" || s.anchorStatus === "relocated",
          )
          .map((s) => ({
            range: {
              startLineNumber: s.startLine,
              startColumn: Math.max(1, s.startColumn || 1),
              endLineNumber: s.endLine,
              endColumn: Math.max(1, s.endColumn || 1),
            },
            options: {
              className: "anno-decoration",
              inlineClassName: "anno-inline",
              hoverMessage: {
                value: `**${s.status}** — click highlight to open`,
              },
              isWholeLine: s.startLine !== s.endLine,
              overviewRuler: {
                color: "#2563eb",
                position: 4,
              },
              minimap: { color: "#2563eb", position: 1 },
            },
          })),
      );
      (ed as unknown as { __annoIds?: string[] }).__annoIds = ids;
    });
  }, [content, decorationsFor, path]);

  const openBubbleForSpec = (spec: DecorationSpec) => {
    const ed = editorRef.current;
    if (!ed) return;
    const overlayW = overlayRef.current?.clientWidth ?? 480;
    const pos = positionForSpec(ed, spec, overlayW);
    if (!pos) return;
    setComposer(null);
    setBubble({ commentId: spec.commentId, ...pos });
  };

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

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
    // Capture-phase document dismiss also runs; re-open if this click hit a decoration.
    disposablesRef.current.push(
      ed.onMouseDown((e) => {
        const be = e.event.browserEvent as MouseEvent | undefined;
        if (be && be.button !== 0) return;

        if (!e.target.position) {
          if (bubbleRef.current) closeBubble();
          return;
        }
        const { lineNumber, column } = e.target.position;
        const hit = findSpecAt(specsRef.current, lineNumber, column);
        if (hit) {
          openBubbleForSpec(hit);
          requestAnimationFrame(() => applyDecorations());
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
        const overlayW = overlayRef.current?.clientWidth ?? 480;
        const pos = positionForSpec(ed, spec, overlayW);
        if (pos) setBubble({ commentId: open.commentId, ...pos });
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
          theme="light"
          onMount={onMount}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontFamily:
              "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            renderLineHighlight: "line",
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
