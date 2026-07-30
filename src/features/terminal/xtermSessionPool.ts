/**
 * Persistent xterm instances keyed by PTY session id.
 *
 * Shell toggles Terminal/Agent panels by mounting/unmounting React trees.
 * Without a pool, that dispose()s xterm and wipes scrollback. Sessions here
 * survive React unmount; they only die when the PTY tab is closed/reset.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { xtermThemeFromCss, type UiTheme } from "@/core/theme/theme";
import { useTerminalStore } from "./terminalStore";

export type PooledXterm = {
  id: string;
  kind: string;
  term: Terminal;
  fit: FitAddon;
  /** Element passed to term.open() — reparented into React hosts. */
  hostEl: HTMLDivElement;
};

const pool = new Map<string, PooledXterm>();
const fitDebounceTimers = new Map<string, number>();

/**
 * Resize terminal to the host box. Skips when cols/rows already match so
 * panel fold / session-strip toggle doesn't wipe the canvas for no reason.
 */
function fitAndResize(session: PooledXterm, force = false) {
  const el = session.hostEl;
  if (el.clientWidth < 24 || el.clientHeight < 24) return;
  try {
    const d = session.fit.proposeDimensions();
    // Reserve one row on Windows: fractional DPI/taskbar viewport changes can
    // otherwise leave xterm's final row half-clipped until the next input.
    if (d && navigator.platform.startsWith("Win") && d.rows > 1) d.rows -= 1;
    if (!d || d.cols < 2 || d.rows < 1) return;
    if (
      !force &&
      session.term.cols === d.cols &&
      session.term.rows === d.rows
    ) {
      return;
    }
    // Prefer term.resize over fit() — same outcome, clearer skip path above.
    session.term.resize(d.cols, d.rows);
    useTerminalStore.getState().resize(session.id, d.cols, d.rows);
  } catch {
    // ignore layout races
  }
}

export function getPooledXterm(id: string): PooledXterm | undefined {
  return pool.get(id);
}

export function acquireXtermSession(
  id: string,
  kind: string,
  theme: UiTheme,
  fontSize = 12.5,
): PooledXterm {
  const existing = pool.get(id);
  if (existing) return existing;

  const hostEl = document.createElement("div");
  hostEl.className = "xterm-host";
  hostEl.dataset.sessionId = id;

  const term = new Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily:
      "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace",
    theme: xtermThemeFromCss(theme),
    allowProposedApi: true,
    rightClickSelectsWord: false,
    scrollback: 50_000,
    windowOptions: {
      setWinLines: false,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(hostEl);

  const offData = window.anchor.terminal.onData((payload) => {
    if (payload.id === id) term.write(payload.data);
  });
  const offExit = window.anchor.terminal.onExit((payload) => {
    if (payload.id !== id) return;
    term.writeln(`\r\n[process exited: ${payload.exitCode}]`);
    if (kind === "agent" || payload.kind === "agent") {
      window.setTimeout(() => {
        useTerminalStore.getState().removeTabLocal(id);
      }, 80);
    }
  });

  term.onData((data) => useTerminalStore.getState().write(id, data));

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Enter" && (e.ctrlKey || e.shiftKey || e.metaKey)) {
      e.preventDefault();
      // ESC + CR is the conventional terminal sequence used by multiline
      // prompts for Shift/Ctrl+Enter; plain Enter remains a bare CR submit.
      useTerminalStore.getState().write(id, "\x1b\r");
      return false;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return true;
    const key = e.key.toLowerCase();
    if (key === "c") {
      if (e.shiftKey || term.hasSelection()) {
        if (term.hasSelection()) {
          e.preventDefault();
          void (async () => {
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
          })();
          return false;
        }
        if (e.shiftKey) return false;
      }
      return true;
    }
    if (key === "v") {
      // Agent CLIs (omp, Claude Code, …) read the system clipboard themselves
      // — including images — when they receive the raw Ctrl+V keystroke.
      // Intercepting it here to paste text as we do for shells breaks image
      // paste and fights the agent's own clipboard handling. Let it through.
      if (kind === "agent") return true;
      e.preventDefault();
      void (async () => {
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
      })();
      return false;
    }
    return true;
  });

  if (kind !== "agent") {
    term.onTitleChange((title) => {
      if (title?.trim()) {
        useTerminalStore.getState().applyTitleFromTerm(id, title);
      }
    });
  }

  // Stash IPC unsubscribers on the element for dispose.
  (hostEl as HTMLDivElement & { __xtermCleanup?: () => void }).__xtermCleanup =
    () => {
      offData();
      offExit();
    };

  const session: PooledXterm = { id, kind, term, fit, hostEl };
  pool.set(id, session);
  return session;
}

/** Move the pooled host into a React container (or no-op if already there). */
export function attachXtermSession(id: string, parent: HTMLElement): void {
  const session = pool.get(id);
  if (!session) return;
  // Avoid re-append when already attached — reparenting flashes the canvas.
  if (session.hostEl.parentElement !== parent) {
    parent.appendChild(session.hostEl);
  }
  requestAnimationFrame(() => fitAndResize(session));
  window.setTimeout(() => fitAndResize(session, true), 180);
}

/** Detach from React DOM without disposing (keeps scrollback). */
export function detachXtermSession(id: string): void {
  const session = pool.get(id);
  if (!session) return;
  session.hostEl.remove();
}

export function fitXtermSession(id: string, force = false): void {
  const session = pool.get(id);
  if (session) fitAndResize(session, force);
}

/** Debounced fit — use while panels/strips are animating or reflowing. */
export function scheduleFitXtermSession(id: string, delayMs = 120): void {
  const prev = fitDebounceTimers.get(id);
  if (prev != null) window.clearTimeout(prev);
  const t = window.setTimeout(() => {
    fitDebounceTimers.delete(id);
    fitXtermSession(id);
  }, delayMs);
  fitDebounceTimers.set(id, t);
}

export function setXtermTheme(id: string, theme: UiTheme): void {
  const session = pool.get(id);
  if (!session) return;
  session.term.options.theme = xtermThemeFromCss(theme);
}

export function setXtermFontSize(id: string, fontSize: number): void {
  const session = pool.get(id);
  if (!session) return;
  session.term.options.fontSize = fontSize;
  fitXtermSession(id);
}

export function disposeXtermSession(id: string): void {
  const session = pool.get(id);
  if (!session) return;
  const timer = fitDebounceTimers.get(id);
  if (timer != null) {
    window.clearTimeout(timer);
    fitDebounceTimers.delete(id);
  }
  const cleanup = (
    session.hostEl as HTMLDivElement & { __xtermCleanup?: () => void }
  ).__xtermCleanup;
  try {
    cleanup?.();
  } catch {
    // ignore
  }
  try {
    session.term.dispose();
  } catch {
    // ignore
  }
  session.hostEl.remove();
  pool.delete(id);
}

export function disposeAllXtermSessions(): void {
  for (const id of [...pool.keys()]) {
    disposeXtermSession(id);
  }
}
