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
import { TerminalPanel } from "./TerminalPanel";
import { TopBar } from "./TopBar";
import { useShellStore } from "./shellStore";
import { openWorkspaceWithHost } from "./orchestrate";

export function Shell() {
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const setVersionLabel = useShellStore((s) => s.setVersionLabel);
  const openWorkspaceDialog = useShellStore((s) => s.openWorkspaceDialog);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const openPalette = useShellStore((s) => s.openPalette);
  const closePalette = useShellStore((s) => s.closePalette);
  const palette = useShellStore((s) => s.palette);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);

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

    return () => {
      cancelled = true;
      off();
    };
  }, [setVersionLabel, loadRecent, openPalette]);

  // Renderer fallback shortcuts (menu accelerators also send shell:command).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      // Don't steal when typing in real inputs inside dialogs we don't own —
      // palette owns its own Esc; still allow reopen while closed.
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

  // Drop file index when workspace changes.
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  useEffect(() => {
    invalidateFileIndexCache();
  }, [workspaceRoot]);

  // Esc closes palette if focus left the dialog.
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

  return (
    <div className="shell">
      <TopBar />
      <div className="shell__body">
        <PanelGroup direction="horizontal" autoSaveId="anchor-shell">
          <Panel defaultSize={22} minSize={14} maxSize={36} id="left">
            <LeftNav />
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={terminalVisible ? 48 : 78} minSize={30} id="center">
            <DocumentArea />
          </Panel>

          {terminalVisible ? (
            <>
              <PanelResizeHandle className="resize-handle" />
              <Panel defaultSize={30} minSize={18} maxSize={50} id="terminal">
                <TerminalPanel />
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
    </div>
  );
}
