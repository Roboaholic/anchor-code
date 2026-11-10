import { useEffect, type RefObject } from "react";
import { joinPath, pathsEqual } from "@/core/workspace/paths";
import { useDocumentStore, type OpenItem } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";

/** Path the explorer should reveal for the active editor item, if any. */
export function explorerPathForItem(item: OpenItem | undefined): string | null {
  if (!item) return null;
  if (item.kind === "file") return item.path;
  if (item.kind === "diff" && item.activeFilePath) {
    return joinPath(item.repoRoot, item.activeFilePath);
  }
  if (item.kind === "snapshot-diff" && item.active) {
    return joinPath(item.active.repoRoot, item.active.path);
  }
  return null;
}

/**
 * Set when the user pointer-downs an explorer row so a tree click that opens
 * the already-visible file does not re-reveal and yank the scroll position.
 * A later tab switch / open from elsewhere clears or mismatches this and reveals.
 */
let suppressRevealPath: string | null = null;

export function suppressExplorerRevealFor(path: string | null): void {
  suppressRevealPath = path;
}

/** Keep the explorer in sync with the active editor file (tabs, search, git, …). */
export function useRevealActiveFileInExplorer(): void {
  const activeId = useDocumentStore((s) => s.activeId);
  const openItems = useDocumentStore((s) => s.openItems);
  const item = openItems.find((i) => i.id === activeId);
  const path = explorerPathForItem(item);
  const revealInExplorer = useWorkspaceStore((s) => s.revealInExplorer);

  useEffect(() => {
    if (!path) return;
    if (suppressRevealPath && pathsEqual(suppressRevealPath, path)) {
      suppressRevealPath = null;
      return;
    }
    suppressRevealPath = null;
    void revealInExplorer(path);
  }, [path, revealInExplorer]);
}

/** Scroll the selected explorer row into view after a reveal or selection change. */
export function useScrollSelectedTreeRow(
  scrollRootRef: RefObject<HTMLElement | null>,
): void {
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const revealEpoch = useWorkspaceStore((s) => s.revealEpoch);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root || !selectedPath) return;
    const row = root.querySelector(".file-tree__row.is-selected");
    if (!(row instanceof HTMLElement) || typeof row.scrollIntoView !== "function") return;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedPath, revealEpoch, scrollRootRef]);
}
