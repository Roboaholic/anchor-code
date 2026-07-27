import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeViewer } from "./CodeViewer";
import type { MdViewMode, SearchHighlight } from "./documentStore";

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

  return (
    <div className="md-viewer">
      <div className="md-viewer__toolbar">
        <span className="muted toolbar-hint">
          Annotate in Raw mode (Monaco selection)
        </span>
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
        <div className="md-viewer__rendered">
          {truncated ? (
            <div className="banner banner--warn">
              File is larger than 1 MB — rendered view uses the first portion
              only.
            </div>
          ) : null}
          <article className="md-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </article>
        </div>
      )}
    </div>
  );
}
