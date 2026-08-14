/**
 * Persistent xterm instances keyed by PTY session id.
 *
 * Shell toggles Terminal/Agent panels by mounting/unmounting React trees.
 * Without a pool, that dispose()s xterm and wipes scrollback. Sessions here
 * survive React unmount; they only die when the PTY tab is closed/reset.
 */
import { Terminal, type ILink, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { xtermThemeFromCss, type UiTheme } from "@/core/theme/theme";
import { useTerminalStore } from "./terminalStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  findTerminalFileLinks,
  resolveTerminalFilePath,
  terminalFileLinkRange,
} from "./terminalFileLinks";

export type PooledXterm = {
  id: string;
  kind: string;
  term: Terminal;
  fit: FitAddon;
  /** Element passed to term.open() — reparented into React hosts. */
  hostEl: HTMLDivElement;
  opened: boolean;
};

const pool = new Map<string, PooledXterm>();
const fitDebounceTimers = new Map<string, number>();
export function terminalKeySequence(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return "\t";
  }
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.shiftKey || event.metaKey)
  ) {
    return "\x1b\r";
  }
  return null;
}

export function isAgentTaskSubmitKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.key === "Enter" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}
export function shouldDeferAgentCtrlKey(
  kind: string,
  event: { key: string; ctrlKey: boolean; metaKey: boolean },
  hasSelection: boolean,
): boolean {
  if (kind !== "agent" || !event.ctrlKey || event.metaKey) return false;
  const key = event.key.toLowerCase();
  if (key === "c" && hasSelection) return false;
  if (key === "v") return false;
  return true;
}

export type TerminalClipboardAction = "copy" | "paste";

export function terminalClipboardAction(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}, hasSelection: boolean): TerminalClipboardAction | null {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "c" && (event.shiftKey || hasSelection)) {
    return "copy";
  }
  if ((event.ctrlKey || event.metaKey) && key === "v") return "paste";
  if (event.shiftKey && event.key === "Insert") return "paste";
  if (event.ctrlKey && event.key === "Insert" && hasSelection) return "copy";
  return null;
}

export function shouldForwardAgentImagePaste(
  kind: string,
  action: TerminalClipboardAction | null,
  hasClipboardImage: boolean,
): boolean {
  return kind === "agent" && action === "paste" && hasClipboardImage;
}

