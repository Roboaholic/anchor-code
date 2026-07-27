import {
  commentBodyForDisplay,
  rejoinDiffCommentBody,
} from "@/core/history/diffComment";
import { Icon } from "@/shared/Icon";
import { jumpToComment } from "@/features/shell/orchestrate";
import { useAnnotationsStore } from "./annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useEffect, useState } from "react";
import type {
  CommentMessage,
  CommentRecord,
  SessionRecord,
} from "@/shared/anchor-api";

export function CommentsPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const activeId = useDocumentStore((s) => s.activeId);
  const openItems = useDocumentStore((s) => s.openItems);
  const active = openItems.find((i) => i.id === activeId);

  const repoRoot = useAnnotationsStore((s) => s.repoRoot);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const error = useAnnotationsStore((s) => s.error);
  const toast = useAnnotationsStore((s) => s.toast);
  const loading = useAnnotationsStore((s) => s.loading);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const setExpandedSession = useAnnotationsStore((s) => s.setExpandedSession);
  const startFreshSession = useAnnotationsStore((s) => s.startFreshSession);
  const exportSession = useAnnotationsStore((s) => s.exportSession);
  const copyYamlPath = useAnnotationsStore((s) => s.copyYamlPath);
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);
  const clearToast = useAnnotationsStore((s) => s.clearToast);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setExpandedSessionIds((current) => {
      const validIds = new Set(sessions.map((session) => session.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      const preferred =
        expandedSessionId ?? sessions.find((s) => s.status === "active")?.id;
      if (preferred) next.add(preferred);
      return next;
    });
  }, [expandedSessionId, sessions]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearToast(), 2200);
    return () => window.clearTimeout(t);
  }, [toast, clearToast]);

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
      // Same repo: do not reload — jump-to-comment must not flash the list.
      if (useAnnotationsStore.getState().repoRoot === root) return;
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
        <p className="empty-pane__hint">
          Open a workspace to manage annotations.
        </p>
      </div>
    );
  }

  const ensureWritable = async (session: SessionRecord) => {
    if (session.status === "active") return;
    await useAnnotationsStore.getState().restoreSession(session.id);
  };

  const messageKey = (commentId: string, messageId: string) =>
    `${commentId}:${messageId}`;

  const startEdit = (comment: CommentRecord, message: CommentMessage) => {
    setEditingKey(messageKey(comment.id, message.id));
    setEditBody(commentBodyForDisplay(message.body));
    setReplyingId(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditBody("");
  };

  const submitEdit = async (
    session: SessionRecord,
    comment: CommentRecord,
    message: CommentMessage,
  ) => {
    if (!editBody.trim()) return;
    await ensureWritable(session);
    const live =
      useAnnotationsStore.getState().sessions.find((s) => s.id === session.id) ??
      session;
    const liveComment = live.comments.find((c) => c.id === comment.id);
    const original =
      liveComment?.messages.find((m) => m.id === message.id)?.body ??
      message.body;
    const isPrimary = liveComment?.messages[0]?.id === message.id;
    const body = isPrimary
      ? rejoinDiffCommentBody(original, editBody.trim())
      : editBody.trim();
    await editComment(comment.id, body, message.id);
    cancelEdit();
  };

  const submitReply = async (session: SessionRecord, commentId: string) => {
    if (!replyBody.trim()) return;
    await ensureWritable(session);
    await reply(commentId, replyBody.trim());
    setReplyingId(null);
    setReplyBody("");
  };

  const toggleSession = (id: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        setExpandedSession(id);
      }
      return next;
    });
  };

  return (
    <div className="comments-pane">
      <div className="comments-pane__toolbar">
        <div className="comments-pane__toolbar-left">
          <span className="files-pane__title">Sessions</span>
          {repoRoot ? (
            <span className="comments-pane__repo" title={repoRoot}>
              {repoRoot.split(/[/\\]/).pop()}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-btn"
          disabled={!repoRoot}
          onClick={() => {
            if (!repoRoot) return;
            void startFreshSession(repoRoot);
          }}
          title={
            sessions.some((s) => s.status === "active")
              ? "End current session (with export) and start a new one"
              : "Start a new session"
          }
          aria-label="New session"
        >
          <Icon name="add" />
        </button>
      </div>

      {toast ? (
        <div className="pane-toast pane-toast--ok" role="status">
          <span>{toast}</span>
          <button type="button" className="icon-btn" onClick={clearToast}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      {error ? <p className="pane-hint pane-hint--error">{error}</p> : null}
      {loading ? <p className="pane-hint">Loading…</p> : null}

      {!loading && sessions.length === 0 ? (
        <p className="pane-hint">
          No sessions yet. Select code and add a comment, or start a new
          session.
        </p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => {
            const open = expandedSessionIds.has(session.id);
            const writable = session.status === "active";
            return (
              <li
                key={session.id}
                className={`session-row${open ? " is-open" : ""}${
                  writable ? " is-active" : ""
                }`}
              >
                <div className="session-row__head">
                  <button
                    type="button"
                    className="session-row__toggle"
                    onClick={() => toggleSession(session.id)}
                    aria-expanded={open}
                  >
                    <Icon name={open ? "chevron-down" : "chevron-right"} />
                    <span className="session-row__title" title={session.title}>
                      {session.title}
                    </span>
                    <span
                      className={`session-row__badge${
                        writable ? " is-live" : ""
                      }`}
                    >
                      {writable ? "active" : "closed"}
                    </span>
                    <span className="session-row__count">
                      {session.comments.length}
                    </span>
                  </button>
                  <div className="session-row__actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Export anch-review JSON and copy path"
                      aria-label="Export session"
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportSession(session.id);
                      }}
                    >
                      <Icon name="export" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Copy session YAML path"
                      aria-label="Copy YAML path"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyYamlPath(session.id);
                      }}
                    >
                      <Icon name="copy" />
                    </button>
                  </div>
                </div>

                {open ? (
                  <div className="session-row__body">
                    {session.comments.length === 0 ? (
                      <p className="pane-hint">
                        {writable
                          ? "No comments yet. Select code (or MD Raw) and use Add comment."
                          : "No comments in this session."}
                      </p>
                    ) : (
                      <ul className="comment-list">
                        {session.comments.map((c) => {
                          const primary = c.messages[0];
                          const replies = c.messages.slice(1);
                          const isReplying = replyingId === c.id;
                          const renderMessage = (
                            message: CommentMessage | undefined,
                            kind: "primary" | "reply",
                          ) => {
                            if (!message) return null;
                            const key = messageKey(c.id, message.id);
                            const editingHere = editingKey === key;
                            return (
                              <div
                                key={message.id}
                                className={`comment-card__msg${
                                  kind === "reply"
                                    ? " comment-card__msg--reply"
                                    : ""
                                }${editingHere ? " is-editing" : ""}`}
                              >
                                <div className="comment-card__msg-head">
                                  <span className="comment-card__msg-author">
                                    {message.author || "unknown"}
                                  </span>
                                  {kind === "reply" ? (
                                    <span className="comment-card__msg-tag">
                                      reply
                                    </span>
                                  ) : (
                                    <span className="comment-card__msg-tag">
                                      comment
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--small comment-card__msg-edit"
                                    onClick={() => startEdit(c, message)}
                                  >
                                    Edit
                                  </button>
                                </div>
                                {editingHere ? (
                                  <div className="comment-card__editor">
                                    <textarea
                                      className="comment-card__textarea"
                                      value={editBody}
                                      onChange={(e) =>
                                        setEditBody(e.target.value)
                                      }
                                      rows={3}
                                      aria-label={
                                        kind === "reply"
                                          ? "Edit reply"
                                          : "Edit comment"
                                      }
                                    />
                                    <div className="comment-card__editor-actions">
                                      <button
                                        type="button"
                                        className="btn btn--primary btn--small"
                                        onClick={() =>
                                          void submitEdit(session, c, message)
                                        }
                                      >
                                        Save
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn--ghost btn--small"
                                        onClick={cancelEdit}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="comment-card__msg-body">
                                    {commentBodyForDisplay(message.body) ||
                                      "(empty)"}
                                  </div>
                                )}
                              </div>
                            );
                          };

                          return (
                            <li key={c.id} className="comment-card">
                              <button
                                type="button"
                                className="comment-card__jump"
                                title={`${c.target.file_path}:${c.target.start_line}`}
                                onClick={() =>
                                  void jumpToComment(c, session.id)
                                }
                              >
                                <span className="comment-card__head">
                                  <span className="comment-card__loc">
                                    <span className="comment-card__file">
                                      {fileBasename(c.target.file_path)}
                                      <span className="comment-card__line">
                                        :{c.target.start_line}
                                      </span>
                                    </span>
                                    {fileDirname(c.target.file_path) ? (
                                      <span
                                        className="comment-card__dir"
                                        title={c.target.file_path}
                                      >
                                        {fileDirname(c.target.file_path)}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className={`chip chip--${c.status}`}>
                                    {c.status}
                                  </span>
                                </span>
                              </button>

                              <div className="comment-card__thread">
                                {renderMessage(primary, "primary")}
                                {replies.map((message) =>
                                  renderMessage(message, "reply"),
                                )}
                              </div>

                              {isReplying ? (
                                <div className="comment-card__editor">
                                  <textarea
                                    className="comment-card__textarea"
                                    value={replyBody}
                                    onChange={(e) =>
                                      setReplyBody(e.target.value)
                                    }
                                    rows={2}
                                    placeholder="Reply…"
                                  />
                                  <div className="comment-card__editor-actions">
                                    <button
                                      type="button"
                                      className="btn btn--primary btn--small"
                                      onClick={() =>
                                        void submitReply(session, c.id)
                                      }
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
                                  onChange={(e) => {
                                    void (async () => {
                                      await ensureWritable(session);
                                      await setStatus(
                                        c.id,
                                        e.target.value as typeof c.status,
                                      );
                                    })();
                                  }}
                                >
                                  <option value="discussing">discussing</option>
                                  <option value="need_modify">
                                    need_modify
                                  </option>
                                  <option value="closed">closed</option>
                                </select>
                                <div className="comment-card__actions">
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--small"
                                    onClick={() => {
                                      setReplyingId(c.id);
                                      setReplyBody("");
                                      cancelEdit();
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
                                        void (async () => {
                                          await ensureWritable(session);
                                          await deleteComment(c.id);
                                        })();
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
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function fileBasename(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Directory portion without trailing slash; empty if path is bare filename. */
function fileDirname(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : "";
}
