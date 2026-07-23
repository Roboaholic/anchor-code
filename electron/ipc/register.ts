import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { applyWindowChromeTheme } from "../windowChrome.js";
import type { HostManager } from "../host/hostManager.js";
import { WslHostSession, listWslDistros } from "../host/wslHost.js";
import {
  hostBasename,
  hostNormalize,
} from "../host/paths.js";
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
  loadRepoStatus,
} from "../services/historyService.js";
import { TerminalService } from "../services/terminalService.js";
import {
  detectAgentClis,
  getDefaultAgentId,
  listAgentProfiles,
  saveAgentProfiles,
  setDefaultAgentId,
  upsertAgentProfile,
} from "../services/agentCli.js";
import {
  buildAgentLaunchArgs,
  discoverAgentLaunchOptions,
} from "../services/agentLaunch.js";
import { findWorkspaceFiles } from "../services/fileIndex.js";
import {
  getHistoryRecentCompares,
  getHostProfile,
  getUiTheme,
  loadSettings,
  normalizeTheme,
  pushHistoryRecentCompare,
  pushRecentWorkspace,
  removeHistoryRecentCompare,
  setUiTheme,
  upsertHostProfile,
  type HistoryCompareEntry,
  type HostProfile,
  type RecentWorkspace,
  type UiTheme,
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
  hosts: HostManager;
  getMainWindow: () => BrowserWindow | null;
  appVersion: string;
  terminal: TerminalService;
}): void {
  const { hosts, getMainWindow, appVersion, terminal } = opts;

  const host = () => hosts.session;

  // ── shell ──────────────────────────────────────────
  ipcMain.handle("shell:getVersion", async () => {
    const h = host();
    return {
      app: appVersion,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      hostId: h.id,
      hostKind: h.kind,
    };
  });

  ipcMain.handle("shell:menuAction", async (_evt, action: string) => {
    const win = getMainWindow();
    switch (action) {
      case "openWorkspace":
      case "quickOpen":
      case "openFilePath":
        win?.webContents.send("shell:command", { type: action });
        return true;
      case "reload":
        win?.webContents.reload();
        return true;
      case "forceReload":
        win?.webContents.reloadIgnoringCache();
        return true;
      case "toggleDevTools":
        win?.webContents.toggleDevTools();
        return true;
      case "resetZoom":
        if (win) win.webContents.setZoomLevel(0);
        return true;
      case "zoomIn":
        if (win) win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
        return true;
      case "zoomOut":
        if (win) win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
        return true;
      case "toggleFullscreen":
        if (win) win.setFullScreen(!win.isFullScreen());
        return true;
      case "minimize":
        win?.minimize();
        return true;
      case "zoom":
        if (win) {
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
        }
        return true;
      case "close":
        win?.close();
        return true;
      case "quit":
        app.quit();
        return true;
      default:
        return false;
    }
  });

  ipcMain.handle("host:getInfo", async () => {
    const h = host();
    return {
      id: h.id,
      kind: h.kind,
      profileId: h.profileId,
      workspaceRoot: h.workspaceRoot,
    };
  });

  ipcMain.handle("host:listProfiles", async (): Promise<HostProfile[]> => {
    const settings = await loadSettings();
    return settings.hostProfiles;
  });

  ipcMain.handle("host:listWslDistros", async (): Promise<string[]> => {
    try {
      return await listWslDistros();
    } catch (err) {
      console.warn("[ipc] listWslDistros failed:", err);
      return [];
    }
  });

  /** Home path inside a WSL distro (POSIX). Does not switch active host. */
  ipcMain.handle(
    "host:wslHome",
    async (
      _evt,
      args?: { distro?: string },
    ): Promise<string> => {
      try {
        const session = new WslHostSession({
          profileId: "wsl-browse",
          distro: args?.distro,
        });
        try {
          const r = await session.run("/", "bash", ["-lc", "printf %s \"$HOME\""]);
          const home = (r.stdout || "").trim();
          if (r.code === 0 && home.startsWith("/")) return home;
          return "/home";
        } finally {
          await session.dispose();
        }
      } catch (err) {
        console.warn("[ipc] host:wslHome failed:", err);
        return "/home";
      }
    },
  );

  /**
   * List a directory on a host profile without committing active workspace host.
   * Used by Open Workspace WSL folder browser.
   */
  ipcMain.handle(
    "host:browseListDir",
    async (
      _evt,
      args: { path: string; kind: "wsl" | "ssh"; distro?: string },
    ) => {
      try {
        if (!args?.path || typeof args.path !== "string") {
          throw new HostError("failed", "Invalid browse path");
        }
        if (args.kind !== "wsl") {
          throw new HostError("not_implemented", "Browse only supports WSL for now");
        }
        const session = new WslHostSession({
          profileId: "wsl-browse",
          distro: args.distro,
        });
        try {
          return await session.listDir(args.path);
        } finally {
          await session.dispose();
        }
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "host:useProfile",
    async (_evt, profileId: string): Promise<{ id: string; kind: string; profileId: string }> => {
      try {
        const profile = await getHostProfile(profileId);
        if (!profile) {
          throw new HostError("not_found", `Host profile not found: ${profileId}`);
        }
        terminal.disposeAll();
        const session = await hosts.useProfile(profile);
        return {
          id: session.id,
          kind: session.kind,
          profileId: session.profileId,
        };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "host:upsertProfile",
    async (_evt, profile: HostProfile): Promise<HostProfile[]> => {
      try {
        return await upsertHostProfile(profile);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("clipboard:writeText", async (_evt, text: string) => {
    clipboard.writeText(text ?? "");
    return true;
  });

  // ── settings / appearance ──────────────────────────
  ipcMain.handle("settings:getTheme", async (): Promise<UiTheme> => {
    try {
      return await getUiTheme();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "settings:setTheme",
    async (_evt, theme: unknown): Promise<UiTheme> => {
      try {
        const next = await setUiTheme(normalizeTheme(theme));
        applyWindowChromeTheme(getMainWindow(), next);
        return next;
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

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
        const h = host();
        if (h.kind !== "local") {
          // Remote/WSL path selection is handled in the renderer dialog.
          throw new HostError(
            "failed",
            "Native folder picker is only available for Local host",
          );
        }
        const win = getMainWindow();
        const options: Electron.OpenDialogOptions = {
          properties: ["openDirectory", "createDirectory"],
          title: "Open Workspace",
          buttonLabel: "Open",
          message: "Choose a folder to open as the workspace",
          defaultPath:
            h.workspaceRoot ?? app.getPath("home") ?? undefined,
        };
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
    async (
      _evt,
      args: string | { path: string; hostProfileId?: string },
    ): Promise<{ root: string; name: string; hostKind: string; hostProfileId: string }> => {
      try {
        const dirPath = typeof args === "string" ? args : args.path;
        const requestedProfileId =
          typeof args === "string" ? undefined : args.hostProfileId;

        if (!dirPath || typeof dirPath !== "string") {
          throw new HostError("failed", "Invalid workspace path");
        }

        if (requestedProfileId && requestedProfileId !== hosts.profileId) {
          const profile = await getHostProfile(requestedProfileId);
          if (!profile) {
            throw new HostError(
              "not_found",
              `Host profile not found: ${requestedProfileId}`,
            );
          }
          terminal.disposeAll();
          await hosts.useProfile(profile);
        }

        const h = host();
        const resolved = hostNormalize(h.kind, dirPath);
        const ok = await h.exists(resolved);
        if (!ok) {
          throw new HostError("not_found", `Directory not found: ${resolved}`);
        }
        const st = await h.stat(resolved);
        if (!st.isDir) {
          throw new HostError("failed", `Not a directory: ${resolved}`);
        }
        h.workspaceRoot = resolved;

        try {
          await pushRecentWorkspace(resolved, h.profileId);
        } catch (err) {
          console.warn("[ipc] pushRecentWorkspace failed:", err);
        }
        try {
          terminal.disposeAll();
        } catch (err) {
          console.warn("[ipc] terminal.disposeAll failed:", err);
        }
        return {
          root: resolved,
          name: hostBasename(h.kind, resolved) || resolved,
          hostKind: h.kind,
          hostProfileId: h.profileId,
        };
      } catch (err) {
        console.error("[ipc] workspace:open failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("workspace:listDir", async (_evt, dirPath: string) => {
    try {
      return await host().listDir(dirPath);
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
        const h = host();
        const st = await h.stat(filePath);
        if (!st.isFile) {
          throw new HostError("failed", `Not a file: ${filePath}`);
        }
        if (st.size > MAX_READ_BYTES) {
          const text = await h.readFile(filePath);
          return {
            text: text.slice(0, MAX_READ_BYTES),
            size: st.size,
            truncated: true,
          };
        }
        const text = await h.readFile(filePath);
        return { text, size: st.size, truncated: false };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("workspace:stat", async (_evt, targetPath: string) => {
    try {
      return await host().stat(targetPath);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "workspace:findFiles",
    async (
      _evt,
      args?: { root?: string; maxFiles?: number },
    ): Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source: "git" | "walk";
    }> => {
      try {
        const h = host();
        const root =
          (args?.root && typeof args.root === "string" && args.root) ||
          h.workspaceRoot;
        if (!root) {
          throw new HostError("failed", "No workspace open");
        }
        return await findWorkspaceFiles(h, root, {
          maxFiles: args?.maxFiles,
        });
      } catch (err) {
        console.error("[ipc] workspace:findFiles failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:pickFile",
    async (): Promise<string | null> => {
      try {
        const h = host();
        if (h.kind !== "local") {
          // Remote/WSL: renderer open-by-path dialog handles free-form paths.
          throw new HostError(
            "failed",
            "Native file picker is only available for Local host",
          );
        }
        const win = getMainWindow();
        const options: Electron.OpenDialogOptions = {
          properties: ["openFile"],
          title: "Open File",
          buttonLabel: "Open",
          defaultPath: h.workspaceRoot ?? app.getPath("home") ?? undefined,
        };
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        return result.filePaths[0]!;
      } catch (err) {
        console.error("[ipc] workspace:pickFile failed:", err);
        rethrowIpc(err);
      }
    },
  );

  // ── history ────────────────────────────────────────
  ipcMain.handle(
    "history:discover",
    async (_evt, workspaceRoot: string) => {
      try {
        return await discoverRepos(host(), workspaceRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("history:loadLog", async (_evt, repoRoot: string) => {
    try {
      return await loadLog(host(), repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });
  ipcMain.handle(
    "history:compare",
    async (
      _evt,
      args: {
        repoRoot: string;
        base: string;
        head: string | "worktree";
      },
    ) => {
      try {
        if (args.head === "worktree") {
          return await compareToWorktree(host(), args.repoRoot, args.base);
        }
        return await compareCommits(
          host(),
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
          host(),
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

  ipcMain.handle(
    "history:status",
    async (_evt, repoRoot: string) => {
      try {
        return await loadRepoStatus(host(), repoRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:getRecentCompares",
    async (_evt, workspaceRoot: string): Promise<HistoryCompareEntry[]> => {
      try {
        return await getHistoryRecentCompares(workspaceRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:pushRecentCompare",
    async (
      _evt,
      args: { workspaceRoot: string; entry: HistoryCompareEntry },
    ): Promise<HistoryCompareEntry[]> => {
      try {
        return await pushHistoryRecentCompare(args.workspaceRoot, args.entry);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:removeRecentCompare",
    async (
      _evt,
      args: { workspaceRoot: string; id: string },
    ): Promise<HistoryCompareEntry[]> => {
      try {
        return await removeHistoryRecentCompare(args.workspaceRoot, args.id);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  // ── annotations ────────────────────────────────────
  ipcMain.handle(
    "annotations:locateGitRoot",
    async (_evt, filePath: string) => {
      try {
        return await locateGitRoot(host(), filePath);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("annotations:load", async (_evt, repoRoot: string) => {
    try {
      return await loadSessions(host(), repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("annotations:list", async (_evt, repoRoot: string) => {
    try {
      return await listSessionSummaries(host(), repoRoot);
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
        const repoRoot = typeof args === "string" ? args : args.repoRoot;
        const title = typeof args === "string" ? undefined : args.title;
        return await ensureActiveSession(host(), repoRoot, "local-user", title);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:addComment",
    async (_evt, input: AddCommentInput) => {
      try {
        return await addComment(host(), input);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:setStatus",
    async (
      _evt,
      args: {
        repoRoot: string;
        commentId: string;
        status: CommentStatus;
      },
    ) => {
      try {
        return await setCommentStatus(
          host(),
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
          host(),
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
          host(),
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
        return await deleteComment(host(), args.repoRoot, args.commentId);
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
        const repoRoot = typeof args === "string" ? args : args.repoRoot;
        const options =
          typeof args === "string"
            ? undefined
            : { export: args.export, sessionId: args.sessionId };
        return await endSession(host(), repoRoot, options);
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
        const repoRoot = typeof args === "string" ? args : args.repoRoot;
        const title = typeof args === "string" ? undefined : args.title;
        return await newSession(host(), repoRoot, "local-user", title);
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
        return await restoreSession(host(), args.repoRoot, args.sessionId);
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
        return await exportSession(host(), args.repoRoot, args.sessionId);
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
        const abs = await copyYamlPath(host(), repoRoot, sessionId);
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
      args: {
        cwd?: string;
        cols?: number;
        rows?: number;
        kind?: "shell" | "agent";
        command?: string;
        args?: string[];
        title?: string;
        agentId?: string;
      } = {},
    ) => {
      try {
        const h = host();
        const cwd =
          args.cwd ??
          h.workspaceRoot ??
          (h.kind === "local"
            ? process.env.HOME || process.env.USERPROFILE || process.cwd()
            : "/");
        return await terminal.create({
          cwd,
          cols: args.cols ?? 80,
          rows: args.rows ?? 24,
          kind: args.kind,
          command: args.command,
          args: args.args,
          title: args.title,
          agentId: args.agentId,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("terminal:list", async () => terminal.list());


  ipcMain.handle(
    "terminal:applyTitle",
    async (_evt, args: { id: string; title: string }) => {
      const info = terminal.applyDynamicTitle(args.id, args.title);
      if (!info) {
        throw new HostError("not_found", `Terminal not found: ${args.id}`);
      }
      return info;
    },
  );

  ipcMain.handle(
    "terminal:applyAgentTopic",
    async (_evt, args: { id: string; line: string }) => {
      const info = terminal.applyAgentTopicFromInput(args.id, args.line);
      if (!info) {
        throw new HostError("not_found", `Terminal not found: ${args.id}`);
      }
      return info;
    },
  );
  ipcMain.handle(
    "terminal:rename",
    async (_evt, args: { id: string; title: string }) => {
      const info = terminal.rename(args.id, args.title);
      if (!info) {
        throw new HostError("not_found", `Terminal not found: ${args.id}`);
      }
      return info;
    },
  );

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

  // ── agent CLI profiles ─────────────────────────────
  ipcMain.handle("agent:listProfiles", async () => {
    try {
      return await listAgentProfiles();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("agent:detect", async () => {
    try {
      return await detectAgentClis(host());
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "agent:saveProfiles",
    async (_evt, profiles: unknown) => {
      try {
        return await saveAgentProfiles(
          Array.isArray(profiles) ? (profiles as never) : [],
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "agent:upsertProfile",
    async (_evt, profile: unknown) => {
      try {
        if (!profile || typeof profile !== "object") {
          throw new HostError("failed", "Invalid agent profile");
        }
        return await upsertAgentProfile(profile as never);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("agent:getDefaultId", async () => {
    try {
      return await getDefaultAgentId();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "agent:setDefaultId",
    async (_evt, id: string | null | undefined) => {
      try {
        await setDefaultAgentId(id ?? undefined);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "agent:discoverLaunch",
    async (
      _evt,
      args: string | { profileId: string; force?: boolean },
    ) => {
      try {
        const profileId =
          typeof args === "string" ? args : args?.profileId;
        const force = typeof args === "string" ? false : !!args?.force;
        if (!profileId || typeof profileId !== "string") {
          throw new HostError("failed", "profileId required");
        }
        // force: discover bypasses memory/disk and rewrites settings.json.
        // Do not call clear() here — its async wipe races the write.
        return await discoverAgentLaunchOptions(host(), profileId, { force });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "agent:buildLaunchArgs",
    async (
      _evt,
      args: {
        profileId: string;
        model?: string;
        effort?: string;
        prompt?: string;
      },
    ) => {
      try {
        return buildAgentLaunchArgs(args.profileId, {
          model: args.model,
          effort: args.effort,
          prompt: args.prompt,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );
}
