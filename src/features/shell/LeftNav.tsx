import { useEffect } from "react";
import { CommentsPane } from "@/features/annotations/CommentsPane";
import { FileTree } from "@/features/files/FileTree";
import { HistoryPane } from "@/features/history/HistoryPane";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { Icon } from "@/shared/Icon";
import type { CodiconName } from "@/shared/Icon";
import type { LeftMode } from "./shellStore";
import { useShellStore } from "./shellStore";

const MODES: { id: LeftMode; label: string; icon: CodiconName }[] = [
  { id: "files", label: "FILES", icon: "files" },
  { id: "comments", label: "COMMENTS", icon: "comment-discussion" },
  { id: "history", label: "HISTORY", icon: "history" },
];

export function LeftNav() {
  const leftMode = useShellStore((s) => s.leftMode);
  const setLeftMode = useShellStore((s) => s.setLeftMode);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const hasWorkspace = Boolean(workspaceRoot);

  // Comments / History need a workspace; snap back to Files when closed.
  useEffect(() => {
    if (!hasWorkspace && leftMode !== "files") {
      setLeftMode("files");
    }
  }, [hasWorkspace, leftMode, setLeftMode]);

  return (
    <aside className="left-nav">
      <nav className="left-nav__modes" aria-label="Sidebar mode">
        {MODES.map((m) => {
          const needsWorkspace = m.id === "comments" || m.id === "history";
          const disabled = needsWorkspace && !hasWorkspace;
          return (
            <button
              key={m.id}
              type="button"
              className={`mode-btn${leftMode === m.id ? " is-active" : ""}${
                disabled ? " is-disabled" : ""
              }`}
              disabled={disabled}
              title={
                disabled ? "Open a workspace first" : undefined
              }
              onClick={() => {
                if (disabled) return;
                setLeftMode(m.id);
              }}
            >
              <Icon name={m.icon} className="mode-btn__icon" />
              {m.label}
            </button>
          );
        })}
      </nav>

      <div className="left-nav__body">
        {leftMode === "files" && <FileTree />}
        {leftMode === "comments" && hasWorkspace ? <CommentsPane /> : null}
        {leftMode === "history" && hasWorkspace ? <HistoryPane /> : null}
      </div>
    </aside>
  );
}
