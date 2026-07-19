import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTerminalStore } from "./terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";

export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const error = useTerminalStore((s) => s.error);
  const createTab = useTerminalStore((s) => s.createTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActive = useTerminalStore((s) => s.setActive);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const resetForWorkspace = useTerminalStore((s) => s.resetForWorkspace);

  // Ensure at least one tab when workspace open
  useEffect(() => {
    if (workspaceRoot && tabs.length === 0 && !error) {
      void resetForWorkspace(workspaceRoot);
    }
  }, [workspaceRoot, tabs.length, error, resetForWorkspace]);

  return (
    <aside className="terminal-panel">
      <header className="terminal-panel__header">
        <span className="terminal-panel__title">TERMINAL</span>
      </header>

      <div className="terminal-tabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} className="term-tab-wrap">
            <button
              type="button"
              className={`term-tab${t.id === activeTabId ? " is-active" : ""}`}
              role="tab"
              onClick={() => setActive(t.id)}
            >
              {t.title}
              {t.status === "exited" ? " ⨯" : ""}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={`Close ${t.title}`}
              onClick={() => void closeTab(t.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="term-tab term-tab--add"
          aria-label="New terminal"
          onClick={() => void createTab()}
          disabled={!workspaceRoot}
        >
          +
        </button>
      </div>

      <div className="terminal-panel__body">
        {error ? (
          <pre className="terminal-mock">
            {`Terminal unavailable:\n${error}\n\nTry:\n  npm run ensure:pty\n  npm run rebuild:native\n  npm run dev`}
          </pre>
        ) : !workspaceRoot ? (
          <pre className="terminal-mock">
            {`$ # Open a workspace to start a shell (cwd = workspace root)`}
          </pre>
        ) : tabs.length === 0 ? (
          <pre className="terminal-mock">$ # Starting shell…</pre>
        ) : (
          tabs.map((t) => (
            <XtermHost
              key={t.id}
              id={t.id}
              active={t.id === activeTabId}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function XtermHost({ id, active }: { id: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const write = useTerminalStore((s) => s.write);
  const resize = useTerminalStore((s) => s.resize);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily:
        "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#1e1f24",
        foreground: "#d4d4d8",
        cursor: "#f4f4f5",
        selectionBackground: "#3f3f46",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dim = fit.proposeDimensions();
    if (dim) resize(id, dim.cols, dim.rows);

    const offData = window.anchor.terminal.onData((payload) => {
      if (payload.id === id) term.write(payload.data);
    });
    const offExit = window.anchor.terminal.onExit((payload) => {
      if (payload.id === id) {
        term.writeln(`\r\n[process exited: ${payload.exitCode}]`);
      }
    });

    term.onData((data) => write(id, data));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const d = fit.proposeDimensions();
        if (d) resize(id, d.cols, d.rows);
      } catch {
        // ignore
      }
    });
    ro.observe(containerRef.current);

    return () => {
      offData();
      offExit();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [id, write, resize]);

  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch {
        // ignore
      }
    }
  }, [active]);

  return (
    <div
      className="xterm-host"
      style={{ display: active ? "block" : "none" }}
      ref={containerRef}
    />
  );
}
