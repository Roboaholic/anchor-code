import { Icon } from "@/shared/Icon";
import { useShellStore } from "./shellStore";

export function TopBar() {
  const toggleTerminal = useShellStore((s) => s.toggleTerminal);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const openPalette = useShellStore((s) => s.openPalette);

  return (
    <header className="topbar">
      <div className="topbar__drag" />
      <div className="topbar__left">
        <span className="topbar__brand" aria-label="Anchor Code" title="Anchor Code">
          Anchor Code
        </span>
      </div>

      <div className="topbar__center">
        <button
          type="button"
          className="search-field"
          title="Go to File (Ctrl+P)"
          onClick={() => openPalette("quickOpen")}
        >
          <Icon name="search" className="search-field__icon" />
          <span className="search-field__placeholder">
            Search files in workspace…
          </span>
          <kbd className="search-field__kbd">Ctrl+P</kbd>
        </button>
      </div>

      <div className="topbar__right">
        {versionLabel ? (
          <span className="topbar__version" title="shell.getVersion">
            {versionLabel}
          </span>
        ) : null}
        <button
          type="button"
          className={`btn btn--ghost btn--icon${terminalVisible ? " is-active" : ""}`}
          onClick={toggleTerminal}
          aria-pressed={terminalVisible}
          aria-label="Toggle Terminal"
          title="Toggle Terminal"
        >
          <Icon name="terminal" className="btn__icon" />
        </button>
      </div>
    </header>
  );
}
