import { lazy, Suspense } from "react";
import { isSvgPath } from "@/core/workspace/markdownLinks";
import type { MdViewMode } from "./documentStore";
import { useWorkspaceImage } from "./workspaceImage";

const CodeViewer = lazy(() => import("./CodeViewer").then((m) => ({ default: m.CodeViewer })));

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Image tab (png/jpg/gif/webp/svg…). SVG keeps a Source view so the XML can
 * still be read and commented on; the preview is always an <img> data URL.
 */
export function ImageViewer({
  path,
  content,
  truncated,
  size,
  mode,
  onModeChange,
  revealLine,
  focusCommentId,
  revealNonce,
  reloadEpoch,
}: {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  mode: MdViewMode;
  onModeChange: (mode: MdViewMode) => void;
  revealLine?: number;
  focusCommentId?: string | null;
  revealNonce?: number;
  /** Bumps when the tab reloads from disk so raster previews re-fetch. */
  reloadEpoch?: number;
}) {
  const svg = isSvgPath(path);
  const showSource = svg && mode === "raw";
  // Re-read when the file content changes (SVG source reload / watcher refresh).
  const image = useWorkspaceImage(
    showSource ? null : path,
    svg ? content : `${size}:${reloadEpoch ?? 0}`,
  );

  return (
    <div className="md-viewer image-viewer">
      <div className="md-viewer__toolbar">
        <span className="muted toolbar-hint">
          {image.status === "ready" && !showSource && size > 0 ? formatBytes(size) : ""}
        </span>
        {svg ? (
          <div className="md-viewer__toolbar-end">
            <div className="segmented" role="group" aria-label="SVG view mode">
              <button
                type="button"
                className={`segmented__btn${!showSource ? " is-active" : ""}`}
                onClick={() => onModeChange("rendered")}
              >
                Preview
              </button>
              <button
                type="button"
                className={`segmented__btn${showSource ? " is-active" : ""}`}
                onClick={() => onModeChange("raw")}
              >
                Source
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {showSource ? (
        <Suspense fallback={<div className="empty-center muted" role="status">Loading editor…</div>}>
          <CodeViewer
            path={path}
            content={content}
            language="xml"
            truncated={truncated}
            revealLine={revealLine}
            focusCommentId={focusCommentId}
            revealNonce={revealNonce}
            kind="source"
          />
        </Suspense>
      ) : (
        <div className="image-viewer__stage">
          {image.status === "ready" ? (
            <img className="image-viewer__img" src={image.src} alt={path} draggable={false} />
          ) : image.status === "loading" ? (
            <div className="empty-center muted" role="status">Loading…</div>
          ) : (
            <div className="empty-center">
              <p className="error-text">Failed to open image</p>
              <p className="muted">{image.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
