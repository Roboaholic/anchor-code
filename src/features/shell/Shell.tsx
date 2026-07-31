import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { DocumentArea } from "@/features/document/DocumentArea";
import { OpenWorkspaceDialog } from "@/features/workspace/OpenWorkspaceDialog";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { Icon } from "@/shared/Icon";
import { LeftNav } from "./LeftNav";
import {
  QuickOpenPalette,
  invalidateFileIndexCache,
  warmFileIndexCache,
} from "./QuickOpen";
import { NewAgentDialogHost } from "@/features/terminal/NewAgentDialogHost";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { TerminalPanel } from "./TerminalPanel";
import { SettingsPanel } from "./SettingsPanel";
import { TopBar } from "./TopBar";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";
import { openWorkspaceWithHost } from "./orchestrate";

/**
 * Drive collapsible panel open/closed without remounting siblings.
 * Retries a few frames so expand isn't lost on first paint.
 */
function useCollapsiblePanel(
  ref: RefObject<ImperativePanelHandle | null>,
  expanded: boolean,
  expandSize: number,
) {
  useEffect(() => {
    let cancelled = false;
    let tries = 0;

    const apply = () => {
      if (cancelled) return;
      const p = ref.current;
      if (!p) {
        if (tries++ < 20) requestAnimationFrame(apply);
        return;
      }
      try {
        if (expanded) {
          if (p.isCollapsed()) p.expand(expandSize);
          // Stuck at ~0 while "open" (bad autoSave / race) → force size.
          if (p.getSize() < Math.min(8, expandSize * 0.3)) {
            p.resize(expandSize);
          }
        } else if (!p.isCollapsed()) {
          p.collapse();
        }
      } catch {
        if (tries++ < 20) requestAnimationFrame(apply);
      }
    };

    apply();
    const t = window.setTimeout(apply, 40);
    const t2 = window.setTimeout(apply, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.clearTimeout(t2);
    };
  }, [ref, expanded, expandSize]);
}

