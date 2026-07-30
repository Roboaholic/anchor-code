import {
  commentBodyForDisplay,
  rejoinDiffCommentBody,
} from "@/core/history/diffComment";
import { Icon } from "@/shared/Icon";
import { jumpToComment } from "@/features/shell/orchestrate";
import { useAnnotationsStore } from "./annotationsStore";
import { CommentMarkdown } from "./CommentMarkdown";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import {
  countOpenFeedbackComments,
} from "./feedbackPrompt";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  CommentMessage,
  CommentRecord,
  SessionRecord,
} from "@/shared/anchor-api";

export function CommentsPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);

  const repoRoot = useAnnotationsStore((s) => s.repoRoot);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const error = useAnnotationsStore((s) => s.error);
  const toast = useAnnotationsStore((s) => s.toast);
  const loading = useAnnotationsStore((s) => s.loading);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const setExpandedSession = useAnnotationsStore((s) => s.setExpandedSession);
  const startFreshSession = useAnnotationsStore((s) => s.startFreshSession);
  const copyYamlPath = useAnnotationsStore((s) => s.copyYamlPath);
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);
  const clearToast = useAnnotationsStore((s) => s.clearToast);
  const openAgentMenu = useTerminalStore((s) => s.openAgentMenu);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  // Per-comment refs for the status buttons, used to anchor the dropdown menu.
  const statusBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Collapsed = show only the original comment (replies hidden). Default all collapsed.
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<string>>(
    () => new Set(),
  );
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

  // Track known comment ids so new multi-message threads start collapsed.
  const knownCommentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const allIds = sessions.flatMap((s) => s.comments.map((c) => c.id));
    const valid = new Set(allIds);
    const known = knownCommentIdsRef.current;
    const firstPass = known.size === 0;

    setCollapsedCommentIds((current) => {
      const next = new Set<string>();
      for (const id of current) {
        if (valid.has(id)) next.add(id);
      }
      for (const s of sessions) {
        for (const c of s.comments) {
          if (c.messages.length <= 1) continue;
          const isNew = firstPass || !known.has(c.id);
          if (isNew) next.add(c.id);
        }
      }
      return next;
    });

    knownCommentIdsRef.current = valid;
  }, [sessions]);


  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearToast(), 2200);
    return () => window.clearTimeout(t);
  }, [toast, clearToast]);

  useEffect(() => {
    let cancelled = false;
    async function syncRepo() {
      // Sessions are anchored to the workspace root (not the git root) so that
      // cross-repo comments stay under a single, stable directory.
      const root = workspaceRoot;
      if (cancelled || !root) return;
      // Same workspace: do not reload — jump-to-comment must not flash the list.
      if (useAnnotationsStore.getState().repoRoot === root) return;
      await loadForRepo(root);
    }
    void syncRepo();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, loadForRepo]);


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
    setExpandedSession(id);
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCommentCollapsed = useCallback((commentId: string) => {
    setCollapsedCommentIds((current) => {
      const next = new Set(current);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  }, []);


  const openFeedbackForSession = useCallback(
    (session: SessionRecord) => {
      if (!repoRoot) {
        useAnnotationsStore.setState({
          toast: "Open a workspace first",
        });
        return;
      }
      const yamlPath =
        session.filePath?.trim() || joinSessionYamlPath(repoRoot, session.id);
      const counts = countOpenFeedbackComments(session.comments);
      // Open immediately — skill gate runs on Start in the agent dialog.
      openAgentMenu({
        kind: "feedback",
        sessionId: session.id,
        sessionTitle: session.title,
        yamlPath,
        exportPath: null,
        openCount: counts.open,
        needModifyCount: counts.needModify,
      });
    },
    [repoRoot, openAgentMenu],
  );


  return (
    <div className="comments-pane">
      <div className="comments-pane__toolbar">
        <div className="comments-pane__toolbar-left">
          <span className="files-pane__title">Sessions</span>
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
                      className={`session-row__dot${
                        writable ? " is-live" : " is-closed"
                      }`}
                      title={writable ? "Active" : "Closed"}
                      aria-label={writable ? "Active session" : "Closed session"}
                    />
                    <span className="session-row__count">
                      {session.comments.length}
                    </span>
                  </button>
                  <div className="session-row__actions">
                    <button
                      type="button"
                      className="icon-btn session-row__feedback"
                      title="Feedback to agent"
                      aria-label="Feedback to agent"
                      disabled={!repoRoot || session.comments.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFeedbackForSession(session);
                      }}
                    >
                      <Icon name="robot" />
                      <span>Feedback</span>
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
                          const threadCollapsed =
                            replies.length > 0 && collapsedCommentIds.has(c.id);
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
                                    className="icon-btn comment-card__msg-edit"
                                    title="Edit"
                                    aria-label={
                                      kind === "reply"
                                        ? "Edit reply"
                                        : "Edit comment"
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      startEdit(c, message);
                                    }}
                                  >
                                    <Icon name="edit" />
                                  </button>
                                </div>
                                {editingHere ? (
                                  <div
                                    className="comment-card__editor"
                                    onClick={(e) => e.stopPropagation()}
                                  >
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
                                  <div
                                    className="comment-card__msg-body"
                                    // Links and other markdown elements must not
                                    // bubble up to the card's jump-to-file click.
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {commentBodyForDisplay(message.body) ? (
                                      <CommentMarkdown
                                        content={commentBodyForDisplay(
                                          message.body,
                                        )}
                                      />
                                    ) : (
                                      "(empty)"
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          };

                          return (
                            <li
                              key={c.id}
                              className={`comment-card${
                                threadCollapsed ? " is-collapsed" : ""
                              }`}
                              onClick={() => {
                                setExpandedSession(session.id);
                                void jumpToComment(c, session.id);
                              }}
                            >
                              <div className="comment-card__top">
                                <button
                                  type="button"
                                  className="comment-card__jump"
                                  title={`${c.target.file_path}:${c.target.start_line}`}
                                  onClick={() => {
                                    setExpandedSession(session.id);
                                    void jumpToComment(c, session.id);
                                  }}
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
                                  </span>
                                </button>
                                <div className="comment-card__status-wrap">
                                  <button
                                    type="button"
                                    ref={(el) => {
                                      statusBtnRefs.current[c.id] = el;
                                    }}
                                    className={`comment-card__status-btn chip--${c.status}`}
                                    title="Change status"
                                    aria-label="Change status"
                                    aria-haspopup="menu"
                                    aria-expanded={statusMenuId === c.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setStatusMenuId(
                                        statusMenuId === c.id ? null : c.id,
                                      );
                                    }}
                                  >
                                    <span className="comment-card__status-label">
                                      {c.status}
                                    </span>
                                    <Icon name="chevron-down" />
                                  </button>
                                  {statusMenuId === c.id ? (
                                    <StatusMenu
                                      anchorRef={{
                                        current: statusBtnRefs.current[c.id],
                                      }}
                                      current={c.status}
                                      onClose={() => setStatusMenuId(null)}
                                      onPick={(s) => {
                                        void (async () => {
                                          await ensureWritable(session);
                                          await setStatus(c.id, s);
                                        })();
                                      }}
                                    />
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  className="icon-btn comment-card__reply-btn"
                                  title="Reply"
                                  aria-label="Reply"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReplyingId(c.id);
                                    setReplyBody("");
                                    cancelEdit();
                                    if (threadCollapsed) {
                                      toggleCommentCollapsed(c.id);
                                    }
                                  }}
                                >
                                  <Icon name="reply" />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn comment-card__delete"
                                  title="Delete comment"
                                  aria-label="Delete comment"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (
                                      !window.confirm(
                                        "Delete this comment thread permanently?",
                                      )
                                    ) {
                                      return;
                                    }
                                    void (async () => {
                                      await ensureWritable(session);
                                      await deleteComment(c.id);
                                    })();
                                  }}
                                >
                                  <Icon name="trash" />
                                </button>
                              </div>

                              <div className="comment-card__thread">
                                {renderMessage(primary, "primary")}
                                {replies.length > 0 ? (
                                  <button
                                    type="button"
                                    className="comment-card__replies-toggle"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleCommentCollapsed(c.id);
                                    }}
                                    aria-expanded={!threadCollapsed}
                                  >
                                    <Icon
                                      name={
                                        threadCollapsed
                                          ? "chevron-right"
                                          : "chevron-down"
                                      }
                                    />
                                    <span>
                                      {threadCollapsed
                                        ? `${replies.length} ${
                                            replies.length === 1
                                              ? "reply"
                                              : "replies"
                                          }`
                                        : "Hide replies"}
                                    </span>
                                  </button>
                                ) : null}
                                {!threadCollapsed &&
                                  replies.map((message) =>
                                    renderMessage(message, "reply"),
                                  )}
                              </div>

                              {isReplying ? (
                                <div
                                  className="comment-card__editor"
                                  onClick={(e) => e.stopPropagation()}
                                >
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

const STATUS_OPTIONS = [
  "discussing",
  "need_modify",
  "closed",
] as const;

type CommentStatus = (typeof STATUS_OPTIONS)[number];

/**
 * Status dropdown rendered into document.body via portal so it escapes any
 * ancestor with overflow:hidden (e.g. .comment-card). Anchored to the button.
 */
function StatusMenu({
  anchorRef,
  current,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  current: CommentStatus;
  onPick: (status: CommentStatus) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.right });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="status-menu__backdrop" onClick={onClose} />
      <div
        ref={menuRef}
        className="status-menu"
        role="menu"
        style={{
          // Position then shift left by width once measured via CSS translate
          top: pos.top,
          left: pos.left,
          transform: "translateX(-100%)",
        }}
      >
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={`status-menu__item${s === current ? " is-active" : ""}`}
            role="menuitemradio"
            aria-checked={s === current}
            onClick={() => {
              onPick(s);
              onClose();
            }}
          >
            <span className={`status-menu__dot chip--${s}`} />
            <span className="status-menu__text">{s}</span>
            {s === current ? <Icon name="check" /> : null}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** Best-effort absolute YAML path without an IPC round-trip. */
function joinSessionYamlPath(repoRoot: string, sessionId: string): string {
  const root = repoRoot.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") && !root.startsWith("/") ? "\\" : "/";
  return `${root}${sep}.anchor-code${sep}${sessionId}.yaml`;
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
