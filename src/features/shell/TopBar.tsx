import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceDisplayName } from "@/core/workspace/paths";
import { Icon } from "@/shared/Icon";
import type { AppUpdateState, HostKind } from "@/shared/anchor-api";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { AppMenuBar } from "./AppMenuBar";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";

function updateBadgeMeta(state: AppUpdateState | null): {
  show: boolean;
  title: string;
  label: string;
  icon: string;
} {
  if (!state) return { show: false, title: "", label: "", icon: "cloud-download" };
  if (state.status === "available") {
    return {
      show: true,
      title: state.latestVersion
        ? `Update available: v${state.latestVersion}`
        : "Update available",
      label: state.latestVersion ? `v${state.latestVersion}` : "Update",
      icon: "cloud-download",
    };
  }
  if (state.status === "downloaded") {
    return {
      show: true,
      title: state.latestVersion
        ? `Update ready: v${state.latestVersion} — restart to install`
        : "Update ready — restart to install",
      label: "Restart",
      icon: "debug-restart",
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
      icon: "loading",
    };
  }
  return { show: false, title: "", label: "", icon: "cloud-download" };
}

function workspaceKey(path: string | null, hostProfileId: string | null): string {
  return `${hostProfileId ?? "local-default"}::${(path ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()}`;
}

