import { FileTree } from "@/features/files/FileTree";
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
        {leftMode === "comments" && (
          <EmptyPane
            title="Comments"
            hint="Annotations land in Slice 4. YAML session + highlights."
          />
        )}
        {leftMode === "history" && (
          <EmptyPane
            title="History (Git)"
            hint="Discover repos, log, dual-commit compare — Slice 3."
          />
        )}
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

function EmptyPane({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty-pane">
      <h2 className="empty-pane__title">{title}</h2>
      <p className="empty-pane__hint">{hint}</p>
    </div>
  );
}
