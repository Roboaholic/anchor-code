import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/Icon";
import type { UiTheme } from "@/shared/anchor-api";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { AppMenuBar } from "./AppMenuBar";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";

const THEME_OPTIONS: Array<{
  id: UiTheme;
  label: string;
  description: string;
}> = [
  {
    id: "light",
    label: "Light",
    description: "Warm paper panels for daytime reading.",
  },
  {
    id: "light-modern",
    label: "Light Modern",
    description: "VS Code Light Modern workbench and blue accents.",
  },
  {
    id: "dark",
    label: "Dark",
    description: "Neutral charcoal shell with warm sand accents.",
  },
  {
    id: "dark-modern",
    label: "Dark Modern",
    description: "VS Code Dark Modern workbench and blue accents.",
  },
];

export function TopBar() {
  const agentVisible = useShellStore((s) => s.agentVisible);
  const agentMenuOpen = useTerminalStore((s) => s.agentMenuOpen);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const openPalette = useShellStore((s) => s.openPalette);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const settingsOpen = useThemeStore((s) => s.settingsOpen);
  const setSettingsOpen = useThemeStore((s) => s.setSettingsOpen);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const menuRef = useRef<HTMLDivElement>(null);
  const rightRailRef = useRef<HTMLDivElement>(null);
  const [rightRailTip, setRightRailTip] = useState(false);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
      }
    };
    const onPointer = (e: MouseEvent) => {
      const el = menuRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [settingsOpen, setSettingsOpen]);

  useEffect(() => {
    return () => {
      clearTimeout(tipTimerRef.current ?? undefined);
    };
  }, []);

  // Hide tip once a workspace is open.
  useEffect(() => {
    if (workspaceRoot) setRightRailTip(false);
  }, [workspaceRoot]);

  const showRightRailTip = () => {
    setRightRailTip(true);
    clearTimeout(tipTimerRef.current ?? undefined);
    tipTimerRef.current = setTimeout(() => setRightRailTip(false), 3200);
  };

  /**
   * Agent button:
   * - No sessions yet → open create dialog only (side rail stays closed until confirm).
   * - Has sessions → toggle the side rail.
   */
  const toggleAgentPanel = () => {
    if (!workspaceRoot) {
      showRightRailTip();
      return;
    }
    setRightRailTip(false);

    const tabs = useTerminalStore.getState().tabs;
    const hasAgent = tabs.some((t) => (t.kind ?? "shell") === "agent");
    const { agentVisible } = useShellStore.getState();

    if (!hasAgent) {
      // Dialog only — rail opens after the user confirms a new session.
      if (useTerminalStore.getState().agentMenuOpen) {
        useTerminalStore.getState().closeAgentMenu();
      } else {
        void useTerminalStore.getState().loadAgentProfiles();
        useTerminalStore.getState().setAgentMenuOpen(true);
      }
      return;
    }

    useShellStore.setState({ agentVisible: !agentVisible });
  };

  const toggleTerminalPanel = () => {
    if (!workspaceRoot) {
      showRightRailTip();
      return;
    }
    setRightRailTip(false);
    useShellStore.setState((s) => ({ terminalVisible: !s.terminalVisible }));
  };

  return (
    <header className="chrome">
      {/* Row 1: app menus (fused, not OS title strip) */}
      <AppMenuBar />

      {/* Row 2: tool strip — brand, search, sidebars, settings */}
      <div className="topbar">
        <div className="topbar__left">
          <span
            className="topbar__brand"
            aria-label="Anchor Code"
            title="Anchor Code"
          >
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

          {/* Settings / Agent / Terminal — one rail, equal spacing, mode-btn highlight */}
          <div className="topbar__right-rail" ref={rightRailRef}>
            <div className="topbar__menu" ref={menuRef}>
              <button
                type="button"
                className={`topbar__rail-btn${settingsOpen ? " is-active" : ""}`}
                onClick={() => setSettingsOpen(!settingsOpen)}
                aria-expanded={settingsOpen}
                aria-haspopup="dialog"
                aria-controls="topbar-settings-panel"
                aria-label="Settings"
                title="Settings"
              >
                <Icon name="settings-gear" className="topbar__rail-btn-icon" />
              </button>
              {settingsOpen ? (
                <div
                  id="topbar-settings-panel"
                  className="topbar-settings"
                  role="dialog"
                  aria-label="Settings"
                >
                  <div className="topbar-settings__head">
                    <span className="topbar-settings__title">Appearance</span>
                  </div>
                  <div
                    className="topbar-settings__themes"
                    role="radiogroup"
                    aria-label="Theme"
                  >
                    {THEME_OPTIONS.map((opt) => {
                      const active = theme === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`topbar-settings__card${active ? " is-active" : ""}`}
                          onClick={() => void setTheme(opt.id)}
                        >
                          <span
                            className={`topbar-settings__swatch topbar-settings__swatch--${opt.id}`}
                            aria-hidden
                          />
                          <span className="topbar-settings__meta">
                            <span className="topbar-settings__label">
                              {opt.label}
                            </span>
                            <span className="topbar-settings__hint">
                              {opt.description}
                            </span>
                          </span>
                          {active ? (
                            <span className="topbar-settings__check" aria-hidden>
                              ✓
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className={`topbar__rail-btn${(agentVisible || agentMenuOpen) && workspaceRoot ? " is-active" : ""}`}
              onClick={toggleAgentPanel}
              aria-pressed={Boolean(workspaceRoot && (agentVisible || agentMenuOpen))}
              aria-label="Toggle agent panel"
              title={
                workspaceRoot ? "Toggle agent panel" : "Open a workspace first"
              }
            >
              <Icon name="robot" className="topbar__rail-btn-icon" />
            </button>
            <button
              type="button"
              className={`topbar__rail-btn${terminalVisible && workspaceRoot ? " is-active" : ""}`}
              onClick={toggleTerminalPanel}
              aria-pressed={Boolean(workspaceRoot && terminalVisible)}
              aria-label="Toggle terminal panel"
              title={
                workspaceRoot
                  ? "Toggle terminal panel"
                  : "Open a workspace first"
              }
            >
              <Icon name="terminal" className="topbar__rail-btn-icon" />
            </button>
            {rightRailTip && !workspaceRoot ? (
              <div className="topbar-tip" role="status" aria-live="polite">
                <p className="topbar-tip__text">
                  Open a workspace first to use agent and terminal panels.
                </p>
                <button
                  type="button"
                  className="btn btn--accent btn--small topbar-tip__action"
                  onClick={() => {
                    setRightRailTip(false);
                    setOpenWorkspaceDialog(true);
                  }}
                >
                  Open Workspace
                </button>
                <span className="topbar-tip__arrow" aria-hidden />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
