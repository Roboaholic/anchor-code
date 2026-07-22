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
import { TerminalPanel } from "./TerminalPanel";
import { TopBar } from "./TopBar";
import { useShellStore } from "./shellStore";
import { openWorkspaceWithHost } from "./orchestrate";
export function Shell() {
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const setVersionLabel = useShellStore((s) => s.setVersionLabel);
  const openWorkspaceDialog = useShellStore((s) => s.openWorkspaceDialog);
  const setOpenWorkspaceDialog = useShellStore((s) => s.setOpenWorkspaceDialog);
  const loadRecent = useWorkspaceStore((s) => s.loadRecent);
  useEffect(() => {
    let cancelled = false;
    async function loadVersion() {
      try {
        if (!window.anchor?.shell?.getVersion) {
          // Visible signal when preload failed (e.g. .mjs + require mismatch).
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
        }
      }) ?? (() => undefined);

    return () => {
      cancelled = true;
      off();
    };
  }, [setVersionLabel, loadRecent]);

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
    </div>
  );
}
