import { useEffect } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { DocumentArea } from "@/features/document/DocumentArea";
import { OpenWorkspaceDialog } from "@/features/workspace/OpenWorkspaceDialog";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { LeftNav } from "./LeftNav";
import { QuickOpenPalette, invalidateFileIndexCache } from "./QuickOpen";
import { NewAgentDialogHost } from "@/features/terminal/NewAgentDialogHost";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { TerminalPanel } from "./TerminalPanel";
import { TopBar } from "./TopBar";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";
import { openWorkspaceWithHost } from "./orchestrate";

export function Shell() {
  const leftVisible = useShellStore((s) => s.leftVisible);
  const agentVisible = useShellStore((s) => s.agentVisible);
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const setVersionLabel = useShellStore((s) => s.setVersionLabel);
  const openWorkspaceDialog = useShellStore((s) => s.openWorkspaceDialog);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const openPalette = useShellStore((s) => s.openPalette);
  const closePalette = useShellStore((s) => s.closePalette);
  const palette = useShellStore((s) => s.palette);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);
  const hydrateTheme = useThemeStore((s) => s.hydrate);

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

  // Horizontal default sizes must sum ~100 for the panels that exist.
  const centerDefault = leftVisible
    ? showAgent
      ? 48
      : 78
    : showAgent
      ? 70
      : 100;
  const leftDefault = 22;
  const agentDefault = leftVisible ? 30 : 30;

  return (
    <div className="shell">
      <TopBar />
      <div className="shell__body">
        {/*
          Remount when panel set changes so defaultSize is applied.
          Dynamic Panel add with the same group often leaves the new panel at ~0 size.
        */}
        <PanelGroup
          key={`h-l${leftVisible ? 1 : 0}-a${showAgent ? 1 : 0}`}
          direction="horizontal"
          autoSaveId="anchor-shell-v3"
          className="shell__panels"
        >
          {leftVisible ? (
            <>
              <Panel
                order={1}
                defaultSize={leftDefault}
                minSize={14}
                maxSize={36}
                id="left"
              >
                <LeftNav />
              </Panel>
              <PanelResizeHandle className="resize-handle" />
            </>
          ) : null}

          <Panel order={2} defaultSize={centerDefault} minSize={30} id="center">
            <div className="shell__center-stack">
              <PanelGroup
                key={`v-t${showTerminal ? 1 : 0}`}
                direction="vertical"
                autoSaveId="anchor-shell-center-v3"
                className="shell__panels shell__panels--col"
              >
                <Panel
                  order={1}
                  defaultSize={showTerminal ? 70 : 100}
                  minSize={25}
                  id="document"
                >
                  <DocumentArea />
                </Panel>

                {showTerminal ? (
                  <>
                    <PanelResizeHandle className="resize-handle resize-handle--row" />
                    <Panel
                      order={2}
                      defaultSize={30}
                      minSize={12}
                      maxSize={60}
                      id="terminal-bottom"
                    >
                      <TerminalPanel mode="terminal" />
                    </Panel>
                  </>
                ) : null}
              </PanelGroup>
            </div>
          </Panel>

          {showAgent ? (
            <>
              <PanelResizeHandle className="resize-handle" />
              <Panel
                order={3}
                defaultSize={agentDefault}
                minSize={18}
                maxSize={50}
                id="agent"
              >
                <TerminalPanel mode="agent" />
              </Panel>
            </>
          ) : null}
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
    </div>
  );
}
