import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { IPty } from "node-pty";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
}

interface TabInternal {
  info: TerminalTabInfo;
  pty: IPty;
}

/**
 * Multi-tab local PTY manager (Slice 5).
 * node-pty is required at runtime; fails gracefully if missing.
 */
export class TerminalService {
  private tabs = new Map<string, TabInternal>();
  private getWindow: () => BrowserWindow | null;
  private counter = 0;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  private send(channel: string, payload: unknown) {
    const win = this.getWindow();
    win?.webContents.send(channel, payload);
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => t.info);
  }

  async create(cwd: string, cols = 80, rows = 24): Promise<TerminalTabInfo> {
    let ptyModule: typeof import("node-pty");
    try {
      ptyModule = await import("node-pty");
    } catch (err) {
      throw new Error(
        `node-pty is not available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "bash" : "/bin/zsh");
    const id = randomUUID();
    this.counter += 1;
    const title = `${this.counter}: ${shellName(shell)}`;

    const pty = ptyModule.spawn(shell, [], {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });

    const info: TerminalTabInfo = {
      id,
      title,
      cwd,
      status: "running",
    };
    this.tabs.set(id, { info, pty });

    pty.onData((data) => {
      this.send("terminal:data", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.info = { ...tab.info, status: "exited" };
      }
      this.send("terminal:exit", { id, exitCode });
    });

    return info;
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    try {
      tab.pty.resize(cols, rows);
    } catch {
      // ignore invalid sizes
    }
  }

  kill(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try {
      tab.pty.kill();
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

function shellName(shell: string): string {
  const base = shell.split(/[/\\]/).pop() ?? "shell";
  return base;
}
