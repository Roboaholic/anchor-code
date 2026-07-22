import { Icon } from "@/shared/Icon";
import { jumpToComment } from "@/features/shell/orchestrate";
import { useAnnotationsStore } from "./annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useEffect, useState } from "react";
import type { CommentRecord } from "@/shared/anchor-api";

export function CommentsPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const activeId = useDocumentStore((s) => s.activeId);
  const openItems = useDocumentStore((s) => s.openItems);
  const active = openItems.find((i) => i.id === activeId);

  const repoRoot = useAnnotationsStore((s) => s.repoRoot);
  const activeSession = useAnnotationsStore((s) => s.activeSession);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const error = useAnnotationsStore((s) => s.error);
  const toast = useAnnotationsStore((s) => s.toast);
  const loading = useAnnotationsStore((s) => s.loading);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const ensureActive = useAnnotationsStore((s) => s.ensureActive);
  const copyYamlPath = useAnnotationsStore((s) => s.copyYamlPath);
  const endSession = useAnnotationsStore((s) => s.endSession);
  const newSession = useAnnotationsStore((s) => s.newSession);
  const restoreSession = useAnnotationsStore((s) => s.restoreSession);
  const exportSession = useAnnotationsStore((s) => s.exportSession);
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);
  const clearToast = useAnnotationsStore((s) => s.clearToast);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [showSessions, setShowSessions] = useState(false);

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

  const closedSessions = sessions.filter((s) => s.status === "closed");

  const startEdit = (c: CommentRecord) => {
    const primary = c.messages[0]?.body ?? "";
    setEditingId(c.id);
    setEditBody(primary);
    setReplyingId(null);
  };

  const submitEdit = async (commentId: string) => {
    if (!editBody.trim()) return;
    await editComment(commentId, editBody.trim());
    setEditingId(null);
    setEditBody("");
  };

  const submitReply = async (commentId: string) => {
    if (!replyBody.trim()) return;
    await reply(commentId, replyBody.trim());
    setReplyingId(null);
    setReplyBody("");
  };

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
            disabled={!activeSession && !repoRoot}
            onClick={() =>
              void exportSession(activeSession?.id)
            }
            title="Export anch-review JSON and copy path"
          >
            Export
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!activeSession}
            onClick={() => void endSession()}
            title="End session and write export JSON"
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
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!repoRoot || sessions.length === 0}
            onClick={() => setShowSessions((v) => !v)}
          >
            {showSessions ? "Hide list" : "Sessions"}
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

      {showSessions ? (
        <div className="session-list">
          <div className="session-list__title">All sessions</div>
          {sessions.length === 0 ? (
            <p className="pane-hint">No sessions under .anchor-code/</p>
          ) : (
            <ul className="session-list__items">
              {sessions.map((s) => (
                <li key={s.id} className="session-list__item">
                  <div className="session-list__meta">
                    <span className="session-list__name">
                      {s.title || s.id}
                      {s.status === "active" ? " (active)" : ""}
                    </span>
                    <span className="session-list__count">
                      {s.commentCount} comments
                    </span>
                  </div>
                  <div className="session-list__actions">
                    {s.status === "closed" ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => void restoreSession(s.id)}
                      >
                        Restore
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void exportSession(s.id)}
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void copyYamlPath(s.id)}
                    >
                      YAML
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {closedSessions.length > 0 ? (
            <p className="pane-hint">
              Restore reopens a closed session as the sole active one.
            </p>
          ) : null}
        </div>
      ) : null}

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
            const isEditing = editingId === c.id;
            const isReplying = replyingId === c.id;
            return (
              <li key={c.id} className="comment-card">
                <button
                  type="button"
                  className="comment-card__jump"
                  onClick={() => void jumpToComment(c)}
                >
                  <span className="comment-card__head">
                    <span className="comment-card__path">
                      {c.target.file_path}:{c.target.start_line}
                    </span>
                    <span className={`chip chip--${c.status}`}>{c.status}</span>
                  </span>
                  <span className="comment-card__preview">{preview}</span>
                  {c.messages.length > 1 ? (
                    <span className="comment-card__replies">
                      {c.messages.length} messages
                    </span>
                  ) : null}
                </button>

                {isEditing ? (
                  <div className="comment-card__editor">
                    <textarea
                      className="comment-card__textarea"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={3}
                    />
                    <div className="comment-card__editor-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--small"
                        onClick={() => void submitEdit(c.id)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => {
                          setEditingId(null);
                          setEditBody("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {isReplying ? (
                  <div className="comment-card__editor">
                    <textarea
                      className="comment-card__textarea"
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      rows={2}
                      placeholder="Reply…"
                    />
                    <div className="comment-card__editor-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--small"
                        onClick={() => void submitReply(c.id)}
                      >
                        Reply
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => {
                          setReplyingId(null);
                          setReplyBody("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="comment-card__footer">
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
                  <div className="comment-card__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => startEdit(c)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => {
                        setReplyingId(c.id);
                        setReplyBody("");
                        setEditingId(null);
                      }}
                    >
                      Reply
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this comment thread permanently?",
                          )
                        ) {
                          void deleteComment(c.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
