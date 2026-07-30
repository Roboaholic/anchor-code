import {
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  locateSelectionInMarkdown,
  measureCommentMarks,
  readDomSelectionIn,
  type MarkdownSourceAnchor,
  type MdMarkRect,
} from "@/core/annotations/mdSelection";
import { CommentBubble } from "@/features/annotations/CommentBubble";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { addCommentFromSelection } from "@/features/shell/orchestrate";
import type { CommentRecord } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import { markdownFontSize } from "@/core/theme/theme";
import { useThemeStore } from "@/features/shell/themeStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { relativeToRoot } from "@/core/workspace/paths";
import { CodeViewer } from "./CodeViewer";
import type { MdViewMode, SearchHighlight } from "./documentStore";
import { isMermaidLanguage, MermaidBlock } from "./MermaidBlock";

type ComposerState = MarkdownSourceAnchor & {
  forceNewSession: boolean;
};

type BubbleState = {
  commentId: string;
  relatedCommentIds: string[];
  left: number;
  top: number;
};

type SelToolbar = { left: number; top: number; text: string };

/** Content-width fractions. Each step is relative to the current viewer width. */
const MD_WIDTH_STEPS = [0.5, 0.625, 0.75, 0.875, "full"] as const;
type MdWidthStep = (typeof MD_WIDTH_STEPS)[number];
const MD_WIDTH_STORAGE_KEY = "anchor.mdRenderedWidthStep.v2";

function loadMdWidthStep(): MdWidthStep {
  try {
    const raw = localStorage.getItem(MD_WIDTH_STORAGE_KEY);
    if (raw === "full") return "full";
    const n = raw ? Number.parseFloat(raw) : NaN;
    if (MD_WIDTH_STEPS.includes(n as MdWidthStep)) return n as MdWidthStep;
  } catch {
    // ignore
  }
  return 0.75;
}

function persistMdWidthStep(step: MdWidthStep) {
  try {
    localStorage.setItem(MD_WIDTH_STORAGE_KEY, String(step));
  } catch {
    // ignore
  }
}

function mdBodyWidth(step: MdWidthStep): string {
  if (step === "full") return "100%";
  return `${Math.round(step * 100)}%`;
}

function mdWidthLabel(step: MdWidthStep): string {
  if (step === "full") return "Full";
  return `${Math.round(step * 100)}%`;
}

function codeChildToText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(codeChildToText).join("");
  if (children == null) return "";
  return String(children);
}

