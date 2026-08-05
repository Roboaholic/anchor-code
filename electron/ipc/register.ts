import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { applyWindowChromeTheme } from "../windowChrome.js";
import { createHostForProfile, type HostManager } from "../host/hostManager.js";
import type { RelayConnector } from "../remote/relayConnector.js";
import type { AnchorApplication } from "../application/anchorApplication.js";
import { WslHostSession, listWslDistros } from "../host/wslHost.js";
import {
  hostJoin,
  hostNormalize,
} from "../host/paths.js";
import { HostError, type HostSession } from "../host/types.js";
import {
  type AddCommentInput,
  type CommentStatus,
} from "../services/annotationsService.js";
import type { RepoStatus } from "../services/historyService.js";
import { TerminalService } from "../services/terminalService.js";
import { FileWatcherService } from "../services/fileWatcherService.js";
import {
  getSkillInstallStatus,
  installSkill,
  installSkillToWorkspace,
  isWorkspaceSkillInstalled,
} from "../services/skillInstall.js";
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getUpdateState,
  installAppUpdate,
  openReleasePage,
} from "../services/appUpdate.js";
import {
  getHistoryRecentCompares,
  getFontSize,
  getHostProfile,
  getWorkspaceFilter,
  getSessionTabLayout,
  getUiTheme,
  loadSettings,
  normalizeFontSize,
  normalizeSessionTabLayout,
  normalizeTheme,
  pushHistoryRecentCompare,
  removeHistoryRecentCompare,
  setFontSize,
  setSessionTabLayout,
  setUiTheme,
  setWorkspaceFilter,
  getRemoteAccessConfig,
  setRemoteAccessConfig,
  upsertHostProfile,
  type HistoryCompareEntry,
  type HostProfile,
  type RecentWorkspace,
  type SessionTabLayout,
  type UiTheme,
  type WorkspaceFilter,
} from "../settings.js";

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
  fileWatcher: FileWatcherService;
    application: AnchorApplication;
    relay: RelayConnector;
}): void {
  const {
    hosts,
    getMainWindow,
    appVersion,
    terminal,
    fileWatcher,
    application,
    relay,
  } = opts;

  const host = () => hosts.session;
  const browseSessions = new Map<string, HostSession>();

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

  ipcMain.handle("remote:getInfo", async () => {
    const config = await getRemoteAccessConfig();
    return { enabled: config.enabled, relay: relay.info() };
  });

  ipcMain.handle(
    "remote:update",
    async (
      _evt,
      value: Partial<{
        enabled: boolean;
      }>,
    ) => {
      const config = await setRemoteAccessConfig(value ?? {});
      relay.start(config.relay!);
      return { enabled: config.enabled, relay: relay.info() };
    },
  );

  ipcMain.handle("remote:revokeDevice", async (_evt, peerId: string) => {
    relay.revokeDevice(peerId);
    const config = await getRemoteAccessConfig();
    return { enabled: config.enabled, relay: relay.info() };
  });

  ipcMain.handle("remote:approveDevice", async (_evt, peerId: string) => {
    relay.approveDevice(peerId);
    const config = await getRemoteAccessConfig();
    return { enabled: config.enabled, relay: relay.info() };
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
        win?.webContents.send("shell:command", { type: "resetFontSize" });
        return true;
      case "zoomIn":
        win?.webContents.send("shell:command", { type: "increaseFontSize" });
        return true;
      case "zoomOut":
        win?.webContents.send("shell:command", { type: "decreaseFontSize" });
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
    return application.workspace.hostInfo();
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
      args: {
        path: string;
        kind?: "wsl" | "ssh";
        distro?: string;
        profileId?: string;
      },
    ) => {
      try {
        if (!args?.path || typeof args.path !== "string") {
          throw new HostError("failed", "Invalid browse path");
        }
        const kind = args.kind ?? (args.profileId ? "ssh" : undefined);
        if (kind === "wsl") {
          const session = new WslHostSession({
            profileId: "wsl-browse",
            distro: args.distro,
          });
          try {
            return await session.listDir(args.path);
          } finally {
            await session.dispose();
          }
        }
        if (kind !== "ssh" || !args.profileId) {
          throw new HostError("failed", "SSH browse requires profileId");
        }
        const profile = await getHostProfile(args.profileId);
        if (!profile) {
          throw new HostError("not_found", `Host profile not found: ${args.profileId}`);
        }
        if (profile.kind !== "ssh") {
          throw new HostError("failed", "Host profile is not an SSH profile");
        }
        let session = browseSessions.get(profile.id);
        if (!session) {
          session = createHostForProfile(profile);
          browseSessions.set(profile.id, session);
        }
        return await session.listDir(args.path);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("host:testProfile", async (_evt, profileId: string) => {
    try {
      if (!profileId || typeof profileId !== "string") {
        throw new HostError("failed", "profileId required");
      }
      const profile = await getHostProfile(profileId);
      if (!profile) throw new HostError("not_found", `Host profile not found: ${profileId}`);
      if (profile.kind !== "ssh") throw new HostError("failed", "Host profile is not an SSH profile");
      const session = createHostForProfile(profile);
      try {
        await session.run("/", "true", []);
        return { ok: true };
      } finally {
        await session.dispose();
      }
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "host:useProfile",
    async (_evt, profileId: string): Promise<{ id: string; kind: string; profileId: string }> => {
      try {
        const profile = await getHostProfile(profileId);
        if (!profile) {
          throw new HostError("not_found", `Host profile not found: ${profileId}`);
        }
        terminal.disposeAll();
        fileWatcher.stop();
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

  ipcMain.handle("clipboard:readText", async () => {
    return clipboard.readText() ?? "";
  });

  // ── app updates ────────────────────────────────────
  ipcMain.handle("app:getUpdateState", async () => getUpdateState());
  ipcMain.handle("app:checkForUpdates", async () => {
    try {
      return await checkForAppUpdates();
    } catch (err) {
      rethrowIpc(err);
    }
  });
  ipcMain.handle("app:downloadUpdate", async () => {
    try {
      return await downloadAppUpdate();
    } catch (err) {
      rethrowIpc(err);
    }
  });
  ipcMain.handle("app:installUpdate", async () => installAppUpdate());
  ipcMain.handle("app:openReleasePage", async () => {
    try {
      return await openReleasePage();
    } catch (err) {
      rethrowIpc(err);
    }
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

  ipcMain.handle(
    "settings:getSessionTabLayout",
    async (): Promise<SessionTabLayout> => {
      try {
        return await getSessionTabLayout();
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "settings:setSessionTabLayout",
    async (_evt, layout: unknown): Promise<SessionTabLayout> => {
      try {
        return await setSessionTabLayout(normalizeSessionTabLayout(layout));
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("settings:getFontSize", async (): Promise<number> => {
    try {
      return await getFontSize();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "settings:setFontSize",
    async (_evt, fontSize: unknown): Promise<number> => {
      try {
        return await setFontSize(normalizeFontSize(fontSize));
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "settings:getWorkspaceFilter",
    async (
      _evt,
      args: { workspaceRoot: string; hostProfileId?: string | null },
    ): Promise<WorkspaceFilter> => {
      try {
        return await getWorkspaceFilter(args.workspaceRoot, args.hostProfileId);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "settings:setWorkspaceFilter",
    async (
      _evt,
      args: {
        workspaceRoot: string;
        hostProfileId?: string | null;
        excludes: string[];
      },
    ): Promise<WorkspaceFilter> => {
      try {
        return await setWorkspaceFilter(
          args.workspaceRoot,
          args.hostProfileId,
          { excludes: args.excludes ?? [] },
        );
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
        const h = application.workspace.hostInfo();
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
          typeof args === "string" ? hosts.profileId : args.hostProfileId ?? hosts.profileId;

        if (!dirPath || typeof dirPath !== "string") {
          throw new HostError("failed", "Invalid workspace path");
        }

        fileWatcher.stop();
        return await application.workspace.open({
          path: dirPath,
          hostProfileId: requestedProfileId,
        });
      } catch (err) {
        console.error("[ipc] workspace:open failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("workspace:listDir", async (_evt, dirPath: string) => {
    try {
      return await application.workspace.listDir(dirPath);
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
        const result = await application.review.readFile(filePath);
        return { text: result.text, size: result.size, truncated: result.truncated };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("workspace:stat", async (_evt, targetPath: string) => {
    try {
      return await application.workspace.stat(targetPath);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  // ── file watcher (auto-refresh) ───────────────────
  ipcMain.handle("fileWatcher:start", async (_evt, root?: string) => {
    try {
      const h = host();
      const target = root ?? h.workspaceRoot;
      if (!target) throw new HostError("failed", "No workspace open");
      fileWatcher.start(target);
      return { ok: true };
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("fileWatcher:stop", async () => {
    fileWatcher.stop();
    return { ok: true };
  });

  // ── file operations (delete / rename / copy / new entry) ──────────
  ipcMain.handle("workspace:delete", async (_evt, args: { path: string }) => {
    try {
      const h = host();
      const p = hostNormalize(h.kind, args.path);
      await h.remove(p);
      return { ok: true };
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "workspace:rename",
    async (_evt, args: { oldPath: string; newPath: string }) => {
      try {
        const h = host();
        await h.rename(
          hostNormalize(h.kind, args.oldPath),
          hostNormalize(h.kind, args.newPath),
        );
        return { ok: true };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:copy",
    async (_evt, args: { src: string; dst: string }) => {
      try {
        const h = host();
        await h.copyPath(
          hostNormalize(h.kind, args.src),
          hostNormalize(h.kind, args.dst),
        );
        return { ok: true };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:newEntry",
    async (
      _evt,
      args: { parentDir: string; name: string; type: "file" | "dir" },
    ) => {
      try {
        const h = host();
        const parent = hostNormalize(h.kind, args.parentDir);
        const name = args.name.trim();
        if (!name) throw new HostError("failed", "Name is empty");
        const target = hostJoin(h.kind, parent, name);
        if (args.type === "dir") {
          await h.mkdirp(target);
        } else {
          // Empty file; create parent first for nested paths.
          await h.mkdirp(parent);
          await h.writeFile(target, "");
        }
        return { ok: true, path: target };
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:findFiles",
    async (
      _evt,
      args?: { root?: string; maxFiles?: number; query?: string },
    ): Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source: "git" | "walk" | "multi-git";
    }> => {
      try {
        const root =
          (args?.root && typeof args.root === "string" && args.root) ||
          application.workspace.active()?.path;
        if (!root) {
          throw new HostError("failed", "No workspace open");
        }
        return await application.review.fileIndex(args?.maxFiles, root, args?.query);
      } catch (err) {
        console.error("[ipc] workspace:findFiles failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:searchContent",
    async (
      evt,
      args?: {
        root?: string;
        query?: string;
        maxResults?: number;
        caseSensitive?: boolean;
        useRegex?: boolean;
        include?: string | string[];
        exclude?: string | string[];
        /** Correlates progressive hit events with this request. */
        requestId?: string;
      },
    ) => {
      try {
        const root =
          (args?.root && typeof args.root === "string" && args.root) ||
          application.workspace.active()?.path;
        if (!root) {
          throw new HostError("failed", "No workspace open");
        }
        const query = typeof args?.query === "string" ? args.query : "";
        const requestId =
          typeof args?.requestId === "string" && args.requestId
            ? args.requestId
            : `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await application.review.search(query, {
          maxResults: args?.maxResults,
          caseSensitive: args?.caseSensitive,
          useRegex: args?.useRegex,
          include: args?.include,
          exclude: args?.exclude,
          onHits: (hits) => {
            try {
              evt.sender.send("workspace:searchContent:hits", {
                requestId,
                hits,
              });
            } catch {
              // window closed
            }
          },
          onSource: (source) => {
            try {
              evt.sender.send("workspace:searchContent:meta", {
                requestId,
                source,
              });
            } catch {
              // ignore
            }
          },
        }, root);
        return { ...result, requestId };
      } catch (err) {
        console.error("[ipc] workspace:searchContent failed:", err);
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "workspace:pickFile",
    async (): Promise<string | null> => {
      try {
        const h = application.workspace.hostInfo();
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
        return await application.review.repos(workspaceRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("history:loadLog", async (_evt, repoRoot: string) => {
    try {
      return await application.review.log(repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });
  ipcMain.handle(
    "history:fileBlame",
    async (
      _evt,
      args: { repoRoot: string; filePath: string; revision?: string },
    ) => {
      try {
        return await application.review.blame(
          args.repoRoot,
          args.filePath,
          args.revision,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );
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
        return await application.review.compare(args.repoRoot, args.base, args.head);
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
        return await application.review.fileDiff(args);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:status",
    async (
      _evt,
      repoRoot: string,
      opts?: { badgeOnly?: boolean },
    ) => {
      try {
        return await application.review.status(repoRoot, opts);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:statusBulk",
    async (
      evt,
      args: { repoRoots: string[]; badgeOnly?: boolean },
    ) => {
      try {
        const roots = Array.isArray(args?.repoRoots) ? args.repoRoots : [];
        return await application.review.statusBulk(roots, {
          badgeOnly: args?.badgeOnly !== false,
          onStatus: (status: RepoStatus) => {
            try {
              evt.sender.send("history:statusBulk:one", status);
            } catch {
              // window gone
            }
          },
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:listBranches",
    async (_evt, repoRoot: string) => {
      try {
        return await application.review.branches(repoRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:checkout",
    async (
      _evt,
      args: { repoRoot: string; branch: string },
    ) => {
      try {
        return await application.review.checkout(args.repoRoot, args.branch);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "history:commit",
    async (
      _evt,
      args: { repoRoot: string; message: string; paths?: string[] },
    ) => {
      try {
        return await application.review.commit(
          args.repoRoot,
          args.message,
          args.paths,
        );
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
        return await application.comments.locateRoot(filePath);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("annotations:load", async (_evt, repoRoot: string) => {
    try {
      return await application.comments.list(repoRoot);
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("annotations:list", async (_evt, repoRoot: string) => {
    try {
      return await application.comments.summaries(repoRoot);
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
        return await application.comments.ensureSession(repoRoot, title, "local-user");
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "annotations:addComment",
    async (_evt, input: AddCommentInput) => {
      try {
        return await application.comments.add(input);
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
        return await application.comments.setStatus(
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
        return await application.comments.reply(
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
        return await application.comments.edit(
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
        return await application.comments.remove(args.repoRoot, args.commentId);
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
        return await application.comments.end(repoRoot, {
          export: options?.export !== false,
          sessionId: options?.sessionId,
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
        const repoRoot = typeof args === "string" ? args : args.repoRoot;
        const title = typeof args === "string" ? undefined : args.title;
        return await application.comments.create(repoRoot, title, "local-user");
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
        return await application.comments.restore(args.repoRoot, args.sessionId);
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
        return await application.comments.export(args.repoRoot, args.sessionId);
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
        const abs = await application.comments.yamlPath(repoRoot, sessionId);
        clipboard.writeText(abs);
        if (clipboard.readText() !== abs) {
          throw new Error("Failed to verify the YAML path in the system clipboard");
        }
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
        agentSessionId?: string;
      } = {},
    ) => {
      try {
        const h = application.workspace.hostInfo();
        const cwd =
          args.cwd ??
          h.workspaceRoot ??
          (h.kind === "local"
            ? process.env.HOME || process.env.USERPROFILE || process.cwd()
            : "/");
        return await application.terminal.create({
          cwd,
          cols: args.cols ?? 80,
          rows: args.rows ?? 24,
          kind: args.kind,
          command: args.command,
          args: args.args,
          title: args.title,
          agentId: args.agentId,
          agentSessionId: args.agentSessionId,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("terminal:list", async () => application.terminal.list());
  ipcMain.handle("terminal:snapshot", async (_evt, id: string) => {
    const { data, seq } = application.terminal.snapshot(id);
    return { data, seq };
  });

  ipcMain.handle(
    "terminal:applyTitle",
    async (_evt, args: { id: string; title: string }) => {
      return application.terminal.applyTitle(args.id, args.title);
    },
  );

  ipcMain.handle(
    "terminal:applyAgentTopic",
    async (_evt, args: { id: string; line: string }) => {
      return application.terminal.applyAgentTopic(args.id, args.line);
    },
  );
  ipcMain.handle(
    "terminal:rename",
    async (_evt, args: { id: string; title: string }) => {
      return application.terminal.rename(args.id, args.title);
    },
  );
  ipcMain.handle(
    "terminal:applyAgentTitle",
    async (_evt, args: { id: string; title: string }) =>
      application.terminal.applyAgentTitle(args.id, args.title),
  );

  ipcMain.handle(
    "terminal:write",
    async (_evt, args: { id: string; data: string }) => {
      application.terminal.write(args.id, args.data);
    },
  );

  ipcMain.handle(
    "terminal:resize",
    async (_evt, args: { id: string; cols: number; rows: number }) => {
      application.terminal.resize(args.id, args.cols, args.rows);
    },
  );

  ipcMain.handle("terminal:kill", async (_evt, id: string) => {
    application.terminal.remove(id);
  });

  ipcMain.handle("terminal:disposeAll", async () => {
    application.terminal.disposeAll();
  });

  // ── agent CLI profiles ─────────────────────────────
  ipcMain.handle("agent:listProfiles", async () => {
    try {
      return await application.agent.profiles();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle("agent:detect", async () => {
    try {
      return await application.agent.detect();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "agent:saveProfiles",
    async (_evt, profiles: unknown) => {
      try {
        return await application.agent.saveProfiles(
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
        return await application.agent.upsertProfile(profile as never);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle("agent:getDefaultId", async () => {
    try {
      return await application.agent.defaultId();
    } catch (err) {
      rethrowIpc(err);
    }
  });

  ipcMain.handle(
    "agent:setDefaultId",
    async (_evt, id: string | null | undefined) => {
      try {
        await application.agent.setDefaultId(id ?? undefined);
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
        return await application.agent.launchOptions(profileId, { force });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "agent:createSession",
    async (
      _evt,
      args: {
        profileId: string;
        model?: string;
        effort?: string;
        prompt?: string;
        resume?: boolean;
        sessionId?: string;
        cols?: number;
        rows?: number;
      },
    ) => {
      try {
        return await application.agent.createSession(args);
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
        return application.agent.buildLaunchArgs(args.profileId, {
          model: args.model,
          effort: args.effort,
          prompt: args.prompt,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "skill:status",
    async (
      _evt,
      args?: { workspaceRoot?: string | null },
    ) => {
      try {
        return await getSkillInstallStatus(
          host(),
          args?.workspaceRoot ?? host().workspaceRoot,
        );
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "skill:install",
    async (
      _evt,
      args?: {
        workspaceRoot?: string | null;
        targetIds?: string[];
      },
    ) => {
      try {
        return await installSkill(host(), {
          workspaceRoot: args?.workspaceRoot ?? host().workspaceRoot,
          targetIds: args?.targetIds,
        });
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "skill:installWorkspace",
    async (_evt, workspaceRoot: string) => {
      try {
        if (!workspaceRoot || typeof workspaceRoot !== "string") {
          throw new HostError("failed", "workspaceRoot required");
        }
        return await installSkillToWorkspace(host(), workspaceRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );

  ipcMain.handle(
    "skill:isWorkspaceInstalled",
    async (_evt, workspaceRoot: string) => {
      try {
        if (!workspaceRoot || typeof workspaceRoot !== "string") {
          return false;
        }
        return await isWorkspaceSkillInstalled(host(), workspaceRoot);
      } catch (err) {
        rethrowIpc(err);
      }
    },
  );
}
