import type { CSSProperties } from "react";
import { openWorkspaceFromPicker } from "./orchestrate";
import { useShellStore } from "./shellStore";

export function TopBar() {
  const toggleTerminal = useShellStore((s) => s.toggleTerminal);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const versionLabel = useShellStore((s) => s.versionLabel);

  return (
    <header className="topbar">
      <div className="topbar__drag" />
      <div className="topbar__left">
        <button
          type="button"
          className="btn btn--ghost"
          title="Open a folder as workspace (⌘O)"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void openWorkspaceFromPicker();
          }}
        >
          <span className="btn__icon" aria-hidden>
            ▦
          </span>
          Open Workspace
        </button>
      </div>

      <div className="topbar__center">
        <div className="search-field" title="Placeholder — later slice">
          <span className="search-field__icon" aria-hidden>
            ⌕
          </span>
          <span className="search-field__placeholder">
            Search files, symbols, or commands…
          </span>
          <kbd className="search-field__kbd">⌘K</kbd>
        </div>
      </div>

      <div className="topbar__right">
        {versionLabel ? (
          <span className="topbar__version" title="shell.getVersion">
            {versionLabel}
          </span>
        ) : null}
        <button
          type="button"
          className={`btn btn--ghost${terminalVisible ? " is-active" : ""}`}
          onClick={toggleTerminal}
          aria-pressed={terminalVisible}
        >
          <span className="btn__icon" aria-hidden>
            ▤
          </span>
          Toggle Terminal
        </button>
        <div className="avatar" title="Account placeholder" aria-hidden>
          A
        </div>
      </div>
    </header>
  );
}
