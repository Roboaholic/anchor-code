import { useEffect, useRef, useState } from "react";
import type { CommentRecord } from "@/shared/anchor-api";
import { useAnnotationsStore } from "./annotationsStore";

export type BubbleMode = "view" | "edit" | "reply";

export interface CommentBubbleProps {
  comment: CommentRecord;
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
  left,
  top,
  onClose,
  onMutated,
}: CommentBubbleProps) {
  const setStatus = useAnnotationsStore((s) => s.setStatus);
  const reply = useAnnotationsStore((s) => s.reply);
  const editComment = useAnnotationsStore((s) => s.editComment);
  const deleteComment = useAnnotationsStore((s) => s.deleteComment);
  const rootRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<BubbleMode>("view");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "edit") {
      setDraft(comment.messages[0]?.body ?? "");
    } else if (mode === "reply") {
      setDraft("");
    }
  }, [mode, comment.id]);

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
      await editComment(comment.id, draft.trim());
      setMode("view");
    });
  };

  const submitReply = () => {
    if (!draft.trim()) return;
    void run(async () => {
      await reply(comment.id, draft.trim());
      setMode("view");
      setDraft("");
    });
  };

  const onDelete = () => {
    if (!window.confirm("Delete this comment thread permanently?")) return;
    void run(async () => {
      await deleteComment(comment.id);
      onClose();
    });
  };

  return (
    <div
      ref={rootRef}
      className="anno-bubble"
      style={{ left, top }}
      role="dialog"
      aria-label="Annotation"
      // Keep bubble interactions from falling through to the editor under it.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="anno-bubble__toolbar">
        <div className="anno-bubble__actions">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            title="Reply"
            onClick={() => setMode((m) => (m === "reply" ? "view" : "reply"))}
          >
            Reply
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            title="Edit primary comment"
            onClick={() => setMode((m) => (m === "edit" ? "view" : "edit"))}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={busy}
            title="Delete thread"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
        <select
          className="anno-bubble__status"
          value={comment.status}
          disabled={busy}
          title="Review status"
          onChange={(e) =>
            void run(async () => {
              await setStatus(
                comment.id,
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
          className="icon-btn anno-bubble__close"
          title="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="anno-bubble__meta">
        <span className="anno-bubble__path">
          {comment.target.file_path}:{comment.target.start_line}
        </span>
        <span className={`chip chip--${comment.status}`}>{comment.status}</span>
      </div>

      <div className="anno-bubble__messages">
        {comment.messages.map((m, i) => (
          <div key={m.id} className="anno-bubble__msg">
            <div className="anno-bubble__msg-head">
              <code>{m.author || "unknown"}</code>
              <span className="anno-bubble__msg-tag">
                {i === 0 ? "primary" : "reply"}
              </span>
            </div>
            <div className="anno-bubble__msg-body">{m.body}</div>
          </div>
        ))}
      </div>

      {mode === "edit" ? (
        <div className="anno-bubble__editor">
          <textarea
            className="anno-bubble__textarea"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="anno-bubble__editor-actions">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setMode("view")}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--accent btn--small"
              disabled={!draft.trim() || busy}
              onClick={submitEdit}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}

      {mode === "reply" ? (
        <div className="anno-bubble__editor">
          <textarea
            className="anno-bubble__textarea"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply…"
            autoFocus
          />
          <div className="anno-bubble__editor-actions">
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setMode("view")}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--accent btn--small"
              disabled={!draft.trim() || busy}
              onClick={submitReply}
            >
              Reply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
