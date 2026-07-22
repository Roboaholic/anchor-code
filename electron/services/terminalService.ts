import type { BrowserWindow } from "electron";
import type { HostSession, PtyHandle } from "../host/types.js";
import { shellDisplayName } from "../host/localPty.js";

export type TerminalSessionKind = "shell" | "agent";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  kind: TerminalSessionKind;
  agentId?: string;
}

export interface TerminalCreateOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  kind?: TerminalSessionKind;
  command?: string;
  args?: string[];
  title?: string;
  agentId?: string;
}

interface TabInternal {
  info: TerminalTabInfo;
  handle: PtyHandle;
}

/**
 * Multi-tab terminal manager. Spawns PTYs through the active HostSession.
 * Shell and agent sessions share the same pool; kind is metadata only.
 */
export class TerminalService {
  private tabs = new Map<string, TabInternal>();
  private getWindow: () => BrowserWindow | null;
  private getHost: () => HostSession;
  private counter = 0;

  constructor(
    getWindow: () => BrowserWindow | null,
    getHost: () => HostSession,
  ) {
    this.getWindow = getWindow;
    this.getHost = getHost;
  }

  private send(channel: string, payload: unknown) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => t.info);
  }

  async create(opts: TerminalCreateOptions): Promise<TerminalTabInfo> {
    const host = this.getHost();
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const kind: TerminalSessionKind = opts.kind ?? "shell";
    const spawnOpts =
      opts.command && opts.command.trim()
        ? { command: opts.command.trim(), args: opts.args ?? [] }
        : undefined;

    const handle = await host.openPty(opts.cwd, cols, rows, spawnOpts);
    this.counter += 1;

    let title = opts.title?.trim();
    if (!title) {
      if (kind === "agent" && opts.agentId) {
        title = opts.agentId;
      } else if (kind === "agent" && opts.command) {
        title = shellDisplayName(opts.command);
      } else {
        title = `${this.counter}: ${titleForHost(host)}`;
      }
    }

    const info: TerminalTabInfo = {
      id: handle.id,
      title,
      cwd: opts.cwd,
      status: "running",
      kind,
      agentId: opts.agentId,
    };
    this.tabs.set(handle.id, { info, handle });

    handle.onData((data) => {
      this.send("terminal:data", { id: handle.id, data });
    });
    handle.onExit((exitCode) => {
      const tab = this.tabs.get(handle.id);
      if (tab) {
        tab.info = { ...tab.info, status: "exited" };
      }
      this.send("terminal:exit", { id: handle.id, exitCode });
    });

    return info;
  }

  rename(id: string, title: string): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const next = title.trim() || tab.info.title;
    tab.info = { ...tab.info, title: next };
    return tab.info;
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.handle.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.handle.resize(cols, rows);
  }

  kill(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try {
      tab.handle.kill();
    } catch {
      // ignore
    }
    this.tabs.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.tabs.keys()]) {
      this.kill(id);
    }
    this.counter = 0;
  }
}

function titleForHost(host: HostSession): string {
  if (host.kind === "wsl") return "wsl";
  if (host.kind === "ssh") return "ssh";
  if (process.platform === "win32") return "cmd";
  return shellDisplayName(process.env.SHELL || "zsh");
}

// Re-export for tests that still import ensureSpawnHelperExecutable from here.
export { ensureSpawnHelperExecutable } from "../host/localPty.js";
