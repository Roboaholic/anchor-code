import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { addCommentFromSelection } from "@/features/shell/orchestrate";
import "./monacoSetup";

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
  } | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const applyDecorations = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const specs = decorationsFor(path, content);
    const prev =
      (ed as unknown as { __annoIds?: string[] }).__annoIds ?? [];
    const ids = ed.deltaDecorations(
      prev,
      specs
        .filter((s) => s.anchorStatus === "resolved")
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
            hoverMessage: { value: s.hover },
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
  };

  useEffect(() => {
    applyDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path, activeSession]);

  useEffect(() => {
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
    }
  }, [revealLine, content]);

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    ed.addAction({
      id: "anchor.addComment",
      label: "Add comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyM],
      contextMenuGroupId: "navigation",
      run: () => openComposer(ed),
    });
    applyDecorations();
  };

  const openComposer = (ed: MonacoEditor.IStandaloneCodeEditor) => {
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
    setComposer({
      startLine,
      endLine,
      startColumn: sel.startColumn,
      endColumn: sel.endColumn,
      selectedText,
      beforeContext,
      afterContext,
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
        ...composer,
        body: body.trim(),
      });
      setComposer(null);
      setBody("");
      applyDecorations();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="code-viewer">
      {truncated ? (
        <div className="banner banner--warn">
          File is larger than 1 MB — showing the first portion only ({path}).
        </div>
      ) : null}
      <div className="code-viewer__toolbar">
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => {
            if (editorRef.current) openComposer(editorRef.current);
          }}
        >
          Add comment
        </button>
        <span className="muted toolbar-hint">Select text · ⌘/Ctrl+M</span>
      </div>
      <div className="code-viewer__editor">
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
      </div>

      {composer ? (
        <div className="composer">
          <div className="composer__meta">
            L{composer.startLine}–{composer.endLine}:{" "}
            <code>{composer.selectedText.slice(0, 80)}</code>
          </div>
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
              className="btn btn--primary btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit()}
            >
              {saving ? "Saving…" : "Save comment"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
