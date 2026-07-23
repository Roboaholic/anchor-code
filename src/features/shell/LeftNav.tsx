import { CommentsPane } from "@/features/annotations/CommentsPane";
import { FileTree } from "@/features/files/FileTree";
import { HistoryPane } from "@/features/history/HistoryPane";
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

  return (
    <aside className="left-nav">
      <nav className="left-nav__modes" aria-label="Sidebar mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mode-btn${leftMode === m.id ? " is-active" : ""}`}
            onClick={() => setLeftMode(m.id)}
          >
            <Icon name={m.icon} className="mode-btn__icon" />
            {m.label}
          </button>
        ))}
      </nav>

      <div className="left-nav__body">
        {leftMode === "files" && <FileTree />}
        {leftMode === "comments" && <CommentsPane />}
        {leftMode === "history" && <HistoryPane />}
      </div>

      <footer className="left-nav__footer">
        <span className="branch-pill" title="Placeholder">
          <Icon name="git-branch" />
          main
        </span>
        <span className="git-counts" title="Placeholder">
          +0 ~0
        </span>
      </footer>
    </aside>
  );
}
