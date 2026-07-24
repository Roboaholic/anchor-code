import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeViewer } from "./CodeViewer";
import type { MdViewMode } from "./documentStore";

export function MarkdownViewer({
  path,
  content,
  truncated,
  mode,
  onModeChange,
  revealLine,
  focusCommentId,
  revealNonce,
}: {
  path: string;
  content: string;
  truncated: boolean;
  mode: MdViewMode;
  onModeChange: (mode: MdViewMode) => void;
  revealLine?: number;
  focusCommentId?: string | null;
  revealNonce?: number;
}) {
  return (
    <div className="md-viewer">
      <div className="md-viewer__toolbar">
        <span className="muted toolbar-hint">
          Annotate in Raw mode (Monaco selection)
        </span>
        <div className="segmented" role="group" aria-label="Markdown view mode">
          <button
            type="button"
            className={`segmented__btn${mode === "rendered" ? " is-active" : ""}`}
            onClick={() => onModeChange("rendered")}
          >
            Rendered
          </button>
          <button
            type="button"
            className={`segmented__btn${mode === "raw" ? " is-active" : ""}`}
            onClick={() => onModeChange("raw")}
          >
            Raw
          </button>
        </div>
      </div>

      {mode === "raw" ? (
        <CodeViewer
          path={path}
          content={content}
          language="markdown"
          truncated={truncated}
          revealLine={revealLine}
          focusCommentId={focusCommentId}
          revealNonce={revealNonce}
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
