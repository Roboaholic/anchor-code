import type { editor as MonacoEditor } from "monaco-editor";
import { joinPath, relativeToRoot } from "@/core/workspace/paths";

/** Workspace-relative POSIX path; falls back to the original path. */
export function workspaceRelativePath(
  workspaceRoot: string | null | undefined,
  path: string,
): string {
  if (!path) return "";
  if (!workspaceRoot) return path.replace(/\\/g, "/");
  const rel = relativeToRoot(workspaceRoot, path);
  return (rel || path).replace(/\\/g, "/");
}

/**
 * Diff files are repo-relative. Join onto the repo root, then strip the
 * workspace root so nested repos copy `common/camera/cam_com/…`.
 */
export function repoFileWorkspaceRelativePath(
  workspaceRoot: string | null | undefined,
  repoRoot: string,
  repoRelativeFile: string,
): string {
  if (!repoRelativeFile) return "";
  return workspaceRelativePath(
    workspaceRoot,
    joinPath(repoRoot, repoRelativeFile),
  );
}

/** `path:12` or `path:12-18` for a selection range. */
export function formatPathWithLine(
  relativePath: string,
  startLine?: number | null,
  endLine?: number | null,
): string {
  const start =
    typeof startLine === "number" && startLine > 0 ? startLine : 1;
  const end = typeof endLine === "number" && endLine > 0 ? endLine : start;
  if (start === end) return `${relativePath}:${start}`;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return `${relativePath}:${lo}-${hi}`;
}

function writeClipboard(text: string): void {
  if (!text) return;
  try {
    void navigator.clipboard?.writeText?.(text);
  } catch {
    // ignore
  }
}

/**
 * Monaco editor context-menu actions matching CodeViewer:
 * Copy Relative Path, Copy Path with Line.
 */
export function registerCopyPathActions(
  editor: MonacoEditor.IStandaloneCodeEditor,
  getRelativePath: () => string,
  idPrefix = "anchor",
): { dispose(): void } {
  const relative = editor.addAction({
    id: `${idPrefix}-copy-relative-path`,
    label: "Copy Relative Path",
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder: 10,
    run: () => writeClipboard(getRelativePath()),
  });
  const withLine = editor.addAction({
    id: `${idPrefix}-copy-path-with-line`,
    label: "Copy Path with Line",
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder: 11,
    run: (ed) => {
      const rel = getRelativePath();
      if (!rel) return;
      const sel = ed.getSelection();
      writeClipboard(
        formatPathWithLine(rel, sel?.startLineNumber, sel?.endLineNumber),
      );
    },
  });
  return {
    dispose: () => {
      relative.dispose();
      withLine.dispose();
    },
  };
}
