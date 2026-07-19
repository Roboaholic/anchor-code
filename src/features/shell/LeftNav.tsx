import { CommentsPane } from "@/features/annotations/CommentsPane";
import { FileTree } from "@/features/files/FileTree";
import { HistoryPane } from "@/features/history/HistoryPane";
import type { LeftMode } from "./shellStore";
import { useShellStore } from "./shellStore";

const MODES: { id: LeftMode; label: string; icon: string }[] = [
  { id: "files", label: "FILES", icon: "▣" },
  { id: "comments", label: "COMMENTS", icon: "💬" },
  { id: "history", label: "HISTORY (GIT)", icon: "⑂" },
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
            <span className="mode-btn__icon" aria-hidden>
              {m.icon}
            </span>
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
          ⑂ main
        </span>
        <span className="git-counts" title="Placeholder">
          +0 ~0
        </span>
      </footer>
    </aside>
  );
}