function MarkdownCode(
  props: ComponentPropsWithoutRef<"code"> & { inline?: boolean },
) {
  const { className, children, inline, ...rest } = props;
  const text = codeChildToText(children).replace(/\n$/, "");
  // react-markdown v10: fenced blocks are block-level <pre><code>, no inline prop reliably.
  const isBlock =
    inline === false ||
    (typeof className === "string" && className.includes("language-")) ||
    text.includes("\n");

  if (isBlock && isMermaidLanguage(className)) {
    return <MermaidBlock chart={text} />;
  }

  if (isBlock) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

function MarkdownPre({
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre">) {
  // react-markdown wraps fenced code as <pre><code class="language-…">.
  // Lift mermaid out of <pre> so the diagram is not monospaced/preformatted.
  const only = Array.isArray(children)
    ? children.length === 1
      ? children[0]
      : null
    : children;
  if (isValidElement(only)) {
    const props = only.props as {
      className?: string;
      children?: ReactNode;
    };
    if (isMermaidLanguage(props.className)) {
      const text = codeChildToText(props.children).replace(/\n$/, "");
      return <MermaidBlock chart={text} />;
    }
  }
  return <pre {...rest}>{children}</pre>;
}

export function MarkdownViewer({
  path,
  content,
  truncated,
  mode,
  onModeChange,
  revealLine,
  focusCommentId,
  revealNonce,
  searchHighlight = null,
}: {
  path: string;
  content: string;
  truncated: boolean;
  mode: MdViewMode;
  onModeChange: (mode: MdViewMode) => void;
  revealLine?: number;
  focusCommentId?: string | null;
  revealNonce?: number;
  searchHighlight?: SearchHighlight | null;
}) {
  // Prefer raw when jumping from search so the match can be highlighted.
  const effectiveMode = searchHighlight ? "raw" : mode;
  const [widthStep, setWidthStep] = useState<MdWidthStep>(() => loadMdWidthStep());

  const widthIndex = MD_WIDTH_STEPS.indexOf(widthStep);
  const canNarrow = widthIndex > 0;
  const canWiden = widthIndex >= 0 && widthIndex < MD_WIDTH_STEPS.length - 1;

  const setWidth = useCallback((step: MdWidthStep) => {
    setWidthStep(step);
    persistMdWidthStep(step);
  }, []);

  const widen = useCallback(() => {
    const idx = MD_WIDTH_STEPS.indexOf(widthStep);
    if (idx < 0 || idx >= MD_WIDTH_STEPS.length - 1) return;
    setWidth(MD_WIDTH_STEPS[idx + 1]!);
  }, [setWidth, widthStep]);

  const narrow = useCallback(() => {
    const idx = MD_WIDTH_STEPS.indexOf(widthStep);
    if (idx <= 0) return;
    setWidth(MD_WIDTH_STEPS[idx - 1]!);
  }, [setWidth, widthStep]);

  return (
    <div className="md-viewer">
      <div className="md-viewer__toolbar">
        <span className="muted toolbar-hint">
          {effectiveMode === "rendered"
            ? "Select text to comment · mermaid fences render as diagrams"
            : "Annotate via Monaco selection"}
        </span>
        <div className="md-viewer__toolbar-end">
          {effectiveMode === "rendered" ? (
            <div
              className="md-width-controls"
              role="group"
              aria-label="Rendered content width"
            >
              <button
                type="button"
                className="icon-btn md-width-controls__btn"
                title="Narrower"
                aria-label="Narrow rendered content"
                disabled={!canNarrow}
                onClick={narrow}
              >
                <Icon name="screen-normal" />
              </button>
              <span className="md-width-controls__label" title="Content width">
                {mdWidthLabel(widthStep)}
              </span>
              <button
                type="button"
                title="Wider"
                aria-label="Widen rendered content"
                disabled={!canWiden}
                onClick={widen}
              >
                <Icon name="screen-full" />
              </button>
            </div>
          ) : null}
          <div className="segmented" role="group" aria-label="Markdown view mode">
            <button
              type="button"
              className={`segmented__btn${effectiveMode === "rendered" ? " is-active" : ""}`}
              onClick={() => onModeChange("rendered")}
            >
              Rendered
            </button>
            <button
              type="button"
              className={`segmented__btn${effectiveMode === "raw" ? " is-active" : ""}`}
              onClick={() => onModeChange("raw")}
            >
              Raw
            </button>
          </div>
        </div>
      </div>

      {effectiveMode === "raw" ? (
        <CodeViewer
          path={path}
          content={content}
          language="markdown"
          truncated={truncated}
          revealLine={revealLine}
          focusCommentId={focusCommentId}
          revealNonce={revealNonce}
          searchHighlight={searchHighlight}
          kind="markdown"
        />
      ) : (
        <RenderedMarkdownPane
          path={path}
          content={content}
          truncated={truncated}
          focusCommentId={focusCommentId}
          revealNonce={revealNonce}
          widthStep={widthStep}
        />
      )}
    </div>
  );
}

function RenderedMarkdownPane({
  path,
  content,
  truncated,
  focusCommentId,
  revealNonce,
  widthStep,
}: {
  path: string;
  content: string;
  truncated: boolean;
  focusCommentId?: string | null;
  revealNonce?: number;
  widthStep: MdWidthStep;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLElement | null>(null);
  const composerOpenRef = useRef(false);
  const bubbleRef = useRef<BubbleState | null>(null);
  const pendingSelectionTextRef = useRef<string | null>(null);
  const fontSize = useThemeStore((s) => s.fontSize);
  const mdFontSize = markdownFontSize(fontSize);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const decorationsFor = useAnnotationsStore((s) => s.decorationsFor);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const activeSession = useAnnotationsStore((s) => s.activeSession);

  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [selToolbar, setSelToolbar] = useState<SelToolbar | null>(null);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [marks, setMarks] = useState<MdMarkRect[]>([]);
  const [locateError, setLocateError] = useState<string | null>(null);

  composerOpenRef.current = Boolean(composer);
  bubbleRef.current = bubble;

  const liveComment = useCallback((id: string): CommentRecord | null => {
    const state = useAnnotationsStore.getState();
    for (const session of state.sessions) {
      const found = session.comments.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  }, []);

  const fileComments = useMemo(() => {
    const specs = decorationsFor(path, content);
    const out: Array<{
      id: string;
      selectedText: string;
      lineText?: string;
      status: string;
    }> = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      for (const c of session.comments) {
        if (seen.has(c.id)) continue;
        if (!specs.some((s) => s.commentId === c.id)) continue;
        seen.add(c.id);
        out.push({
          id: c.id,
          selectedText: c.target.selected_text,
          lineText: c.target.line_text,
          status: c.status,
        });
      }
    }
    return out;
  }, [content, decorationsFor, path, sessions, expandedSessionId, activeSession]);

  const refreshMarks = useCallback(() => {
    const root = bodyRef.current;
    const container = scrollRef.current;
    if (!root || !container) {
      setMarks([]);
      return;
    }
    setMarks(measureCommentMarks(root, fileComments, container));
  }, [fileComments]);

  useEffect(() => {
    // Width changes reflow the article; remeasure mark overlays after layout.
    const id = window.requestAnimationFrame(() => refreshMarks());
    return () => window.cancelAnimationFrame(id);
  }, [refreshMarks, content, revealNonce, widthStep]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => refreshMarks();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [refreshMarks]);

  // Focus mark when jumping from comments pane.
  useEffect(() => {
    if (!focusCommentId) return;
    const mark = marks.find((m) => m.commentId === focusCommentId);
    const container = scrollRef.current;
    if (!mark || !container) return;
    container.scrollTo({
      top: Math.max(0, mark.top - 80),
      behavior: "smooth",
    });
    setBubble({
      commentId: focusCommentId,
      relatedCommentIds: [],
      left: mark.left,
      top: mark.top + mark.height + 6,
    });
  }, [focusCommentId, revealNonce, marks]);

  const updateSelectionToolbar = useCallback(() => {
    if (composerOpenRef.current) {
      pendingSelectionTextRef.current = null;
      setSelToolbar(null);
      return;
    }
    const root = bodyRef.current;
    const container = scrollRef.current;
    const sel = readDomSelectionIn(root);
    if (!sel || !container) {
      // Keep the chip/cache briefly: button interaction can collapse the
      // live DOM selection before the click/pointer handler runs.
      return;
    }
    const rect = sel.range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return;
    }
    const crect = container.getBoundingClientRect();
    const icon = 28;
    const left = Math.min(
      Math.max(4, rect.right - crect.left + container.scrollLeft - icon),
      Math.max(4, container.clientWidth - icon - 4),
    );
    const top = Math.max(
      4,
      rect.top - crect.top + container.scrollTop - icon - 4,
    );
    // Cache selected text: clicking the chip can clear the live DOM selection.
    pendingSelectionTextRef.current = sel.text;
    setSelToolbar({ left, top, text: sel.text });
  }, []);

  useEffect(() => {
    const onSelChange = () => {
      // Defer so mouseup finishes and selection stabilizes.
      window.requestAnimationFrame(() => updateSelectionToolbar());
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [updateSelectionToolbar]);

  // Dismiss the floating chip when the user clicks outside it.
  useEffect(() => {
    if (!selToolbar || composer) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".anno-sel-chip")) return;
      // New interaction in the body: hide until selectionchange settles.
      pendingSelectionTextRef.current = null;
      setSelToolbar(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [selToolbar, composer]);

  // Comment bar open: click elsewhere or start a new selection → dismiss.
  useEffect(() => {
    if (!composer) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".composer")) return;
      setComposer(null);
      setBody("");
      setLocateError(null);
      pendingSelectionTextRef.current = null;
      setSelToolbar(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [composer]);

  const openComposer = useCallback(
    (forceNewSession: boolean, selectionText?: string | null) => {
      const text = (
        selectionText ??
        pendingSelectionTextRef.current ??
        readDomSelectionIn(bodyRef.current)?.text ??
        ""
      ).trim();
      if (!text) {
        setLocateError("Select text in the rendered document first.");
        return;
      }
      const anchor = locateSelectionInMarkdown(content, text);
      if (!anchor) {
        setLocateError(
          "Could not map the selection back to the Markdown source. Try a longer phrase or switch to Raw.",
        );
        return;
      }
      setLocateError(null);
      setBubble(null);
      pendingSelectionTextRef.current = null;
      setSelToolbar(null);
      setComposer({ ...anchor, forceNewSession });
      setBody("");
      // Clear DOM selection so highlight doesn't fight the composer.
      window.getSelection()?.removeAllRanges();
    },
    [content],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "m") return;
      // Only when focus is inside rendered pane.
      const root = scrollRef.current;
      if (!root) return;
      if (
        !root.contains(document.activeElement) &&
        document.activeElement !== document.body
      ) {
        // Still allow when selection is inside root.
        const sel = window.getSelection();
        if (
          !sel ||
          sel.rangeCount === 0 ||
          !root.contains(sel.getRangeAt(0).commonAncestorContainer)
        ) {
          return;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      openComposer(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openComposer]);

  const submit = async (forceNewSession = composer?.forceNewSession ?? false) => {
    if (!composer || !body.trim()) return;
    setSaving(true);
    try {
      await addCommentFromSelection({
        filePath: path,
        kind: "markdown",
        startLine: composer.startLine,
        endLine: composer.endLine,
        startColumn: composer.startColumn,
        endColumn: composer.endColumn,
        selectedText: composer.selectedText,
        beforeContext: composer.beforeContext,
        afterContext: composer.afterContext,
        lineText: composer.lineText,
        body: body.trim(),
        forceNewSession,
      });
      setComposer(null);
      setBody("");
      // marks refresh via store → fileComments
    } finally {
      setSaving(false);
    }
  };

  const openBubbleFromMark = (commentId: string, mark: MdMarkRect) => {
    setSelToolbar(null);
    setBubble({
      commentId,
      relatedCommentIds: [],
      left: mark.left,
      top: mark.top + mark.height + 6,
    });
  };

  const bubbleComment = bubble ? liveComment(bubble.commentId) : null;

  return (
    <div className="md-viewer__rendered" ref={scrollRef}>
      {truncated ? (
        <div className="banner banner--warn">
          File is larger than 1 MB — rendered view uses the first portion only.
        </div>
      ) : null}

      <div
        className="md-viewer__rendered-surface"
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <article
          className={`md-body${widthStep === "full" ? " md-body--full" : ""}`}
          ref={bodyRef}
          style={{
            width: mdBodyWidth(widthStep),
            maxWidth: "none",
            fontSize: `${mdFontSize}px`,
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: MarkdownCode,
              pre: MarkdownPre,
            }}
          >
            {content}
          </ReactMarkdown>
        </article>

        {marks.map((m) => (
          <button
            key={m.commentId}
            type="button"
            className={`md-anno-mark${
              bubble?.commentId === m.commentId ? " is-active" : ""
            }`}
            style={{
              left: m.left,
              top: m.top,
              width: m.width,
              height: m.height,
            }}
            title="Show comment"
            aria-label="Show comment"
            onClick={(e: ReactMouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              openBubbleFromMark(m.commentId, m);
            }}
          />
        ))}

        {selToolbar && !composer ? (
          <button
            type="button"
            className="anno-sel-chip"
            style={{ left: selToolbar.left, top: selToolbar.top }}
            title="Add comment"
            aria-label="Add comment"
            onMouseDown={(e) => {
              // Open on mousedown so we still have the cached selection even if
              // focus/click collapses the live DOM selection.
              e.preventDefault();
              e.stopPropagation();
              openComposer(
                false,
                pendingSelectionTextRef.current ?? selToolbar.text,
              );
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Icon name="comment" />
          </button>
        ) : null}

        {bubble && bubbleComment ? (
          <CommentBubble
            key={bubble.commentId}
            comment={bubbleComment}
            left={bubble.left}
            top={bubble.top}
            onClose={() => setBubble(null)}
            onMutated={() => {
              if (bubble && !liveComment(bubble.commentId)) setBubble(null);
              refreshMarks();
            }}
          />
        ) : null}
      </div>

      {locateError ? (
        <div className="banner banner--warn" role="status">
          {locateError}
        </div>
      ) : null}

      {composer ? (
        <div className="composer">
          <div className="composer__meta">
            L{composer.startLine}–{composer.endLine}:{" "}
            <code>{composer.selectedText.slice(0, 80)}</code>
            {composer.forceNewSession ? (
              <span className="composer__badge">new session</span>
            ) : null}
          </div>
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
              className="btn btn--ghost btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit(true)}
              title="End the active session and save this comment in a new session"
            >
              Save comment (new session)
            </button>
            <button
              type="button"
              className="btn btn--accent btn--small"
              disabled={!body.trim() || saving}
              onClick={() => void submit(false)}
            >
              {saving ? "Saving…" : "Save comment"}
            </button>
          </div>
        </div>
      ) : null}

      {ctxMenu ? (
        <>
          <div
            className="md-ctx-menu__backdrop"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="file-tree-menu md-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            role="menu"
          >
            <button
              type="button"
              className="file-tree-menu__item"
              role="menuitem"
              onClick={() => {
                const rel = workspaceRoot
                  ? relativeToRoot(workspaceRoot, path)
                  : path;
                void navigator.clipboard?.writeText?.(rel);
                setCtxMenu(null);
              }}
            >
              Copy Relative Path
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
