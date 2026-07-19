import { useEffect } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { DocumentArea } from "./DocumentArea";
import { LeftNav } from "./LeftNav";
import { TerminalPanel } from "./TerminalPanel";
import { TopBar } from "./TopBar";
import { useShellStore } from "./shellStore";

export function Shell() {
  const terminalVisible = useShellStore((s) => s.terminalVisible);
  const setVersionLabel = useShellStore((s) => s.setVersionLabel);

  useEffect(() => {
    let cancelled = false;
    async function loadVersion() {
      try {
        if (!window.anchor?.shell?.getVersion) {
          setVersionLabel("no bridge");
          return;
        }
        const info = await window.anchor.shell.getVersion();
        if (!cancelled) {
          setVersionLabel(`v${info.app} · ${info.hostKind}`);
        }
      } catch {
        if (!cancelled) {
          setVersionLabel("ipc error");
        }
      }
    }
    void loadVersion();
    return () => {
      cancelled = true;
    };
  }, [setVersionLabel]);

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
    </div>
  );
}