function registerFileLinkProvider(term: Terminal): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const requestedRow = bufferLineNumber - 1;
      let firstRow = requestedRow;
      while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;

      let lastRow = requestedRow;
      while (buffer.getLine(lastRow + 1)?.isWrapped) lastRow++;

      let text = "";
      for (let row = firstRow; row <= lastRow; row++) {
        const wrappedLine = buffer.getLine(row);
        if (!wrappedLine) break;
        text += wrappedLine.translateToString(row === lastRow);
      }

      const workspaceRoot = useWorkspaceStore.getState().workspaceRoot;
      if (!workspaceRoot) {
        callback(undefined);
        return;
      }
      const links = findTerminalFileLinks(text).filter((link) => {
        const range = terminalFileLinkRange(link, firstRow + 1, term.cols);
        return range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber;
      });
      if (links.length === 0) {
        callback(undefined);
        return;
      }

      void Promise.all(
        links.map(async (link): Promise<ILink | null> => {
          const path = resolveTerminalFilePath(workspaceRoot, link.path);
          let isFile = false;
          try {
            isFile = (await window.anchor.workspace.stat(path)).isFile;
          } catch {
            isFile = false;
          }
          if (!isFile) return null;

          return {
            text: link.text,
            range: terminalFileLinkRange(link, firstRow + 1, term.cols),
            activate: () => {
              useWorkspaceStore.getState().setSelectedPath(path);
              void useDocumentStore.getState().openFile({
                path,
                workspaceRoot,
                revealLine: link.line,
              });
            },
          };
        }),
      ).then((resolved) => {
        const valid = resolved.filter((link): link is ILink => link !== null);
        callback(valid.length > 0 ? valid : undefined);
      });
    },
  });
}

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
    if (session.term.cols === d.cols && session.term.rows === d.rows) {
      if (force) session.term.refresh(0, Math.max(0, session.term.rows - 1));
      return;
    }
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
    // Agent TUIs draw their own activity indicators; a blinking terminal caret
    // beside those updates looks like positional jitter while the agent works.
    cursorBlink: kind !== "agent",
    fontSize,
    fontFamily:
      "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, monospace",
    theme: xtermThemeFromCss(theme),
    allowProposedApi: true,
    rightClickSelectsWord: false,
    scrollback: 50_000,
    windowsPty: navigator.platform.startsWith("Win")
      ? { backend: "conpty", buildNumber: 21376 }
      : undefined,
    windowOptions: {
      setWinLines: false,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const fileLinks = registerFileLinkProvider(term);

  // @xterm/xterm 6.0.0 is miscompiled by the current production minifier in
  // its built-in DECRQM handler (requestMode references an undefined enum
  // variable). Shells and agent TUIs probe these modes during startup; once
  // the handler throws, the parser stops rendering all later input. Public
  // parser handlers run before the built-in handler, so safely consume the
  // probes until the upstream bundle no longer contains the broken code.
  const ansiModeQueryDisposable = term.parser.registerCsiHandler(
    { intermediates: "$", final: "p" },
    () => true,
  );
  const decModeQueryDisposable = term.parser.registerCsiHandler(
    { prefix: "?", intermediates: "$", final: "p" },
    () => true,
  );

  let hydrating = true;
  const pendingData: Array<{ data: string; seq: number }> = [];
  let agentHasUserInput = false;
  const offData = window.anchor.terminal.onData((payload) => {
    if (payload.id !== id) return;
    if (hydrating) {
      pendingData.push({ data: payload.data, seq: payload.seq });
      return;
    }
    if (kind === "agent") useTerminalStore.getState().noteAgentOutput(id);
    term.write(payload.data);
  });
  void window.anchor.terminal.snapshot(id).then((snapshot) => {
    if (snapshot.data) term.write(snapshot.data);
    for (const item of pendingData) {
      if (item.seq > snapshot.seq) term.write(item.data);
    }
    pendingData.length = 0;
    hydrating = false;
  }).catch(() => {
    for (const item of pendingData) term.write(item.data);
    pendingData.length = 0;
    hydrating = false;
  });
  const offExit = window.anchor.terminal.onExit((payload) => {
    if (payload.id !== id) return;
    term.writeln(`\r\n[process exited: ${payload.exitCode}]`);
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, status: "exited" } : tab,
      ),
    }));
  });

  term.onData((data) => {
    if (kind === "agent" && data !== "\r" && data !== "\n") {
      agentHasUserInput = true;
    }
    useTerminalStore.getState().write(id, data);
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // A selected range keeps the standard Ctrl+C copy behavior. Other Agent
    // Ctrl combinations, including unselected Ctrl+C, belong to the CLI.
    if (shouldDeferAgentCtrlKey(kind, e, term.hasSelection())) return true;
    if (kind === "agent" && agentHasUserInput && isAgentTaskSubmitKey(e)) {
      agentHasUserInput = false;
      useTerminalStore.getState().markAgentWorking(id);
    }
    const sequence = terminalKeySequence(e);
    if (sequence !== null) {
      e.preventDefault();
      useTerminalStore.getState().write(id, sequence);
      return false;
    }
    const clipboardAction = terminalClipboardAction(e, term.hasSelection());
    if (clipboardAction === "copy") {
      e.preventDefault();
      const text = term.getSelection();
      if (text) {
        void window.anchor.clipboard.writeText(text).catch(() =>
          navigator.clipboard.writeText(text).catch(() => undefined),
        );
      }
      return false;
    }
    if (clipboardAction === "paste") {
      e.preventDefault();
      void window.anchor.clipboard.contentKind().then((clipboardKind) => {
        if (clipboardKind === "text") {
          return window.anchor.clipboard.readText().then((text) => {
            if (text) term.paste(text);
          });
        }
        if (clipboardKind === "image" && kind === "agent") {
          // Agent CLIs read the image from the native clipboard on Ctrl+V.
          useTerminalStore.getState().write(id, "\x16");
        }
      }).catch(() => undefined);
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
      fileLinks.dispose();
      ansiModeQueryDisposable.dispose();
      decModeQueryDisposable.dispose();
    };

  const session: PooledXterm = { id, kind, term, fit, hostEl, opened: false };
  pool.set(id, session);
  return session;
}

/**
 * Attach the pooled host into a React container.
 * Opens xterm on first successful attach (hostEl must be in the DOM with size).
 * Returns false if the container is too small — caller should retry.
 */
export function attachXtermSession(id: string, parent: HTMLElement): boolean {
  const session = pool.get(id);
  if (!session) return false;
  if (parent.clientWidth < 24 || parent.clientHeight < 24) return false;
  if (session.hostEl.parentElement !== parent) parent.appendChild(session.hostEl);
  if (!session.opened) {
    session.term.open(session.hostEl);
    session.opened = true;
  }
  requestAnimationFrame(() => fitAndResize(session));
  window.setTimeout(() => fitAndResize(session, true), 180);
  return true;
}

/** Detach only when this React host currently owns the pooled element. */
export function detachXtermSession(id: string, parent: HTMLElement): void {
  const session = pool.get(id);
  if (session?.hostEl.parentElement === parent) session.hostEl.remove();
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
