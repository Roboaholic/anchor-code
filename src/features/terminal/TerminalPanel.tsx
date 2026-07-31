import { useThemeStore } from "@/features/shell/themeStore";
import { terminalFontSize } from "@/core/theme/theme";
import { Icon } from "@/shared/Icon";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";
import {
  sessionsForMode,
  useTerminalStore,
  type RightTermMode,
} from "./terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  acquireXtermSession,
  attachXtermSession,
  detachXtermSession,
  fitXtermSession,
  getPooledXterm,
  scheduleFitXtermSession,
  setXtermFontSize,
  setXtermTheme,
} from "./xtermSessionPool";

export function TerminalPanel({
  mode,
  maximized = false,
  onToggleMaximized,
}: {
  mode: RightTermMode;
  maximized?: boolean;
  onToggleMaximized?: () => void;
}) {
  // Guard: never fall through to the other mode if prop is missing after HMR.
  const panelMode: RightTermMode = mode === "agent" ? "agent" : "terminal";
  const tabs = useTerminalStore((s) => s.tabs);
  const activeByMode = useTerminalStore((s) => s.activeByMode);
  const sessionListOpenByMode = useTerminalStore((s) => s.sessionListOpenByMode);
  const error = useTerminalStore((s) => s.error);
  const createShellTab = useTerminalStore((s) => s.createShellTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActive = useTerminalStore((s) => s.setActive);
  const toggleSessionList = useTerminalStore((s) => s.toggleSessionList);
  const setAgentMenuOpen = useTerminalStore((s) => s.setAgentMenuOpen);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const resetForWorkspace = useTerminalStore((s) => s.resetForWorkspace);
  const sessionTabLayout = useThemeStore((s) => s.sessionTabLayout);

  const activeTabId = activeByMode[panelMode];
  const modeTabs = sessionsForMode(tabs, panelMode);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isAgent = panelMode === "agent";
  const tabsPlacement = sessionTabLayout === "top" ? "top" : "side";
  const sessionListOpen = sessionListOpenByMode[panelMode];
  // Both layouts use the expand button; top layout just defaults open (see effect).
  const showSessionList = sessionListOpen;

  // Ensure at least one shell when workspace open (owned by terminal panel).
  useEffect(() => {
    if (panelMode !== "terminal") return;
    if (workspaceRoot && tabs.length === 0 && !error) {
      void resetForWorkspace(workspaceRoot);
    }
  }, [panelMode, workspaceRoot, tabs.length, error, resetForWorkspace]);

  // Top layout: expand this mode's session strip by default once when switching to top.
  const topDefaultedRef = useRef<Partial<Record<RightTermMode, boolean>>>({});
  useEffect(() => {
    if (tabsPlacement !== "top") return;
    if (topDefaultedRef.current[panelMode]) return;
    topDefaultedRef.current[panelMode] = true;
    if (!sessionListOpenByMode[panelMode]) {
      useTerminalStore.getState().setSessionListOpen(panelMode, true);
    }
  }, [tabsPlacement, panelMode, sessionListOpenByMode]);

  const onAdd = useCallback(() => {
    if (!workspaceRoot) return;
    if (panelMode === "terminal") {
      void createShellTab();
      return;
    }
    // New agent dialog is hosted globally (Shell) — open without remounting rail.
    setAgentMenuOpen(true);
  }, [workspaceRoot, panelMode, createShellTab, setAgentMenuOpen]);

  const placementClass = isAgent
    ? "terminal-panel--side"
    : "terminal-panel--bottom";

  return (
    <aside
      className={`terminal-panel ${placementClass} terminal-panel--tabs-${tabsPlacement}`}
      aria-label={isAgent ? "Agent panel" : "Terminal panel"}
    >
      <header className="terminal-panel__header">
        <div className="terminal-panel__header-left">
          <button
            type="button"
            className={`icon-btn${sessionListOpen ? " is-active" : ""}`}
            aria-label="Session list"
            aria-pressed={sessionListOpen}
            title={
              tabsPlacement === "top"
                ? "Show or hide session tabs"
                : "Session list"
            }
            onClick={() => toggleSessionList(panelMode)}
          >
            <Icon name="list-flat" />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            aria-label={isAgent ? "New agent session" : "New terminal"}
            title={isAgent ? "New agent session" : "New shell"}
            onClick={onAdd}
            disabled={!workspaceRoot}
          >
            <Icon name="add" />
          </button>
          <span className="terminal-panel__title">
            {isAgent ? "AGENT" : "TERMINAL"}
          </span>
          {activeTab && tabsPlacement === "side" ? (
            <span className="terminal-panel__active-title" title={activeTab.title}>
              {activeTab.title}
              {activeTab.status === "exited" ? " · exited" : ""}
            </span>
          ) : null}
        </div>
        {onToggleMaximized ? (
          <div className="terminal-panel__header-right">
            <button
              type="button"
              className={`icon-btn${maximized ? " is-active" : ""}`}
              aria-label={
                maximized
                  ? `Restore ${isAgent ? "agent panel" : "terminal"}`
                  : `Maximize ${isAgent ? "agent panel" : "terminal"}`
              }
              aria-pressed={maximized}
              title={
                maximized
                  ? `Restore ${isAgent ? "agent panel" : "terminal"} (Esc)`
                  : `Maximize ${isAgent ? "agent panel" : "terminal"}`
              }
              onClick={onToggleMaximized}
            >
              <Icon name={maximized ? "screen-normal" : "screen-full"} />
            </button>
          </div>
        ) : null}
      </header>

      <div
        className={`terminal-panel__main terminal-panel__main--tabs-${tabsPlacement}`}
      >
        {/*
          Always mount the session rail; collapse with CSS so top-tab toggle
          does not remount React around xterm (reduces flash).
        */}
        <div
          className={`terminal-session-rail-slot terminal-session-rail-slot--${tabsPlacement}${
            showSessionList ? "" : " is-collapsed"
          }`}
          aria-hidden={!showSessionList}
        >
          <SessionRail
            mode={panelMode}
            layout={tabsPlacement}
            tabs={modeTabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onClose={(id) => void closeTab(id)}
            onRename={(id, title) => void renameTab(id, title)}
          />
        </div>

        <div className="terminal-panel__body">
          {error ? (
            <pre className="terminal-mock">
              {`Terminal unavailable:\n${error}\n\nIf using WSL:\n  • Confirm WSL is running (wsl -l -v)\n  • If stuck: wsl --shutdown, then reopen workspace\n  • Check workspace path exists inside the distro\n\nIf node-pty failed in a dev build:\n  npm run rebuild:native\n  npm run ensure:pty`}
            </pre>
          ) : !workspaceRoot ? (
            <pre className="terminal-mock">
              {`$ # Open a workspace to start a shell (cwd = workspace root)`}
            </pre>
          ) : isAgent && modeTabs.length === 0 ? (
            // NewAgentDialog covers the create flow when agentMenuOpen.
            <div className="terminal-panel__body-empty" aria-hidden />
          ) : !isAgent && modeTabs.length === 0 ? (
            <pre className="terminal-mock">$ # Starting shell…</pre>
          ) : (
            modeTabs.map((t) => (
              <XtermHost
                key={t.id}
                id={t.id}
                kind={t.kind ?? "shell"}
                active={t.id === activeTabId}
              />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function SessionRail({
  mode,
  layout,
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
}: {
  mode: RightTermMode;
  layout: "side" | "top";
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
      className={`terminal-session-rail terminal-session-rail--${layout}`}
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

type TermContextMenu = {
  x: number;
  y: number;
  canCopy: boolean;
};

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
  const fontSize = useThemeStore((s) => s.fontSize);
  /** React slot that receives the pooled xterm host element. */
  const slotRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<TermContextMenu | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const copySelection = useCallback(async () => {
    const term = getPooledXterm(id)?.term;
    if (!term?.hasSelection()) return;
    const text = term.getSelection();
    if (!text) return;
    try {
      await window.anchor.clipboard.writeText(text);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // ignore
      }
    }
    term.clearSelection();
    setCtxMenu(null);
  }, [id]);

  const pasteClipboard = useCallback(async () => {
    const term = getPooledXterm(id)?.term;
    if (!term) return;
    let text = "";
    try {
      text = await window.anchor.clipboard.readText();
    } catch {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = "";
      }
    }
    if (text) useTerminalStore.getState().write(id, text);
    setCtxMenu(null);
    term.focus();
  }, [id]);

  // Acquire/attach pooled session — detaching does NOT dispose (scrollback kept).
  // With stable Shell panels, this effect should only run when the session is
  // created/destroyed — not when folding left/agent/terminal rails.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const session = acquireXtermSession(
      id,
      kind,
      theme,
      terminalFontSize(fontSize),
    );
    attachXtermSession(id, slot);

    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const term = session.term;
      setCtxMenu({
        x: ev.clientX,
        y: ev.clientY,
        canCopy: term.hasSelection() && Boolean(term.getSelection()),
      });
    };
    session.hostEl.addEventListener("contextmenu", onContextMenu);

    const ro = new ResizeObserver(() => {
      if (!activeRef.current) return;
      // Debounce: left-rail fold / top session-strip toggle fire many ROs.
      // Skipping same cols×rows inside fit avoids canvas wipe flash.
      scheduleFitXtermSession(id, 100);
    });
    ro.observe(session.hostEl);
    ro.observe(slot);

    if (activeRef.current) {
      requestAnimationFrame(() => fitXtermSession(id));
    }

    return () => {
      session.hostEl.removeEventListener("contextmenu", onContextMenu);
      ro.disconnect();
      detachXtermSession(id);
    };
    // theme/font applied separately; only identity remounts attach
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind]);

  useEffect(() => {
    setXtermTheme(id, theme);
  }, [id, theme]);

  useEffect(() => {
    setXtermFontSize(id, terminalFontSize(fontSize));
  }, [id, fontSize]);

  useEffect(() => {
    if (!active) {
      setCtxMenu(null);
      return;
    }
    // Panel may expand from 0 after agentVisible flips — retry fit until sized.
    let n = 0;
    let raf = 0;
    const tryFit = () => {
      fitXtermSession(id);
      const host = getPooledXterm(id)?.hostEl;
      if (host && host.clientWidth >= 24 && host.clientHeight >= 24) {
        getPooledXterm(id)?.term.focus();
        return;
      }
      if (n++ < 40) raf = requestAnimationFrame(tryFit);
    };
    raf = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(raf);
  }, [active, id]);

  // Dismiss context menu on outside click / Escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".xterm-ctx-menu")) return;
      setCtxMenu(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  return (
    <div
      className="xterm-host-wrap"
      style={{ display: active ? "block" : "none" }}
      ref={slotRef}
    >
      {ctxMenu ? (
        <div
          className="xterm-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="xterm-ctx-menu__item"
            role="menuitem"
            disabled={!ctxMenu.canCopy}
            onClick={() => void copySelection()}
          >
            Copy
          </button>
          <button
            type="button"
            className="xterm-ctx-menu__item"
            role="menuitem"
            onClick={() => void pasteClipboard()}
          >
            Paste
          </button>
        </div>
      ) : null}
    </div>
  );
}
