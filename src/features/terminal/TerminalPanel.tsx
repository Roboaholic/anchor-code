import { xtermThemeFromCss } from "@/core/theme/theme";
import { useThemeStore } from "@/features/shell/themeStore";
import { Icon } from "@/shared/Icon";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  sessionsForMode,
  useTerminalStore,
  type RightTermMode,
} from "./terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { AgentCliProfile } from "@/shared/anchor-api";
import { NewAgentDialog } from "./NewAgentDialog";

export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const mode = useTerminalStore((s) => s.mode);
  const activeByMode = useTerminalStore((s) => s.activeByMode);
  const sessionListOpen = useTerminalStore((s) => s.sessionListOpen);
  const error = useTerminalStore((s) => s.error);
  const agentProfiles = useTerminalStore((s) => s.agentProfiles);
  const agentMenuOpen = useTerminalStore((s) => s.agentMenuOpen);
  const defaultAgentId = useTerminalStore((s) => s.defaultAgentId);
  const createShellTab = useTerminalStore((s) => s.createShellTab);
  const createAgentTab = useTerminalStore((s) => s.createAgentTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActive = useTerminalStore((s) => s.setActive);
  const setMode = useTerminalStore((s) => s.setMode);
  const toggleSessionList = useTerminalStore((s) => s.toggleSessionList);
  const setAgentMenuOpen = useTerminalStore((s) => s.setAgentMenuOpen);
  const closeAgentMenu = useTerminalStore((s) => s.closeAgentMenu);
  const loadAgentProfiles = useTerminalStore((s) => s.loadAgentProfiles);
  const detectAgents = useTerminalStore((s) => s.detectAgents);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const resetForWorkspace = useTerminalStore((s) => s.resetForWorkspace);

  const activeTabId = activeByMode[mode];
  const modeTabs = sessionsForMode(tabs, mode);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Ensure at least one shell when workspace open
  useEffect(() => {
    if (workspaceRoot && tabs.length === 0 && !error) {
      void resetForWorkspace(workspaceRoot);
    }
  }, [workspaceRoot, tabs.length, error, resetForWorkspace]);

  useEffect(() => {
    void loadAgentProfiles();
  }, [loadAgentProfiles, workspaceRoot]);

  const onAdd = useCallback(() => {
    if (!workspaceRoot) return;
    if (mode === "terminal") {
      void createShellTab();
      return;
    }
    // Always open the create dialog for a new agent session.
    setAgentMenuOpen(true);
  }, [workspaceRoot, mode, createShellTab, setAgentMenuOpen]);

  const onSelectAgentMode = useCallback(() => {
    setMode("agent");
    // setMode already opens the dialog when there are zero agent tabs.
  }, [setMode]);

  const onOpenAgent = useCallback(
    (
      p: AgentCliProfile,
      launch: { model?: string; effort?: string; title?: string },
    ) => {
      void createAgentTab(p, launch);
    },
    [createAgentTab],
  );

  return (
    <aside className="terminal-panel">
      <header className="terminal-panel__header">
        <div className="terminal-panel__header-left">
          <button
            type="button"
            className={`icon-btn${sessionListOpen ? " is-active" : ""}`}
            aria-label="Session list"
            aria-pressed={sessionListOpen}
            title="Session list"
            onClick={() => toggleSessionList()}
          >
            <Icon name="list-flat" />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            aria-label={mode === "agent" ? "New agent session" : "New terminal"}
            title={mode === "agent" ? "New agent session" : "New shell"}
            onClick={onAdd}
            disabled={!workspaceRoot}
          >
            <Icon name="add" />
          </button>
          {activeTab ? (
            <span className="terminal-panel__active-title" title={activeTab.title}>
              {activeTab.title}
              {activeTab.status === "exited" ? " · exited" : ""}
            </span>
          ) : null}
        </div>
        <div className="terminal-panel__header-right">
          <div
            className={`terminal-mode-switch terminal-mode-switch--${mode}`}
            role="tablist"
            aria-label="Panel mode"
          >
            <span className="terminal-mode-switch__thumb" aria-hidden />
            <button
              type="button"
              role="tab"
              aria-selected={mode === "agent"}
              className={`terminal-mode-switch__btn${mode === "agent" ? " is-active" : ""}`}
              onClick={onSelectAgentMode}
            >
              Agent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "terminal"}
              className={`terminal-mode-switch__btn${mode === "terminal" ? " is-active" : ""}`}
              onClick={() => setMode("terminal")}
            >
              Terminal
            </button>
          </div>
        </div>
      </header>

      {agentMenuOpen ? (
        <NewAgentDialog
          profiles={agentProfiles}
          defaultAgentId={defaultAgentId}
          onOpen={onOpenAgent}
          onDetect={() => void detectAgents()}
          onClose={() => closeAgentMenu()}
        />
      ) : null}

      <div className="terminal-panel__main">
        {sessionListOpen ? (
          <SessionRail
            mode={mode}
            tabs={modeTabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onClose={(id) => void closeTab(id)}
            onRename={(id, title) => void renameTab(id, title)}
          />
        ) : null}

        <div className="terminal-panel__body">
          {error ? (
            <pre className="terminal-mock">
              {`Terminal unavailable:\n${error}\n\nIf using WSL:\n  • Confirm WSL is running (wsl -l -v)\n  • If stuck: wsl --shutdown, then reopen workspace\n  • Check workspace path exists inside the distro\n\nIf node-pty failed in a dev build:\n  npm run rebuild:native\n  npm run ensure:pty`}
            </pre>
          ) : !workspaceRoot ? (
            <pre className="terminal-mock">
              {`$ # Open a workspace to start a shell (cwd = workspace root)`}
            </pre>
          ) : mode === "agent" && modeTabs.length === 0 ? (
            // NewAgentDialog covers create flow — no empty mock page.
            <div className="terminal-panel__body-empty" aria-hidden />
          ) : mode === "terminal" && modeTabs.length === 0 ? (
            <pre className="terminal-mock">$ # Starting shell…</pre>
          ) : (
            // Keep ALL sessions mounted for scrollback + keep-alive across modes.
            tabs.map((t) => (
              <XtermHost
                key={t.id}
                id={t.id}
                kind={t.kind ?? "shell"}
                active={t.id === activeTabId && modeOfVisible(t.kind) === mode}
              />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function modeOfVisible(kind: string | undefined): RightTermMode {
  return kind === "agent" ? "agent" : "terminal";
}

function SessionRail({
  mode,
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
}: {
  mode: RightTermMode;
  tabs: { id: string; title: string; status: string; kind: string }[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (id: string, title: string) => {
    setEditingId(id);
    setDraft(title);
  };

  const commitEdit = () => {
    if (editingId && draft.trim()) {
      onRename(editingId, draft.trim());
    }
    setEditingId(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  return (
    <nav
      className="terminal-session-rail"
      aria-label={mode === "agent" ? "Agent sessions" : "Terminal sessions"}
    >
      <div className="terminal-session-rail__label">
        {mode === "agent" ? "Agents" : "Shells"}
      </div>
      <ul className="terminal-session-rail__list" role="tablist">
        {tabs.length === 0 ? (
          <li className="terminal-session-rail__empty muted">No sessions</li>
        ) : (
          tabs.map((t) => (
            <li key={t.id} className="terminal-session-rail__item">
              {editingId === t.id ? (
                <input
                  className="terminal-session-rail__rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={onKey}
                  aria-label="Session title"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  className={`terminal-session-rail__tab${t.id === activeTabId ? " is-active" : ""}`}
                  onClick={() => onSelect(t.id)}
                  onDoubleClick={() => startEdit(t.id, t.title)}
                  title={
                    mode === "agent"
                      ? "Double-click to rename topic"
                      : t.title
                  }
                >
                  <span
                    className={`terminal-session-rail__dot${t.status === "exited" ? " is-exited" : ""}`}
                  />
                  <span className="terminal-session-rail__title">{t.title}</span>
                </button>
              )}
              <button
                type="button"
                className="terminal-session-rail__close"
                aria-label={`Close ${t.title}`}
                onClick={() => onClose(t.id)}
              >
                <Icon name="close" />
              </button>
            </li>
          ))
        )}
      </ul>
    </nav>
  );
}

function XtermHost({
  id,
  active,
  kind,
}: {
  id: string;
  active: boolean;
  kind: string;
}) {
  const theme = useThemeStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const write = useTerminalStore((s) => s.write);
  const resize = useTerminalStore((s) => s.resize);
  const applyTitleFromTerm = useTerminalStore((s) => s.applyTitleFromTerm);
  const removeTabLocal = useTerminalStore((s) => s.removeTabLocal);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily:
        "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      theme: xtermThemeFromCss(theme),
      allowProposedApi: true,
      windowOptions: {
        setWinLines: false,
      },
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
      if (payload.id !== id) return;
      term.writeln(`\r\n[process exited: ${payload.exitCode}]`);
      // Agent: user quit → remove session tag.
      if (kind === "agent" || payload.kind === "agent") {
        window.setTimeout(() => removeTabLocal(id), 80);
      }
    });

    term.onData((data) => write(id, data));

    // Shell only: OSC window title → cwd basename.
    if (kind !== "agent") {
      term.onTitleChange((title) => {
        if (title?.trim()) applyTitleFromTerm(id, title);
      });
    }

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
  }, [id, kind, write, resize, applyTitleFromTerm, removeTabLocal]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFromCss(theme);
  }, [theme]);


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
