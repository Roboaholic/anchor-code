import type { BrowserWindow } from "electron";
import type { HostSession, PtyHandle } from "../host/types.js";
import { shellDisplayName } from "../host/localPty.js";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
}

interface TabInternal {
  info: TerminalTabInfo;
  handle: PtyHandle;
}

/**
 * Multi-tab terminal manager. Spawns PTYs through the active HostSession.
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
    win?.webContents.send(channel, payload);
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => t.info);
  }

  async create(cwd: string, cols = 80, rows = 24): Promise<TerminalTabInfo> {
    const host = this.getHost();
    const handle = await host.openPty(cwd, cols, rows);
    this.counter += 1;
    const title = `${this.counter}: ${titleForHost(host)}`;
    const info: TerminalTabInfo = {
      id: handle.id,
      title,
      cwd,
      status: "running",
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
