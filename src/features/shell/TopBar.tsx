import { Icon } from "@/shared/Icon";
import { useShellStore } from "./shellStore";

export function TopBar() {
  const toggleTerminal = useShellStore((s) => s.toggleTerminal);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const versionLabel = useShellStore((s) => s.versionLabel);

  return (
    <header className="topbar">
      <div className="topbar__drag" />
      <div className="topbar__left">
        <span className="topbar__brand" aria-label="Anchor Code" title="Anchor Code">
          Anchor Code
        </span>
      </div>

      <div className="topbar__center">
        <div className="search-field" title="Placeholder — later slice">
          <Icon name="search" className="search-field__icon" />
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
