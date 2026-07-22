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

export function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const mode = useTerminalStore((s) => s.mode);
  const activeByMode = useTerminalStore((s) => s.activeByMode);
  const sessionListOpen = useTerminalStore((s) => s.sessionListOpen);
  const error = useTerminalStore((s) => s.error);
  const agentProfiles = useTerminalStore((s) => s.agentProfiles);
  const agentMenuOpen = useTerminalStore((s) => s.agentMenuOpen);
  const addCustomAgent = useTerminalStore((s) => s.addCustomAgent);
  const createShellTab = useTerminalStore((s) => s.createShellTab);
  const createAgentTab = useTerminalStore((s) => s.createAgentTab);
  const createAgentDefault = useTerminalStore((s) => s.createAgentDefault);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActive = useTerminalStore((s) => s.setActive);
  const setMode = useTerminalStore((s) => s.setMode);
  const toggleSessionList = useTerminalStore((s) => s.toggleSessionList);
  const setAgentMenuOpen = useTerminalStore((s) => s.setAgentMenuOpen);
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
    void createAgentDefault();
  }, [workspaceRoot, mode, createShellTab, createAgentDefault]);

  const onPickAgent = useCallback(
    (p: AgentCliProfile) => {
      void createAgentTab(p);
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
          <div
            className={`terminal-mode-switch terminal-mode-switch--${mode}`}
            role="tablist"
            aria-label="Panel mode"
          >
            <span className="terminal-mode-switch__thumb" aria-hidden />
            <button
              type="button"
              role="tab"
              aria-selected={mode === "terminal"}
              className={`terminal-mode-switch__btn${mode === "terminal" ? " is-active" : ""}`}
              onClick={() => setMode("terminal")}
            >
              Terminal
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "agent"}
              className={`terminal-mode-switch__btn${mode === "agent" ? " is-active" : ""}`}
              onClick={() => setMode("agent")}
            >
              Agent
            </button>
          </div>
          {activeTab ? (
            <span className="terminal-panel__active-title" title={activeTab.title}>
              {activeTab.title}
              {activeTab.status === "exited" ? " · exited" : ""}
            </span>
          ) : null}
        </div>
        <div className="terminal-panel__header-right">
          <div className="terminal-add-wrap">
            <button
              type="button"
              className="icon-btn"
              aria-label={mode === "agent" ? "New agent session" : "New terminal"}
              title={mode === "agent" ? "New agent CLI" : "New shell"}
              onClick={onAdd}
              disabled={!workspaceRoot}
            >
              <Icon name="add" />
            </button>
            {mode === "agent" && agentMenuOpen ? (
              <AgentPicker
                profiles={agentProfiles}
                onPick={onPickAgent}
                onDetect={() => void detectAgents()}
                onAddCustom={async (input) => {
                  const p = await addCustomAgent(input);
                  if (p) onPickAgent(p);
                }}
                onClose={() => setAgentMenuOpen(false)}
              />
            ) : null}
          </div>
        </div>
      </header>

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
              {`Terminal unavailable:\n${error}\n\nTry:\n  npm run ensure:pty\n  npm run rebuild:native\n  npm run dev`}
            </pre>
          ) : !workspaceRoot ? (
            <pre className="terminal-mock">
              {`$ # Open a workspace to start a shell (cwd = workspace root)`}
            </pre>
          ) : mode === "agent" && modeTabs.length === 0 ? (
            <pre className="terminal-mock">
              {`$ # Agent mode — open a detected CLI (Claude, Codex, …)\n$ # Sessions stay alive when you switch back to Terminal`}
            </pre>
          ) : mode === "terminal" && modeTabs.length === 0 ? (
            <pre className="terminal-mock">$ # Starting shell…</pre>
          ) : (
            // Keep ALL sessions mounted for scrollback + keep-alive across modes.
            tabs.map((t) => (
              <XtermHost
                key={t.id}
                id={t.id}
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

function AgentPicker({
  profiles,
  onPick,
  onDetect,
  onAddCustom,
  onClose,
}: {
  profiles: AgentCliProfile[];
  onPick: (p: AgentCliProfile) => void;
  onDetect: () => void;
  onAddCustom: (input: {
    name: string;
    command: string;
    args?: string[];
  }) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const enabled = profiles.filter((p) => p.enabled !== false);

  const submitCustom = async () => {
    if (!command.trim() || saving) return;
    setSaving(true);
    try {
      await onAddCustom({
        name: name.trim() || command.trim(),
        command: command.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-picker" ref={ref} role="menu">
      <div className="agent-picker__head">
        <span>Open agent CLI</span>
        <button type="button" className="btn btn--ghost btn--small" onClick={onDetect}>
          Detect
        </button>
      </div>
      {enabled.length === 0 ? (
        <div className="agent-picker__empty muted">No profiles</div>
      ) : (
        <ul className="agent-picker__list">
          {enabled.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="menuitem"
                className="agent-picker__item"
                onClick={() => onPick(p)}
              >
                <span className="agent-picker__name">{p.name}</span>
                <span className="agent-picker__meta">
                  <code>{p.command}</code>
                  {p.detected ? (
                    <span className="agent-picker__badge">found</span>
                  ) : (
                    <span className="agent-picker__badge agent-picker__badge--miss">
                      ?
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="agent-picker__footer">
        {showCustom ? (
          <div className="agent-picker__custom">
            <input
              className="agent-picker__input"
              placeholder="Display name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="agent-picker__input agent-picker__input--mono"
              placeholder="command (e.g. claude)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitCustom();
              }}
              autoFocus
            />
            <div className="agent-picker__custom-actions">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => setShowCustom(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                disabled={!command.trim() || saving}
                onClick={() => void submitCustom()}
              >
                Add & open
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="agent-picker__add-custom"
            onClick={() => setShowCustom(true)}
          >
            + Custom command…
          </button>
        )}
      </div>
    </div>
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
        background: "#fafafa",
        foreground: "#1a1d23",
        cursor: "#2563eb",
        cursorAccent: "#ffffff",
        selectionBackground: "#cfe0fc",
        selectionForeground: "#1a1d23",
        black: "#1a1d23",
        red: "#b91c1c",
        green: "#15803d",
        yellow: "#a16207",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0e7490",
        white: "#e5e7eb",
        brightBlack: "#6b7280",
        brightRed: "#dc2626",
        brightGreen: "#16a34a",
        brightYellow: "#ca8a04",
        brightBlue: "#3b82f6",
        brightMagenta: "#8b5cf6",
        brightCyan: "#06b6d4",
        brightWhite: "#111827",
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
