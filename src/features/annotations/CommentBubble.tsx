import { useEffect, useRef, useState } from "react";
import {
  commentBodyForDisplay,
  rejoinDiffCommentBody,
} from "@/core/history/diffComment";
import type { CommentRecord } from "@/shared/anchor-api";
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
}: CommentBubbleProps) {
  const sessions = useAnnotationsStore((s) => s.sessions);
  const rootRef = useRef<HTMLDivElement>(null);
  const threads = [comment, ...relatedComments];

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
      className={`anno-bubble${threads.length > 1 ? " has-overlap" : ""}`}
      style={{ left, top }}
      role="dialog"
      aria-label={`${threads.length} annotation${threads.length === 1 ? "" : "s"}`}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="anno-bubble__header">
        <span className="anno-bubble__count">
          {threads.length === 1 ? "Comment" : `${threads.length} overlapping comments`}
        </span>
        <button
          type="button"
          className="icon-btn anno-bubble__close"
          title="Close"
          aria-label="Close annotations"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="anno-bubble__threads">
        {threads.map((thread, threadIndex) => {
          const owner = sessions.find((session) =>
            session.comments.some((candidate) => candidate.id === thread.id),
          );
          return (
            <BubbleThread
              key={thread.id}
              thread={thread}
              ownerLabel={owner?.title ?? "Session"}
              selected={threadIndex === 0}
              onMutated={onMutated}
            />
          );
        })}
      </div>
    </div>
  );
}

function BubbleThread({
  thread,
  ownerLabel,
  selected,
  onMutated,
}: {
  thread: CommentRecord;
  ownerLabel: string;
  selected: boolean;
  onMutated?: () => void;
}) {
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);
  const [mode, setMode] = useState<BubbleMode>("view");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit") {
      setDraft(commentBodyForDisplay(thread.messages[0]?.body ?? ""));
    } else if (mode === "reply") {
      setDraft("");
    }
  }, [mode, thread.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onMutated?.();
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = () => {
    if (!draft.trim()) return;
    void run(async () => {
      const original = thread.messages[0]?.body ?? "";
      await editComment(
        thread.id,
        rejoinDiffCommentBody(original, draft.trim()),
      );
      setMode("view");
    });
  };

  const submitReply = () => {
    if (!draft.trim()) return;
    void run(async () => {
      await reply(thread.id, draft.trim());
      setMode("view");
      setDraft("");
    });
  };

  const onDelete = () => {
    if (!window.confirm("Delete this comment thread permanently?")) return;
    void run(async () => {
      await deleteComment(thread.id);
    });
  };

  return (
    <section
      className={`anno-bubble__thread${selected ? " is-selected" : ""}`}
      aria-label={`${ownerLabel} comment`}
    >
      <div className="anno-bubble__thread-head">
        <span className="anno-bubble__thread-meta">{ownerLabel}</span>
        {selected ? (
          <span className="anno-bubble__selected-label">selected</span>
        ) : null}
      </div>
      <div className="anno-bubble__toolbar">
        <div className="anno-bubble__actions">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            onClick={() => setMode((value) => (value === "reply" ? "view" : "reply"))}
          >
            Reply
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            onClick={() => setMode((value) => (value === "edit" ? "view" : "edit"))}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
        <select
          className="anno-bubble__status"
          value={thread.status}
          disabled={busy}
          title="Review status"
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
      </div>

      <div className="anno-bubble__messages">
        {thread.messages.map((message, index) => (
          <div key={message.id} className="anno-bubble__msg">
            <div className="anno-bubble__msg-head">
              <code>{message.author || "unknown"}</code>
              <span className="anno-bubble__msg-tag">
                {index === 0 ? "primary" : "reply"}
              </span>
            </div>
            <div className="anno-bubble__msg-body">
              {commentBodyForDisplay(message.body) || "(empty)"}
            </div>
          </div>
        ))}
      </div>

      {mode === "edit" ? (
        <BubbleEditor
          value={draft}
          rows={3}
          busy={busy}
          submitLabel="Save"
          onChange={setDraft}
          onCancel={() => setMode("view")}
          onSubmit={submitEdit}
        />
      ) : null}
      {mode === "reply" ? (
        <BubbleEditor
          value={draft}
          rows={2}
          busy={busy}
          submitLabel="Reply"
          placeholder="Reply…"
          onChange={setDraft}
          onCancel={() => setMode("view")}
          onSubmit={submitReply}
        />
      ) : null}
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
    <div className="anno-bubble__editor">
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