function hostLabel(kind: HostKind | null, hostProfileId: string | null): string {
  if (kind === "local" || hostProfileId === "local-default") return "Local";
  if (kind === "wsl" || hostProfileId === "wsl-default") return "WSL";
  if (kind === "ssh") return "SSH";
  if (!hostProfileId) return "Host";
  if (hostProfileId.startsWith("ssh-")) return "SSH";
  if (hostProfileId.startsWith("wsl-")) return "WSL";
  return hostProfileId;
}
export function TopBar() {
  const agentVisible = useShellStore((s) => s.agentVisible);
  const agentMenuOpen = useTerminalStore((s) => s.agentMenuOpen);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const openPalette = useShellStore((s) => s.openPalette);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const hostKind = useWorkspaceStore((s) => s.hostKind);
  const hostProfileId = useWorkspaceStore((s) => s.hostProfileId);
  const recent = useWorkspaceStore((s) => s.recent);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);
  const settingsOpen = useThemeStore((s) => s.settingsOpen);
  const setSettingsOpen = useThemeStore((s) => s.setSettingsOpen);
  const openSettings = useThemeStore((s) => s.openSettings);
  const rightRailRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [rightRailTip, setRightRailTip] = useState(false);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);

  const activeWorkspaceKey = workspaceKey(workspaceRoot, hostProfileId);
  const activeWorkspaceName = workspaceRoot
    ? workspaceName || workspaceDisplayName(workspaceRoot)
    : "Open Workspace";
  const activeHostLabel = workspaceRoot
    ? hostLabel(hostKind, hostProfileId)
    : "";
  const recentWorkspaces = useMemo(
    () =>
      recent.slice(0, 7).map((item) => {
        const key = workspaceKey(item.path, item.hostProfileId);
        return {
          ...item,
          key,
          name: workspaceDisplayName(item.path),
          hostLabel: hostLabel(null, item.hostProfileId),
          isActive: key === activeWorkspaceKey,
        };
      }),
    [activeWorkspaceKey, recent],
  );

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
    void loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (
        workspaceMenuRef.current &&
        !workspaceMenuRef.current.contains(event.target as Node)
      ) {
        setWorkspaceMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [workspaceMenuOpen]);

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
  const toggleAgentPanel = async () => {
    if (!workspaceRoot) {
      showRightRailTip();
      return;
    }
    setRightRailTip(false);

    let tabs = useTerminalStore.getState().tabs;
    if (tabs.length === 0) {
      const restored = (await window.anchor.terminal.list()).filter(
        (tab) =>
          tab.cwd.replace(/\\/g, "/").replace(/\/+$/, "") ===
          workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, ""),
      );
      if (restored.length > 0) {
        useTerminalStore.setState({ tabs: restored });
        tabs = restored;
      }
    }
    const hasAgent = tabs.some((tab) => (tab.kind ?? "shell") === "agent");
    const { agentVisible } = useShellStore.getState();

    if (!hasAgent) {
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

  const openWorkspaceDialog = () => {
    setWorkspaceMenuOpen(false);
    setOpenWorkspaceDialog(true);
  };

  const openRecentWorkspace = async (path: string, profileId: string) => {
    setWorkspaceMenuOpen(false);
    if (workspaceKey(path, profileId) === activeWorkspaceKey) return;
    const { openWorkspacePath } = await import("./orchestrate");
    await openWorkspacePath(path, profileId);
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
          <div className="topbar__workspace" ref={workspaceMenuRef}>
            <button
              type="button"
              className={`workspace-switcher${
                workspaceRoot ? "" : " is-empty"
              }${workspaceMenuOpen ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={workspaceMenuOpen}
              aria-label={
                workspaceRoot
                  ? `Current workspace: ${activeWorkspaceName}`
                  : "Open workspace"
              }
              title={
                workspaceRoot
                  ? `${workspaceRoot} (${activeHostLabel})`
                  : "Open Workspace"
              }
              onClick={() => setWorkspaceMenuOpen((open) => !open)}
            >
              <Icon
                name={workspaceRoot ? "folder" : "folder-opened"}
                className="workspace-switcher__icon"
              />
              <span className="workspace-switcher__name">
                {activeWorkspaceName}
              </span>
              {activeHostLabel ? (
                <span className="workspace-switcher__host">
                  {activeHostLabel}
                </span>
              ) : null}
              <Icon
                name="chevron-down"
                className="workspace-switcher__chevron"
              />
            </button>

            {workspaceMenuOpen ? (
              <div
                className="workspace-menu"
                role="menu"
                aria-label="Workspaces"
              >
                {workspaceRoot ? (
                  <div className="workspace-menu__section">
                    <div className="workspace-menu__heading">
                      Current Workspace
                    </div>
                    <div className="workspace-menu__current">
                      <Icon
                        name="folder-opened"
                        className="workspace-menu__item-icon"
                      />
                      <span className="workspace-menu__item-copy">
                        <span className="workspace-menu__item-name">
                          {activeWorkspaceName}
                        </span>
                        <span
                          className="workspace-menu__item-path"
                          title={workspaceRoot}
                        >
                          {workspaceRoot}
                        </span>
                      </span>
                      <span className="workspace-menu__item-host">
                        {activeHostLabel}
                      </span>
                    </div>
                  </div>
                ) : null}

                {recentWorkspaces.length > 0 ? (
                  <div className="workspace-menu__section">
                    <div className="workspace-menu__heading">Recent</div>
                    <div className="workspace-menu__list">
                      {recentWorkspaces.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          role="menuitem"
                          className={`workspace-menu__item${
                            item.isActive ? " is-active" : ""
                          }`}
                          title={`${item.path} (${item.hostLabel})`}
                          onClick={() =>
                            void openRecentWorkspace(
                              item.path,
                              item.hostProfileId,
                            )
                          }
                        >
                          <Icon
                            name={item.isActive ? "folder-opened" : "folder"}
                            className="workspace-menu__item-icon"
                          />
                          <span className="workspace-menu__item-copy">
                            <span className="workspace-menu__item-name">
                              {item.name}
                            </span>
                            <span className="workspace-menu__item-path">
                              {item.path}
                            </span>
                          </span>
                          <span className="workspace-menu__item-host">
                            {item.isActive ? "Current" : item.hostLabel}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="workspace-menu__footer">
                  <button
                    type="button"
                    role="menuitem"
                    className="workspace-menu__open"
                    onClick={openWorkspaceDialog}
                  >
                    <Icon name="add" className="workspace-menu__open-icon" />
                    Open Workspace
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>


        <div className="topbar__right">
          <button
            type="button"
            className="search-field"
            title="Go to File (Ctrl+P)"
            onClick={() => openPalette("quickOpen")}
          >
            <Icon name="search" className="search-field__icon" />
            <span className="search-field__placeholder">Search files…</span>
            <kbd className="search-field__kbd">Ctrl+P</kbd>
          </button>
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
                      updateState?.status === "available" ? " is-available" : ""
                    }${updateState?.status === "downloaded" ? " is-ready" : ""}${
                      updateState?.status === "downloading" ? " is-busy" : ""
                    }`}
                    title={badge.title}
                    aria-label={badge.title}
                    onClick={() => openSettings("updates")}
                  >
                    <Icon
                      name={badge.icon}
                      className="topbar__update-badge-icon"
                    />
                    {updateState?.status !== "available" ? (
                      <span className="topbar__update-badge-label">
                        {badge.label}
                      </span>
                    ) : null}
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
