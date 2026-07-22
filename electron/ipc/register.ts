import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import path from "node:path";
import type { LocalHostSession } from "../host/localHost.js";
import { HostError } from "../host/types.js";
import {
  addComment,
  copyYamlPath,
  deleteComment,
  editComment,
  endSession,
  ensureActiveSession,
  exportSession,
  listSessionSummaries,
  loadSessions,
  locateGitRoot,
  newSession,
  replyComment,
  restoreSession,
  setCommentStatus,
  type AddCommentInput,
  type CommentStatus,
} from "../services/annotationsService.js";
import {
  compareCommits,
  compareToWorktree,
  discoverRepos,
  getFileDiff,
  loadLog,
} from "../services/historyService.js";
import { TerminalService } from "../services/terminalService.js";
import {
  loadSettings,
  pushRecentWorkspace,
  type RecentWorkspace,
} from "../settings.js";

/** Max bytes for readText (1 MiB). */
export const MAX_READ_BYTES = 1024 * 1024;

function serializeError(err: unknown): {
  code: string;
  message: string;
  cause?: string;
} {
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
  terminal: TerminalService;
}): void {
  const { host, getMainWindow, appVersion, terminal } = opts;

  // ── shell ──────────────────────────────────────────
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

  ipcMain.handle("clipboard:writeText", async (_evt, text: string) => {
    clipboard.writeText(text ?? "");
    return true;
  });

  // ── workspace ──────────────────────────────────────
  ipcMain.handle(
    "workspace:getRecent",
    async (): Promise<RecentWorkspace[]> => {
      const settings = await loadSettings();
      return settings.recentWorkspaces;
    },
  );

  ipcMain.handle(
    "workspace:pickFolder",
    async (): Promise<string | null> => {
      try {
        const win = getMainWindow();
        const options: Electron.OpenDialogOptions = {
          properties: ["openDirectory", "createDirectory"],
          title: "Open Workspace",
          buttonLabel: "Open",
          message: "Choose a folder to open as the workspace",
          defaultPath:
            host.workspaceRoot ?? app.getPath("home") ?? undefined,
        };
        // Prefer parented dialog so it appears above the app on macOS.
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        return result.filePaths[0]!;
      } catch (err) {
        console.error("[ipc] workspace:pickFolder failed:", err);
        rethrowIpc(err);
      }
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
        // Recent list is best-effort — never block opening.
        try {
          await pushRecentWorkspace(resolved);
        } catch (err) {
          console.warn("[ipc] pushRecentWorkspace failed:", err);
        }
        // Reset terminals to new cwd
        try {
          terminal.disposeAll();
        } catch (err) {
          console.warn("[ipc] terminal.disposeAll failed:", err);
        }
        return {
          root: resolved,
          name: path.basename(resolved) || resolved,
        };
      } catch (err) {
        console.error("[ipc] workspace:open failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("workspace:listDir", async (_evt, dirPath: string) => {
    try {
      return await host.listDir(dirPath);
    } catch (err) {
      rethrowIpc(err);
    }
  });

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

  ipcMain.handle("workspace:stat", async (_evt, targetPath: string) => {
    try {
      return await host.stat(targetPath);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  // ── history ────────────────────────────────────────
  ipcMain.handle("history:discover", async (_evt, workspaceRoot: string) => {
    try {
      return await discoverRepos(host, workspaceRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("history:loadLog", async (_evt, repoRoot: string) => {
    try {
      return await loadLog(host, repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "history:compare",
    async (
      _evt,
      args: { repoRoot: string; base: string; head: string | "worktree" },
    ) => {
      try {
        if (args.head === "worktree") {
          return await compareToWorktree(host, args.repoRoot, args.base);
        }
        return await compareCommits(
          host,
          args.repoRoot,
          args.base,
          args.head,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:getFileDiff",
    async (
      _evt,
      args: {
        repoRoot: string;
        base: string;
        head: string | "worktree";
        path: string;
        status: string;
      },
    ) => {
      try {
        return await getFileDiff(
          host,
          args.repoRoot,
          args.base,
          args.head,
          args.path,
          args.status,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  // ── annotations ────────────────────────────────────
  ipcMain.handle("annotations:locateGitRoot", async (_evt, filePath: string) => {
    try {
      return await locateGitRoot(host, filePath);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("annotations:load", async (_evt, repoRoot: string) => {
    try {
      return await loadSessions(host, repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("annotations:list", async (_evt, repoRoot: string) => {
    try {
      return await listSessionSummaries(host, repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "annotations:ensureActive",
    async (
      _evt,
      args: string | { repoRoot: string; title?: string },
    ) => {
      try {
        if (typeof args === "string") {
          return await ensureActiveSession(host, args);
        }
        return await ensureActiveSession(host, args.repoRoot, "local-user", args.title);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:addComment",
    async (_evt, input: AddCommentInput) => {
      try {
        return await addComment(host, input);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:setStatus",
    async (
      _evt,
      args: { repoRoot: string; commentId: string; status: CommentStatus },
    ) => {
      try {
        return await setCommentStatus(
          host,
          args.repoRoot,
          args.commentId,
          args.status,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:reply",
    async (
      _evt,
      args: { repoRoot: string; commentId: string; body: string },
    ) => {
      try {
        return await replyComment(
          host,
          args.repoRoot,
          args.commentId,
          args.body,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:editComment",
    async (
      _evt,
      args: {
        repoRoot: string;
        commentId: string;
        body: string;
        messageId?: string;
      },
    ) => {
      try {
        return await editComment(
          host,
          args.repoRoot,
          args.commentId,
          args.body,
          args.messageId,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:deleteComment",
    async (
      _evt,
      args: { repoRoot: string; commentId: string },
    ) => {
      try {
        return await deleteComment(host, args.repoRoot, args.commentId);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:endSession",
    async (
      _evt,
      args: string | { repoRoot: string; sessionId?: string; export?: boolean },
    ) => {
      try {
        if (typeof args === "string") {
          return await endSession(host, args);
        }
        return await endSession(host, args.repoRoot, {
          sessionId: args.sessionId,
          export: args.export,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:newSession",
    async (
      _evt,
      args: string | { repoRoot: string; title?: string },
    ) => {
      try {
        if (typeof args === "string") {
          return await newSession(host, args);
        }
        return await newSession(host, args.repoRoot, "local-user", args.title);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:restoreSession",
    async (
      _evt,
      args: { repoRoot: string; sessionId: string },
    ) => {
      try {
        return await restoreSession(host, args.repoRoot, args.sessionId);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:exportSession",
    async (
      _evt,
      args: { repoRoot: string; sessionId?: string },
    ) => {
      try {
        return await exportSession(host, args.repoRoot, args.sessionId);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:copyYamlPath",
    async (
      _evt,
      args: string | { repoRoot: string; sessionId?: string },
    ) => {
      try {
        const repoRoot = typeof args === "string" ? args : args.repoRoot;
        const sessionId = typeof args === "string" ? undefined : args.sessionId;
        const abs = await copyYamlPath(host, repoRoot, sessionId);
        clipboard.writeText(abs);
        return abs;
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  // ── terminal ───────────────────────────────────────
  ipcMain.handle(
    "terminal:create",
    async (
      _evt,
      args: { cwd?: string; cols?: number; rows?: number },
    ) => {
      try {
        const cwd =
          args.cwd ?? host.workspaceRoot ?? process.env.HOME ?? process.cwd();
        return await terminal.create(cwd, args.cols ?? 80, args.rows ?? 24);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("terminal:list", async () => terminal.list());

  ipcMain.handle(
    "terminal:write",
    async (_evt, args: { id: string; data: string }) => {
      terminal.write(args.id, args.data);
    },
  );

  ipcMain.handle(
    "terminal:resize",
    async (_evt, args: { id: string; cols: number; rows: number }) => {
      terminal.resize(args.id, args.cols, args.rows);
    },
  );

  ipcMain.handle("terminal:kill", async (_evt, id: string) => {
    terminal.kill(id);
  });

  ipcMain.handle("terminal:disposeAll", async () => {
    terminal.disposeAll();
  });
}
