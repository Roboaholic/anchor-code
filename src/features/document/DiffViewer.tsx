import { useEffect, useMemo, useRef, useState } from "react";
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
import type { OpenItem } from "./documentStore";
import { useDocumentStore } from "./documentStore";
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

export function DiffViewer({ item }: { item: DiffItem }) {
  const setDiffActiveFile = useDocumentStore((s) => s.setDiffActiveFile);
  const activePath = item.activeFilePath;
  const activeMeta = item.files.find((f) => f.path === activePath);
  const [oldText, setOldText] = useState("");
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const modifiedEditorRef =
    useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef =
    useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);

  useEffect(() => {
    if (!activePath || !activeMeta) {
      setOldText("");
      setNewText("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setComposer(null);
    void window.anchor.history
      .getFileDiff({
        repoRoot: item.repoRoot,
        base: item.base,
        head: item.head,
        path: activePath,
        status: activeMeta.status,
      })
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
    return () => {
      cancelled = true;
    };
  }, [activePath, activeMeta, item.repoRoot, item.base, item.head]);

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

  const onDiffMount: DiffOnMount = (editor, monaco) => {
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];

    diffEditorRef.current = editor;
    editor.updateOptions({ renderSideBySide: sideBySide });

    const modified = editor.getModifiedEditor();
    modifiedEditorRef.current = modified;

    // Only register comment actions in side-by-side mode (newer column).
    if (!sideBySide) return;

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
  };

  useEffect(() => {
    // Drop open composer when leaving side-by-side.
    if (!sideBySide) setComposer(null);
  }, [sideBySide]);

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="diff-viewer">
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

      <div className="diff-viewer__main">
        <div className="diff-viewer__toolbar">
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
          <span className="diff-viewer__hint">
            {sideBySide
              ? "Right column · Ctrl/Cmd+M"
              : "Switch to Side by side to comment"}
          </span>
        </div>

        <div className="diff-viewer__editor">
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
            <DiffEditor
              // Force remount when layout changes — updateOptions is unreliable
              // for renderSideBySide in some monaco-react / monaco versions.
              key={`diff-${activePath}-${sideBySide ? "split" : "inline"}`}
              original={oldText}
              modified={newText}
              language={languageFromPath(activePath)}
              theme="light"
              keepCurrentOriginalModel={false}
              keepCurrentModifiedModel={false}
              onMount={onDiffMount}
              options={{
                readOnly: true,
                renderSideBySide: sideBySide,
                renderSideBySideInlineBreakpoint: sideBySide ? 0 : 1e9,
                useInlineViewWhenSpaceIsLimited: !sideBySide,
                minimap: { enabled: false },
                fontSize: 12.5,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                originalEditable: false,
              }}
            />
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
