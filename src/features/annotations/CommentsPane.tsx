import { Icon } from "@/shared/Icon";
import { jumpToComment } from "@/features/shell/orchestrate";
import { useAnnotationsStore } from "./annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useEffect } from "react";

export function CommentsPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const activeId = useDocumentStore((s) => s.activeId);
  const openItems = useDocumentStore((s) => s.openItems);
  const active = openItems.find((i) => i.id === activeId);

  const repoRoot = useAnnotationsStore((s) => s.repoRoot);
  const activeSession = useAnnotationsStore((s) => s.activeSession);
  const error = useAnnotationsStore((s) => s.error);
  const toast = useAnnotationsStore((s) => s.toast);
  const loading = useAnnotationsStore((s) => s.loading);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const ensureActive = useAnnotationsStore((s) => s.ensureActive);
  const copyYamlPath = useAnnotationsStore((s) => s.copyYamlPath);
  const endSession = useAnnotationsStore((s) => s.endSession);
  const newSession = useAnnotationsStore((s) => s.newSession);
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const clearToast = useAnnotationsStore((s) => s.clearToast);

  useEffect(() => {
    let cancelled = false;
    async function syncRepo() {
      if (!workspaceRoot) return;
      let root: string | null = null;
      if (active?.kind === "file") {
        root = await window.anchor.annotations.locateGitRoot(active.path);
      } else if (active?.kind === "diff") {
        root = active.repoRoot;
      } else {
        root = await window.anchor.annotations.locateGitRoot(workspaceRoot);
      }
      if (cancelled || !root) return;
      await loadForRepo(root);
    }
    void syncRepo();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, active, loadForRepo]);

  if (!workspaceRoot) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">Comments</h2>
        <p className="empty-pane__hint">Open a workspace to manage annotations.</p>
      </div>
    );
  }

  return (
    <div className="comments-pane">
      <div className="comments-pane__session">
        <div className="comments-pane__session-title">
          {activeSession
            ? `Session: ${activeSession.title}`
            : "No active session"}
        </div>
        <div className="comments-pane__session-actions">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!repoRoot}
            onClick={() => void ensureActive(repoRoot!)}
          >
            Ensure
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!repoRoot}
            onClick={() => void copyYamlPath()}
            title="Copy session YAML absolute path"
          >
            Copy path
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!activeSession}
            onClick={() => void endSession()}
          >
            End
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!repoRoot || !!activeSession}
            onClick={() => void newSession()}
          >
            New
          </button>
        </div>
        {repoRoot ? (
          <div className="comments-pane__repo" title={repoRoot}>
            {repoRoot.split(/[/\\]/).pop()}
          </div>
        ) : null}
      </div>

      {toast ? (
        <div className="banner banner--ok history-toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon-btn" onClick={clearToast}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      {error ? <p className="pane-hint pane-hint--error">{error}</p> : null}
      {loading ? <p className="pane-hint">Loading…</p> : null}

      {!activeSession ? (
        <p className="pane-hint">
          Open a file and select text to add a comment, or click Ensure to create
          a session under <code>.anchor-code/</code>.
        </p>
      ) : activeSession.comments.length === 0 ? (
        <p className="pane-hint">
          No comments yet. Select code (or MD Raw) and use Add comment.
        </p>
      ) : (
        <ul className="comment-list">
          {activeSession.comments.map((c) => {
            const preview =
              c.messages[c.messages.length - 1]?.body?.slice(0, 120) ?? "";
            return (
              <li key={c.id} className="comment-card">
                <button
                  type="button"
                  className="comment-card__jump"
                  onClick={() => void jumpToComment(c)}
                >
                  <span className="comment-card__path">
                    {c.target.file_path}:{c.target.start_line}
                  </span>
                  <span className={`chip chip--${c.status}`}>{c.status}</span>
                  <span className="comment-card__preview">{preview}</span>
                </button>
                <select
                  className="comment-card__status"
                  value={c.status}
                  onChange={(e) =>
                    void setStatus(
                      c.id,
                      e.target.value as typeof c.status,
                    )
                  }
                >
                  <option value="discussing">discussing</option>
                  <option value="need_modify">need_modify</option>
                  <option value="closed">closed</option>
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
