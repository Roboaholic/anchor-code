import { BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import type { LocalHostSession } from "../host/localHost.js";
import { HostError } from "../host/types.js";
import {
  loadSettings,
  pushRecentWorkspace,
  type RecentWorkspace,
} from "../settings.js";

/** Max bytes for readText in Slice 2 (1 MiB). */
export const MAX_READ_BYTES = 1024 * 1024;

function serializeError(err: unknown): { code: string; message: string; cause?: string } {
  if (err instanceof HostError) {
    return err.toJSON();
  }
  if (err instanceof Error) {
    return { code: "failed", message: err.message };
  }
  return { code: "failed", message: String(err) };
}

function rethrowIpc(err: unknown): never {
  const payload = serializeError(err);
  const e = new Error(payload.message) as Error & {
    code: string;
    causeDetail?: string;
  };
  e.code = payload.code;
  e.causeDetail = payload.cause;
  throw e;
}

export function registerIpc(opts: {
  host: LocalHostSession;
  getMainWindow: () => BrowserWindow | null;
  appVersion: string;
}): void {
  const { host, getMainWindow, appVersion } = opts;

  ipcMain.handle("shell:getVersion", async () => ({
    app: appVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    hostId: host.id,
    hostKind: host.kind,
  }));

  ipcMain.handle("host:getInfo", async () => ({
    id: host.id,
    kind: host.kind,
    workspaceRoot: host.workspaceRoot,
  }));

  ipcMain.handle("workspace:getRecent", async (): Promise<RecentWorkspace[]> => {
    const settings = await loadSettings();
    return settings.recentWorkspaces;
  });

  ipcMain.handle(
    "workspace:pickFolder",
    async (): Promise<string | null> => {
      const win = getMainWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        title: "Open Workspace",
        buttonLabel: "Open",
        defaultPath: host.workspaceRoot ?? undefined,
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0]!;
    },
  );

  ipcMain.handle(
    "workspace:open",
    async (_evt, dirPath: string): Promise<{ root: string; name: string }> => {
      try {
        if (!dirPath || typeof dirPath !== "string") {
          throw new HostError("failed", "Invalid workspace path");
        }
        const resolved = path.resolve(dirPath);
        const ok = await host.exists(resolved);
        if (!ok) {
          throw new HostError("not_found", `Directory not found: ${resolved}`);
        }
        const st = await host.stat(resolved);
        if (!st.isDir) {
          throw new HostError("failed", `Not a directory: ${resolved}`);
        }
        host.workspaceRoot = resolved;
        await pushRecentWorkspace(resolved);
        return {
          root: resolved,
          name: path.basename(resolved) || resolved,
        };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:listDir",
    async (_evt, dirPath: string) => {
      try {
        return await host.listDir(dirPath);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:readText",
    async (
      _evt,
      filePath: string,
    ): Promise<{ text: string; size: number; truncated: boolean }> => {
      try {
        const st = await host.stat(filePath);
        if (!st.isFile) {
          throw new HostError("failed", `Not a file: ${filePath}`);
        }
        if (st.size > MAX_READ_BYTES) {
          // Read only the first MAX_READ_BYTES as utf8 (may cut mid-char; ok for guard).
          const fs = await import("node:fs/promises");
          const fh = await fs.open(filePath, "r");
          try {
            const buf = Buffer.alloc(MAX_READ_BYTES);
            const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
            const text = buf.subarray(0, bytesRead).toString("utf8");
            return { text, size: st.size, truncated: true };
          } finally {
            await fh.close();
          }
        }
        const text = await host.readFile(filePath);
        return { text, size: st.size, truncated: false };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:stat",
    async (_evt, targetPath: string) => {
      try {
        return await host.stat(targetPath);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );
}
