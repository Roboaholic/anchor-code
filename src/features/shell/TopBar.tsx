import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/Icon";
import type { AppUpdateState } from "@/shared/anchor-api";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { AppMenuBar } from "./AppMenuBar";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";

function updateBadgeMeta(state: AppUpdateState | null): {
  show: boolean;
  title: string;
  label: string;
} {
  if (!state) return { show: false, title: "", label: "" };
  if (state.status === "available") {
    return {
      show: true,
      title: state.latestVersion
        ? `Update available: v${state.latestVersion}`
        : "Update available",
      label: state.latestVersion ? `v${state.latestVersion}` : "Update",
    };
  }
  if (state.status === "downloaded") {
    return {
      show: true,
      title: state.latestVersion
        ? `Update ready: v${state.latestVersion} — restart to install`
        : "Update ready — restart to install",
      label: "Restart",
    };
  }
  if (state.status === "downloading") {
    return {
      show: true,
      title:
        state.progress != null
          ? `Downloading update… ${state.progress}%`
          : "Downloading update…",
      label: state.progress != null ? `${state.progress}%` : "…",
    };
  }
  return { show: false, title: "", label: "" };
}

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
  const openSettings = useThemeStore((s) => s.openSettings);
  const rightRailRef = useRef<HTMLDivElement>(null);
  const [rightRailTip, setRightRailTip] = useState(false);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.anchor?.updates?.getState?.().then((s) => {
      if (!cancelled) setUpdateState(s);
    });
    const off = window.anchor?.updates?.onState?.((s) => {
      setUpdateState(s);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

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
            <div className="topbar__version-wrap">
              <span className="topbar__version" title="shell.getVersion">
                {versionLabel}
              </span>
              {(() => {
                const badge = updateBadgeMeta(updateState);
                if (!badge.show) return null;
                return (
                  <button
                    type="button"
                    className={`topbar__update-badge${
                      updateState?.status === "downloaded"
                        ? " is-ready"
                        : updateState?.status === "downloading"
                          ? " is-busy"
                          : ""
                    }`}
                    title={badge.title}
                    aria-label={badge.title}
                    onClick={() => openSettings("updates")}
                  >
                    <Icon
                      name="refresh"
                      className="topbar__update-badge-icon"
                    />
                    <span className="topbar__update-badge-label">
                      {badge.label}
                    </span>
                  </button>
                );
              })()}
            </div>
          ) : null}

          {/* Settings / Agent / Terminal — one rail, equal spacing, mode-btn highlight */}
          <div className="topbar__right-rail" ref={rightRailRef}>
            <button
              type="button"
              className={`topbar__rail-btn${settingsOpen ? " is-active" : ""}`}
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-pressed={settingsOpen}
              aria-label="Settings"
              title="Settings"
            >
              <Icon name="settings-gear" className="topbar__rail-btn-icon" />
            </button>

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
