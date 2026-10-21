import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { askPopoverPosition, type AskAnchorRect } from "@/features/ask/askPrompt";
import type { CommentRecord } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import { Dropdown, isInsideDropdownMenu } from "@/shared/Dropdown";
import {
  DEFAULT_COMMENT_DRAFT,
  commentDraftKey,
  useCommentDraftStore,
} from "./commentDraftStore";

const POPOVER_WIDTH = 420;
const MAX_TEXTAREA_PX = 200;

export const COMMENT_STATUS_OPTIONS: { value: CommentRecord["status"]; label: string }[] = [
  { value: "discussing", label: "Discussing" },
  { value: "need_modify", label: "Need modify" },
  { value: "closed", label: "Closed" },
];

export type NewCommentPopoverProps = {
  path: string;
  startLine: number;
  endLine: number;
  /** Selection rect in viewport coords; null centers the popover. */
  anchor: AskAnchorRect | null | undefined;
  /** Pre-select "new session" (e.g. opened via the new-session shortcut). */
  initialNewSession?: boolean;
  onSubmit: (
    body: string,
    status: CommentRecord["status"],
    forceNewSession: boolean,
  ) => Promise<void>;
  onClose: () => void;
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Anchored bubble for creating a comment on a selection (Code / Diff /
 * Markdown). Mirrors the Ask popover: below the selection, flips above when
 * needed; Esc / click outside / wheel / resize close it with the draft kept.
 */
export function NewCommentPopover({
  path,
  startLine,
  endLine,
  anchor,
  initialNewSession = false,
  onSubmit,
  onClose,
}: NewCommentPopoverProps) {
  const key = commentDraftKey(path, startLine, endLine);
  const draft = useCommentDraftStore((s) => s.drafts[key]) ?? DEFAULT_COMMENT_DRAFT;
  const setDraft = useCommentDraftStore((s) => s.setDraft);
  const clearDraft = useCommentDraftStore((s) => s.clearDraft);
  const [newSession, setNewSession] = useState(initialNewSession);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    placement: "below" | "above";
  } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Monaco can steal focus right after the selection chip click; focus on the
  // next frame too.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    const id = window.requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(id);
  }, [key]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [draft.body]);

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const a = anchor ?? {
      top: vp.height / 3,
      bottom: vp.height / 3,
      left: (vp.width - POPOVER_WIDTH) / 2,
    };
    const next = askPopoverPosition(
      a,
      { width: el.offsetWidth || POPOVER_WIDTH, height: el.offsetHeight },
      vp,
    );
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.placement === next.placement
        ? prev
        : next,
    );
  }, [anchor, draft.body, error]);

  useEffect(() => {
    const inside = (t: EventTarget | null) =>
      (t instanceof Node && !!popRef.current?.contains(t)) || isInsideDropdownMenu(t);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) closeRef.current();
    };
    const onWheel = (e: Event) => {
      if (!inside(e.target)) closeRef.current();
    };
    const onResize = () => closeRef.current();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const canSubmit = draft.body.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draft.body.trim(), draft.status, newSession);
      clearDraft(key);
      closeRef.current();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  };

  const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;

  return createPortal(
    <div
      ref={popRef}
      className={`ask-pop comment-pop ask-pop--${pos?.placement ?? "below"}`}
      role="dialog"
      aria-modal="false"
      aria-label="New comment"
      data-placement={pos?.placement ?? "below"}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeRef.current();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          void submit();
        }
      }}
    >
      <div className="ask-pop__head">
        <span className="ask-pop__loc" title={`${path} ${lines}`}>
          <span className="ask-pop__file">{baseName(path)}</span>{" "}
          <span className="ask-pop__lines">{lines}</span>
        </span>
      </div>
      <textarea
        ref={inputRef}
        className="ask-pop__question"
        rows={2}
        placeholder="Write feedback for the AI CLI…"
        aria-label="Comment"
        value={draft.body}
        onChange={(e) => setDraft(key, { ...draft, body: e.target.value })}
      />
      {error ? <div className="comment-pop__error" role="alert">{error}</div> : null}
      <div className="ask-pop__footer">
        <Dropdown<CommentRecord["status"]>
          className="ask-pop__target comment-pop__status"
          size="sm"
          aria-label="Status"
          data-testid="comment-pop-status"
          value={draft.status}
          onChange={(status) => setDraft(key, { ...draft, status })}
          options={COMMENT_STATUS_OPTIONS}
        />
        <label
          className="comment-pop__newsession"
          title="End the active session and save this comment in a new session"
        >
          <input
            type="checkbox"
            className="anchor-checkbox"
            checked={newSession}
            onChange={(e) => setNewSession(e.target.checked)}
          />
          New session
        </label>
        <span className="comment-pop__spacer" />
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => closeRef.current()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--accent btn--small"
          disabled={!canSubmit}
          onClick={() => void submit()}
          title="Add comment (Ctrl/Cmd+Enter)"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
