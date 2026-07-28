import { useEffect, useRef, useState } from "react";
import {
  commentBodyForDisplay,
  rejoinDiffCommentBody,
} from "@/core/history/diffComment";
import { Icon } from "@/shared/Icon";
import type { CommentMessage, CommentRecord } from "@/shared/anchor-api";
import { useAnnotationsStore } from "./annotationsStore";

export type BubbleMode = "view" | "edit" | "reply";

export interface CommentBubbleProps {
  /** The annotation whose toolbar actions are active. */
  comment: CommentRecord;
  /** Other annotation threads hit at the same source position. */
  relatedComments?: CommentRecord[];
  left: number;
  top: number;
  onClose: () => void;
  onMutated?: () => void;
  /** Hover keep-alive: parent opens bubble on highlight dwell. */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

function isInsideBubbleOrSelect(
  el: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Node)) return false;
  if (el.contains(target)) return true;
  // Native <select> popup may render outside the dialog.
  if (target instanceof Element) {
    const tag = target.tagName;
    if (tag === "OPTION" || tag === "SELECT" || tag === "OPTGROUP") return true;
  }
  return false;
}

export function CommentBubble({
  comment,
  relatedComments = [],
  left,
  top,
  onClose,
  onMutated,
  onPointerEnter,
  onPointerLeave,
}: CommentBubbleProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const threads = [comment, ...relatedComments];
  const multi = threads.length > 1;

  // Capture phase: Monaco stops propagation on editor clicks, so bubble-phase
  // document listeners never see them.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (isInsideBubbleOrSelect(el, e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="anno-bubble"
      style={{ left, top }}
      role="dialog"
      aria-label={multi ? `${threads.length} overlapping comments` : "Comment"}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {multi ? (
        <div className="anno-bubble__header">
          <span className="anno-bubble__count">{threads.length} comments</span>
          <button
            type="button"
            className="icon-btn anno-bubble__close"
            title="Close"
            aria-label="Close annotations"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      <div className="anno-bubble__threads">
        {threads.map((thread, threadIndex) => (
          <BubbleThread
            key={thread.id}
            thread={thread}
            showClose={!multi && threadIndex === 0}
            onClose={onClose}
            onMutated={onMutated}
          />
        ))}
      </div>
    </div>
  );
}

function BubbleThread({
  thread,
  showClose,
  onClose,
  onMutated,
}: {
  thread: CommentRecord;
  showClose: boolean;
  onClose: () => void;
  onMutated?: () => void;
}) {
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);

  const primary = thread.messages[0];
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Keep selection / edit targets valid after mutations.
  useEffect(() => {
    const ids = new Set(thread.messages.map((m) => m.id));
    if (selectedMessageId && !ids.has(selectedMessageId)) {
      setSelectedMessageId(null);
    }
    if (editingMessageId && !ids.has(editingMessageId)) {
      setEditingMessageId(null);
      setDraft("");
    }
  }, [thread.messages, selectedMessageId, editingMessageId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onMutated?.();
    } finally {
      setBusy(false);
    }
  };

  const selectMessage = (messageId: string) => {
    setSelectedMessageId((current) => {
      if (current === messageId) return current;
      setEditingMessageId(null);
      setDraft("");
      return messageId;
    });
  };

  const toggleReply = () => {
    setReplying((open) => {
      if (open) {
        setDraft("");
        return false;
      }
      setEditingMessageId(null);
      setDraft("");
      return true;
    });
  };

  const toggleEdit = (message: CommentMessage) => {
    setSelectedMessageId(message.id);
    setReplying(false);
    setEditingMessageId((current) => {
      if (current === message.id) {
        setDraft("");
        return null;
      }
      setDraft(commentBodyForDisplay(message.body));
      return message.id;
    });
  };

  const submitEdit = () => {
    if (!draft.trim() || !editingMessageId) return;
    const message = thread.messages.find((m) => m.id === editingMessageId);
    if (!message) return;
    void run(async () => {
      const body =
        message.id === primary?.id
          ? rejoinDiffCommentBody(message.body, draft.trim())
          : draft.trim();
      await editComment(thread.id, body, message.id);
      setEditingMessageId(null);
      setDraft("");
    });
  };

  const submitReply = () => {
    if (!draft.trim()) return;
    void run(async () => {
      await reply(thread.id, draft.trim());
      setReplying(false);
      setDraft("");
    });
  };

  const onDeleteThread = () => {
    if (!window.confirm("Delete this comment thread permanently?")) return;
    void run(async () => {
      await deleteComment(thread.id);
    });
  };

  return (
    <section
      className="anno-bubble__thread"
      aria-label={`${primary?.author || "unknown"} comment`}
    >
      <div className="anno-bubble__bar">
        <span className="anno-bubble__hint">
          {primary?.author || "unknown"}
        </span>
        <div className="anno-bubble__actions">
          <button
            type="button"
            className={`icon-btn icon-btn--xs${replying ? " is-active" : ""}`}
            disabled={busy}
            title="Reply"
            aria-label="Reply"
            onClick={toggleReply}
          >
            <Icon name="comment-discussion" />
          </button>
          <select
            className="anno-bubble__status"
            value={thread.status}
            disabled={busy}
            title="Review status"
            aria-label="Review status"
            onChange={(e) =>
              void run(async () => {
                await setStatus(
                  thread.id,
                  e.target.value as CommentRecord["status"],
                );
              })
            }
          >
            <option value="discussing">discussing</option>
            <option value="need_modify">need_modify</option>
            <option value="closed">closed</option>
          </select>
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            disabled={busy}
            title="Delete thread"
            aria-label="Delete thread"
            onClick={onDeleteThread}
          >
            <Icon name="trash" />
          </button>
          {showClose ? (
            <button
              type="button"
              className="icon-btn icon-btn--xs anno-bubble__close"
              title="Close"
              aria-label="Close annotation"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
      </div>

      {replying ? (
        <BubbleEditor
          value={draft}
          rows={2}
          busy={busy}
          submitLabel="Reply"
          placeholder="Reply…"
          onChange={setDraft}
          onCancel={() => {
            setReplying(false);
            setDraft("");
          }}
          onSubmit={submitReply}
        />
      ) : null}

      <div className="anno-bubble__messages">
        {thread.messages.map((message, index) => {
          const selected = selectedMessageId === message.id;
          const editingHere = editingMessageId === message.id;
          return (
            <div
              key={message.id}
              className={`anno-bubble__msg${index > 0 ? " is-reply" : ""}${selected ? " is-selected" : ""}`}
            >
              <button
                type="button"
                className="anno-bubble__msg-select"
                onClick={() => selectMessage(message.id)}
                aria-pressed={selected}
              >
                <div className="anno-bubble__msg-head">
                  <span className="anno-bubble__msg-author">
                    {message.author || "unknown"}
                  </span>
                  {index > 0 ? (
                    <span className="anno-bubble__msg-tag">reply</span>
                  ) : null}
                  {selected ? (
                    <span
                      className="anno-bubble__msg-edit-slot"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`icon-btn icon-btn--xs anno-bubble__msg-edit${editingHere ? " is-active" : ""}`}
                        disabled={busy}
                        title="Edit this message"
                        aria-label="Edit this message"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleEdit(message);
                        }}
                      >
                        <Icon name="edit" />
                      </button>
                    </span>
                  ) : null}
                </div>

                {editingHere ? null : (
                  <div className="anno-bubble__msg-body">
                    {commentBodyForDisplay(message.body) || "(empty)"}
                  </div>
                )}
              </button>

              {editingHere ? (
                <BubbleEditor
                  value={draft}
                  rows={3}
                  busy={busy}
                  submitLabel="Save"
                  onChange={setDraft}
                  onCancel={() => {
                    setEditingMessageId(null);
                    setDraft("");
                  }}
                  onSubmit={submitEdit}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BubbleEditor({
  value,
  rows,
  busy,
  submitLabel,
  placeholder,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  rows: number;
  busy: boolean;
  submitLabel: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="anno-bubble__editor"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        className="anno-bubble__textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
      />
      <div className="anno-bubble__editor-actions">
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--accent btn--small"
          disabled={!value.trim() || busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