export function Shell() {
  const leftVisible = useShellStore((s) => s.leftVisible);
  const agentVisible = useShellStore((s) => s.agentVisible);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const setVersionLabel = useShellStore((s) => s.setVersionLabel);
  const openWorkspaceDialog = useShellStore((s) => s.openWorkspaceDialog);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const skillInstallPromptRoot = useShellStore((s) => s.skillInstallPromptRoot);
  const dismissSkillInstallPrompt = useShellStore(
    (s) => s.dismissSkillInstallPrompt,
  );
  const [skillInstallBusy, setSkillInstallBusy] = useState(false);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalOverlayTop, setTerminalOverlayTop] = useState(0);
  const [agentMaximized, setAgentMaximized] = useState(false);
  const [agentOverlayLeft, setAgentOverlayLeft] = useState(0);
  const [skillInstallError, setSkillInstallError] = useState<string | null>(
    null,
  );
  const openPalette = useShellStore((s) => s.openPalette);
  const closePalette = useShellStore((s) => s.closePalette);
  const palette = useShellStore((s) => s.palette);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);
  const hydrateTheme = useThemeStore((s) => s.hydrate);

  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const agentPanelRef = useRef<ImperativePanelHandle>(null);
  const terminalPanelRef = useRef<ImperativePanelHandle>(null);
  const terminalDragCleanupRef = useRef<(() => void) | null>(null);
  const agentDragCleanupRef = useRef<(() => void) | null>(null);
  const terminalRestoreSizeRef = useRef(28);
  const agentRestoreSizeRef = useRef(28);

  const restoreTerminal = (size = terminalRestoreSizeRef.current) => {
    terminalPanelRef.current?.resize(size);
    setTerminalOverlayTop(0);
    setTerminalMaximized(false);
  };

  const enterTerminalMaximized = () => {
    setAgentMaximized(false);
    terminalRestoreSizeRef.current = terminalPanelRef.current?.getSize() ?? 28;
    setTerminalOverlayTop(0);
    setTerminalMaximized(true);
  };

  const beginTerminalLimitDrag = (
    event: PointerEvent,
    fromMaximized: boolean,
  ) => {
    if (event.button !== 0) return;
    terminalDragCleanupRef.current?.();
    const startY = event.clientY;
    let limitY: number | null =
      !fromMaximized && (terminalPanelRef.current?.getSize() ?? 0) >= 74.5
        ? startY
        : null;
    const center = (event.target as Element | null)?.closest(
      ".shell__center-stack",
    );
    const centerRect = center?.getBoundingClientRect() ?? null;
    let restoreSize: number | null = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      terminalDragCleanupRef.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (fromMaximized && centerRect) {
        const nextY = Math.max(
          centerRect.top,
          Math.min(moveEvent.clientY, centerRect.bottom - centerRect.height * 0.12),
        );
        const topRatio = ((nextY - centerRect.top) / centerRect.height) * 100;
        setTerminalOverlayTop(nextY - centerRect.top);
        restoreSize = topRatio >= 25 ? Math.max(12, 100 - topRatio) : null;
        return;
      }

      const panelAtLimit = (terminalPanelRef.current?.getSize() ?? 0) >= 74.5;
      if (!panelAtLimit) {
        limitY = null;
        return;
      }
      if (limitY == null) limitY = moveEvent.clientY;
      if (limitY - moveEvent.clientY < 32) return;
      cleanup();
      enterTerminalMaximized();
    };
    const onEnd = () => {
      cleanup();
      if (!fromMaximized) return;
      if (restoreSize == null) setTerminalOverlayTop(0);
      else restoreTerminal(restoreSize);
    };

    terminalDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
  };

  const enterAgentMaximized = () => {
    setTerminalMaximized(false);
    agentRestoreSizeRef.current = agentPanelRef.current?.getSize() ?? 28;
    setAgentOverlayLeft(leftVisible ? (leftPanelRef.current?.getSize() ?? 0) : 0);
    setAgentMaximized(true);
  };

  const restoreAgent = (size = agentRestoreSizeRef.current) => {
    agentPanelRef.current?.resize(size);
    setAgentMaximized(false);
  };

  const beginAgentLimitDrag = (event: PointerEvent, fromMaximized: boolean) => {
    if (event.button !== 0) return;
    agentDragCleanupRef.current?.();
    const startX = event.clientX;
    let limitX: number | null =
      !fromMaximized && (agentPanelRef.current?.getSize() ?? 0) >= 49.5
        ? startX
        : null;
    const group = (event.target as Element | null)?.closest(".shell__panels--main");
    const groupRect = group?.getBoundingClientRect() ?? null;
    const fullLeft = agentOverlayLeft;
    let restoreSize: number | null = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      agentDragCleanupRef.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (fromMaximized && groupRect) {
        const minimumLeft = groupRect.left + groupRect.width * (fullLeft / 100);
        const nextX = Math.max(
          minimumLeft,
          Math.min(moveEvent.clientX, groupRect.right - groupRect.width * 0.18),
        );
        const leftRatio = ((nextX - groupRect.left) / groupRect.width) * 100;
        setAgentOverlayLeft(leftRatio);
        restoreSize = leftRatio >= 50 ? Math.max(18, 100 - leftRatio) : null;
        return;
      }

      const panelAtLimit = (agentPanelRef.current?.getSize() ?? 0) >= 49.5;
      if (!panelAtLimit) {
        limitX = null;
        return;
      }
      if (limitX == null) limitX = moveEvent.clientX;
      if (limitX - moveEvent.clientX < 32) return;
      cleanup();
      enterAgentMaximized();
    };
    const onEnd = () => {
      cleanup();
      if (!fromMaximized) return;
      if (restoreSize == null) setAgentOverlayLeft(fullLeft);
      else restoreAgent(restoreSize);
    };

    agentDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
  };
  useEffect(() => {
    if (terminalMaximized) return;
    const onPointerDown = (event: PointerEvent) => {
      const handle = document.querySelector<HTMLElement>(".resize-handle--row");
      const rect = handle?.getBoundingClientRect();
      if (!rect || Math.abs(event.clientY - rect.top) > 8) return;
      beginTerminalLimitDrag(event, false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [terminalMaximized]);

  useEffect(() => {
    if (agentMaximized) return;
    const onPointerDown = (event: PointerEvent) => {
      const handle = document.querySelector<HTMLElement>(".resize-handle--agent");
      const rect = handle?.getBoundingClientRect();
      if (!rect || Math.abs(event.clientX - rect.left) > 8) return;
      beginAgentLimitDrag(event, false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [agentMaximized, leftVisible]);


  useEffect(
    () => () => {
      terminalDragCleanupRef.current?.();
      agentDragCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    void hydrateTheme();
  }, [hydrateTheme]);

  useEffect(() => {
    let cancelled = false;
    async function loadVersion() {
      try {
        if (!window.anchor?.shell?.getVersion) {
          setVersionLabel("no IPC bridge");
          console.error(
            "[shell] window.anchor is missing. Preload did not inject the bridge. Restart via `npm run dev` (Electron window, not a browser tab on :5173).",
          );
          return;
        }
        const info = await window.anchor.shell.getVersion();
        if (!cancelled) {
          setVersionLabel(`v${info.app} · ${info.hostKind}`);
        }
      } catch (err) {
        if (!cancelled) {
          setVersionLabel("ipc error");
          console.error("[shell] getVersion failed:", err);
        }
      }
    }
    void loadVersion();
    void loadRecent();

    const off =
      window.anchor?.shell?.onCommand?.((cmd) => {
        if (cmd.type === "openWorkspace") {
          void import("./orchestrate").then((m) => m.openWorkspaceFromPicker());
        } else if (cmd.type === "quickOpen") {
          openPalette("quickOpen");
        } else if (cmd.type === "openFilePath") {
          openPalette("openPath");
        }
      }) ?? (() => undefined);

    const onLocalMenu = (e: Event) => {
      const detail = (e as CustomEvent<{ type?: string }>).detail;
      const type = detail?.type;
      if (type === "openWorkspace") {
        void import("./orchestrate").then((m) => m.openWorkspaceFromPicker());
      } else if (type === "quickOpen") {
        openPalette("quickOpen");
      } else if (type === "openFilePath") {
        openPalette("openPath");
      }
    };
    window.addEventListener("anchor:shell-command", onLocalMenu);

    return () => {
      cancelled = true;
      off();
      window.removeEventListener("anchor:shell-command", onLocalMenu);
    };
  }, [setVersionLabel, loadRecent, openPalette]);

  // Renderer fallback shortcuts (menu accelerators also send shell:command).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        openPalette("quickOpen");
        return;
      }
      if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        openPalette("openPath");
        return;
      }
      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        openPalette("quickOpen");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPalette]);

  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const setAgentVisible = useShellStore((s) => s.setAgentVisible);
  const setTerminalVisible = useShellStore((s) => s.setTerminalVisible);
  useEffect(() => {
    invalidateFileIndexCache();
    // Start multi-repo indexing before the user hits Ctrl+P.
    warmFileIndexCache(workspaceRoot);
  }, [workspaceRoot]);

  // Agent / terminal only when a workspace is open.
  useEffect(() => {
    if (!workspaceRoot) {
      setAgentVisible(false);
      setTerminalVisible(false);
      useTerminalStore.getState().closeAgentMenu();
    }
  }, [workspaceRoot, setAgentVisible, setTerminalVisible]);

  // Last agent session closed/exited → collapse side rail.
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      const nextCount = state.tabs.filter(
        (t) => (t.kind ?? "shell") === "agent",
      ).length;
      const prevCount = prev.tabs.filter(
        (t) => (t.kind ?? "shell") === "agent",
      ).length;
      if (prevCount > 0 && nextCount === 0) {
        useShellStore.getState().setAgentVisible(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!palette) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [palette, closePalette]);

  const showAgent = Boolean(agentVisible && workspaceRoot);
  const showTerminal = Boolean(terminalVisible && workspaceRoot);

  useEffect(() => {
    if (!showTerminal && terminalMaximized) setTerminalMaximized(false);
  }, [showTerminal, terminalMaximized]);

  useEffect(() => {
    if (!showAgent && agentMaximized) setAgentMaximized(false);
  }, [showAgent, agentMaximized]);

  useEffect(() => {
    if (!terminalMaximized && !agentMaximized) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreTerminal();
      restoreAgent();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [terminalMaximized, agentMaximized]);

  // Never remount PanelGroup for these toggles — only collapse/expand.
  useCollapsiblePanel(leftPanelRef, leftVisible, 22);
  useCollapsiblePanel(agentPanelRef, showAgent, 28);
  useCollapsiblePanel(terminalPanelRef, showTerminal, 28);

  return (
    <div className="shell">
      <TopBar />
      {skillInstallPromptRoot &&
      workspaceRoot &&
      skillInstallPromptRoot === workspaceRoot ? (
        <div className="skill-install-toast" role="status" aria-live="polite">
          <div className="skill-install-toast__card">
            <div className="skill-install-toast__icon" aria-hidden>
              <Icon name="robot" />
            </div>
            <div className="skill-install-toast__body">
              <div className="skill-install-toast__title-row">
                <strong className="skill-install-toast__title">
                  Install Anchor Review skill?
                </strong>
                <button
                  type="button"
                  className="icon-btn skill-install-toast__dismiss"
                  aria-label="Dismiss"
                  disabled={skillInstallBusy}
                  onClick={() => {
                    setSkillInstallError(null);
                    dismissSkillInstallPrompt();
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
              <p className="skill-install-toast__desc">
                Teach agent CLIs how to read{" "}
                <code>.anchor-code</code> comments, implement{" "}
                <code>need_modify</code>, then mark them{" "}
                <code>closed</code>.
              </p>
              <p className="skill-install-toast__path muted">
                Installs to{" "}
                <code>.agents/skills/anchor-review/</code>
              </p>
              {skillInstallError ? (
                <p className="skill-install-toast__err" role="alert">
                  {skillInstallError}
                </p>
              ) : null}
              <div className="skill-install-toast__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={skillInstallBusy}
                  onClick={() => {
                    setSkillInstallError(null);
                    dismissSkillInstallPrompt();
                  }}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="btn btn--accent btn--small"
                  disabled={skillInstallBusy}
                  onClick={() => {
                    void (async () => {
                      setSkillInstallBusy(true);
                      setSkillInstallError(null);
                      try {
                        const r =
                          await window.anchor.skill.installWorkspace(
                            workspaceRoot,
                          );
                        if (!r.ok) {
                          setSkillInstallError(r.error ?? "Install failed");
                          return;
                        }
                        dismissSkillInstallPrompt();
                      } catch (err) {
                        setSkillInstallError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setSkillInstallBusy(false);
                      }
                    })();
                  }}
                >
                  {skillInstallBusy ? "Installing…" : "Install"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="shell__body">
        {/*
          Stable PanelGroup (no remount keys). Toggling left / agent / terminal
          only collapses panels so xterm React trees stay mounted — no reload flash.
        */}
        <PanelGroup
          direction="horizontal"
          autoSaveId="anchor-shell-v7"
          className="shell__panels shell__panels--main"
        >
          <Panel
            ref={leftPanelRef}
            order={1}
            collapsible
            collapsedSize={0}
            defaultSize={leftVisible ? 22 : 0}
            minSize={14}
            maxSize={36}
            onCollapse={() => useShellStore.getState().setLeftVisible(false)}
            id="left"
          >
            <LeftNav />
          </Panel>
          <PanelResizeHandle
            className="resize-handle"
            style={{ display: leftVisible ? undefined : "none" }}
          />

          <Panel order={2} defaultSize={50} minSize={30} id="center">
            <div className="shell__center-stack">
              <PanelGroup
                direction="vertical"
                autoSaveId="anchor-shell-center-v7"
                className="shell__panels shell__panels--col"
              >
                <Panel order={1} defaultSize={72} minSize={25} id="document">
                  <DocumentArea />
                </Panel>

                <PanelResizeHandle
                  className="resize-handle resize-handle--row"
                  style={{
                    display:
                      showTerminal && !terminalMaximized ? undefined : "none",
                  }}
                />
                <Panel
                  ref={terminalPanelRef}
                  className={`shell__terminal-panel${terminalMaximized ? " is-maximized" : ""}`}
                  style={terminalMaximized ? { top: terminalOverlayTop } : undefined}
                  order={2}
                  collapsible
                  collapsedSize={0}
                  defaultSize={showTerminal ? 28 : 0}
                  minSize={12}
                  maxSize={75}
                  id="terminal-bottom"
                >
                  {terminalMaximized ? (
                    <div
                      className="terminal-maximized-drag-handle"
                      aria-label="Drag down to restore terminal"
                      onPointerDown={(event) =>
                        beginTerminalLimitDrag(event.nativeEvent, true)
                      }
                    />
                  ) : null}
                  {workspaceRoot ? (
                    <TerminalPanel
                      mode="terminal"
                      maximized={terminalMaximized}
                      onToggleMaximized={() => {
                        if (terminalMaximized) restoreTerminal();
                        else enterTerminalMaximized();
                      }}
                    />
                  ) : null}
                </Panel>
              </PanelGroup>
            </div>
          </Panel>

          <PanelResizeHandle
            className="resize-handle resize-handle--agent"
            style={{ display: showAgent && !agentMaximized ? undefined : "none" }}
          />
          <Panel
            ref={agentPanelRef}
            className={`shell__agent-panel${agentMaximized ? " is-maximized" : ""}`}
            style={agentMaximized ? { left: `${agentOverlayLeft}%` } : undefined}
            order={3}
            collapsible
            collapsedSize={0}
            defaultSize={showAgent ? 28 : 0}
            minSize={18}
            maxSize={50}
            id="agent"
          >
            {agentMaximized ? (
              <div
                className="agent-maximized-drag-handle"
                aria-label="Drag right to restore agent panel"
                onPointerDown={(event) =>
                  beginAgentLimitDrag(event.nativeEvent, true)
                }
              />
            ) : null}
            {workspaceRoot ? (
              <TerminalPanel
                mode="agent"
                maximized={agentMaximized}
                onToggleMaximized={() => {
                  if (agentMaximized) restoreAgent();
                  else enterAgentMaximized();
                }}
              />
            ) : null}
          </Panel>
        </PanelGroup>
      </div>

      <OpenWorkspaceDialog
        open={openWorkspaceDialog}
        onClose={() => setOpenWorkspaceDialog(false)}
        onOpen={(result) => {
          void openWorkspaceWithHost(result);
        }}
      />

      <QuickOpenPalette />

      <NewAgentDialogHost />

      {/* Floating overlay — not a center tab */}
      <SettingsPanel />
    </div>
  );
}
