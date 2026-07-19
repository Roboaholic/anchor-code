import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { languageFromPath } from "@/core/workspace/paths";
import { openWorktreeFileFromDiff } from "@/features/shell/orchestrate";
import type { OpenItem } from "./documentStore";
import { useDocumentStore } from "./documentStore";

type DiffItem = Extract<OpenItem, { kind: "diff" }>;

export function DiffViewer({ item }: { item: DiffItem }) {
  const setDiffActiveFile = useDocumentStore((s) => s.setDiffActiveFile);
  const activePath = item.activeFilePath;
  const activeMeta = item.files.find((f) => f.path === activePath);
  const [oldText, setOldText] = useState("");
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activePath || !activeMeta) {
      setOldText("");
      setNewText("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
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

  return (
    <div className="diff-viewer">
      <aside className="diff-viewer__files">
        <div className="files-pane__title">CHANGED FILES</div>
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
                  <span className="diff-file-list__status">{f.status[0]}</span>
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
            original={oldText}
            modified={newText}
            language={languageFromPath(activePath)}
            theme="light"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 12.5,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        )}
      </div>
    </div>
  );
}
