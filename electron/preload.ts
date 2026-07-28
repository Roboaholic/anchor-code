import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type HostKind = "local" | "wsl" | "ssh";

export interface AppVersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  hostId: string;
  hostKind: HostKind;
}

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  canInstall: boolean;
  packaged: boolean;
  progress: number | null;
  message: string | null;
  error: string | null;
}

export interface HostInfo {
  id: string;
  kind: HostKind;
  profileId: string;
  workspaceRoot: string | null;
}

export interface HostProfile {
  id: string;
  kind: HostKind;
  label?: string;
  ssh?: {
    host: string;
    port?: number;
    username: string;
    privateKeyPath?: string;
  };
  wsl?: {
    distro?: string;
    user?: string;
  };
}


export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface StatResult {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface RecentWorkspace {
  path: string;
  hostProfileId: string;
  lastOpenedAt: string;
}

export interface ReadTextResult {
  text: string;
  size: number;
  truncated: boolean;
}

export interface RepoInfo {
  root: string;
  name: string;
}

export interface CommitRow {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  dateIso: string;
}

export interface DiffFile {
  path: string;
  status: string;
}

export interface DiffOpenPayload {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  title: string;
  files: DiffFile[];
}

export interface FileDiffContent {
  path: string;
  oldText: string;
  newText: string;
  status: string;
}

export type TerminalSessionKind = "shell" | "agent";
export type TerminalTitleSource = "default" | "user" | "inferred";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  kind: TerminalSessionKind;
  agentId?: string;
  titleSource?: TerminalTitleSource;
}

export interface AgentCliProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
  detected?: boolean;
  enabled?: boolean;
}

const anchor = {
  shell: {
    getVersion: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("shell:getVersion"),
    menuAction: (action: string): Promise<boolean> =>
      ipcRenderer.invoke("shell:menuAction", action),
    onCommand: (
      cb: (cmd: { type: string }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        cmd: { type: string },
      ) => cb(cmd);
      ipcRenderer.on("shell:command", listener);
      return () => ipcRenderer.removeListener("shell:command", listener);
    },
  },
  host: {
    getInfo: (): Promise<HostInfo> => ipcRenderer.invoke("host:getInfo"),
    listProfiles: (): Promise<HostProfile[]> =>
      ipcRenderer.invoke("host:listProfiles"),
    listWslDistros: (): Promise<string[]> =>
      ipcRenderer.invoke("host:listWslDistros"),
    wslHome: (args?: { distro?: string }): Promise<string> =>
      ipcRenderer.invoke("host:wslHome", args ?? {}),
    browseListDir: (args: {
      path: string;
      kind: "wsl" | "ssh";
      distro?: string;
    }): Promise<DirEntry[]> => ipcRenderer.invoke("host:browseListDir", args),
    useProfile: (
      profileId: string,
    ): Promise<{ id: string; kind: HostKind; profileId: string }> =>
      ipcRenderer.invoke("host:useProfile", profileId),
    upsertProfile: (profile: HostProfile): Promise<HostProfile[]> =>
      ipcRenderer.invoke("host:upsertProfile", profile),
  },
  clipboard: {
    writeText: (text: string): Promise<boolean> =>
      ipcRenderer.invoke("clipboard:writeText", text),
    readText: (): Promise<string> =>
      ipcRenderer.invoke("clipboard:readText"),
  },
  workspace: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:pickFolder"),
    pickFile: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:pickFile"),
    open: (
      pathOrArgs: string | { path: string; hostProfileId?: string },
    ): Promise<{
      root: string;
      name: string;
      hostKind: HostKind;
      hostProfileId: string;
    }> => ipcRenderer.invoke("workspace:open", pathOrArgs),
    getRecent: (): Promise<RecentWorkspace[]> =>
      ipcRenderer.invoke("workspace:getRecent"),
    listDir: (path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke("workspace:listDir", path),
    readText: (path: string): Promise<ReadTextResult> =>
      ipcRenderer.invoke("workspace:readText", path),
    stat: (path: string): Promise<StatResult> =>
      ipcRenderer.invoke("workspace:stat", path),
    findFiles: (args?: {
      root?: string;
      maxFiles?: number;
    }): Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source?: "git" | "walk";
    }> => ipcRenderer.invoke("workspace:findFiles", args ?? {}),
    searchContent: (args: {
      root?: string;
      query: string;
      maxResults?: number;
      caseSensitive?: boolean;
      useRegex?: boolean;
      include?: string | string[];
      exclude?: string | string[];
      requestId?: string;
    }): Promise<{
      root: string;
      query: string;
      hits: { path: string; line: number; text: string }[];
      truncated: boolean;
      source: "git-grep" | "rg" | "scan";
      requestId: string;
    }> => ipcRenderer.invoke("workspace:searchContent", args),
    /** Progressive search hits (same requestId as searchContent). */
    onSearchHits: (
      cb: (payload: {
        requestId: string;
        hits: { path: string; line: number; text: string }[];
      }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: {
          requestId: string;
          hits: { path: string; line: number; text: string }[];
        },
      ) => cb(payload);
      ipcRenderer.on("workspace:searchContent:hits", listener);
      return () =>
        ipcRenderer.removeListener("workspace:searchContent:hits", listener);
    },
    onSearchMeta: (
      cb: (payload: {
        requestId: string;
        source: "git-grep" | "rg" | "scan";
      }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: {
          requestId: string;
          source: "git-grep" | "rg" | "scan";
        },
      ) => cb(payload);
      ipcRenderer.on("workspace:searchContent:meta", listener);
      return () =>
        ipcRenderer.removeListener("workspace:searchContent:meta", listener);
    },
  },
  history: {
    discover: (workspaceRoot: string): Promise<RepoInfo[]> =>
      ipcRenderer.invoke("history:discover", workspaceRoot),
    loadLog: (repoRoot: string): Promise<CommitRow[]> =>
      ipcRenderer.invoke("history:loadLog", repoRoot),
    status: (repoRoot: string): Promise<{
      repoRoot: string;
      entries: { path: string; status: string; code: string }[];
      modified: number;
      added: number;
      deleted: number;
      untracked: number;
      branch: string | null;
      ahead: number | null;
      behind: number | null;
    }> => ipcRenderer.invoke("history:status", repoRoot),
    listBranches: (
      repoRoot: string,
    ): Promise<Array<{ name: string; current: boolean }>> =>
      ipcRenderer.invoke("history:listBranches", repoRoot),
    checkout: (args: {
      repoRoot: string;
      branch: string;
    }): Promise<{ branch: string }> =>
      ipcRenderer.invoke("history:checkout", args),
    commit: (args: {
      repoRoot: string;
      message: string;
    }): Promise<{ hash: string; shortHash: string; subject: string }> =>
      ipcRenderer.invoke("history:commit", args),
    compare: (args: {
      repoRoot: string;
      base: string;
      head: string | "worktree";
    }): Promise<DiffOpenPayload> => ipcRenderer.invoke("history:compare", args),
    getFileDiff: (args: {
      repoRoot: string;
      base: string;
      head: string | "worktree";
      path: string;
      status: string;
    }): Promise<FileDiffContent> =>
      ipcRenderer.invoke("history:getFileDiff", args),
    getRecentCompares: (workspaceRoot: string) =>
      ipcRenderer.invoke("history:getRecentCompares", workspaceRoot),
    pushRecentCompare: (args: {
      workspaceRoot: string;
      entry: {
        id: string;
        repoRoot: string;
        repoName: string;
        base: string;
        head: string | "worktree";
        label: string;
        createdAt: string;
      };
    }) => ipcRenderer.invoke("history:pushRecentCompare", args),
    removeRecentCompare: (args: { workspaceRoot: string; id: string }) =>
      ipcRenderer.invoke("history:removeRecentCompare", args),
  },
  annotations: {
    locateGitRoot: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke("annotations:locateGitRoot", filePath),
    load: (
      repoRoot: string,
    ): Promise<{ sessions: unknown[]; error?: string }> =>
      ipcRenderer.invoke("annotations:load", repoRoot),
    list: (
      repoRoot: string,
    ): Promise<{ sessions: unknown[]; error?: string }> =>
      ipcRenderer.invoke("annotations:list", repoRoot),
    ensureActive: (
      args: string | { repoRoot: string; title?: string },
    ): Promise<unknown> =>
      ipcRenderer.invoke("annotations:ensureActive", args),
    addComment: (input: unknown): Promise<unknown> =>
      ipcRenderer.invoke("annotations:addComment", input),
    setStatus: (args: {
      repoRoot: string;
      commentId: string;
      status: string;
    }): Promise<unknown> => ipcRenderer.invoke("annotations:setStatus", args),
    reply: (args: {
      repoRoot: string;
      commentId: string;
      body: string;
    }): Promise<unknown> => ipcRenderer.invoke("annotations:reply", args),
    editComment: (args: {
      repoRoot: string;
      commentId: string;
      body: string;
      messageId?: string;
    }): Promise<unknown> =>
      ipcRenderer.invoke("annotations:editComment", args),
    deleteComment: (args: {
      repoRoot: string;
      commentId: string;
    }): Promise<unknown> =>
      ipcRenderer.invoke("annotations:deleteComment", args),
    endSession: (
      args: string | { repoRoot: string; sessionId?: string; export?: boolean },
    ): Promise<unknown> => ipcRenderer.invoke("annotations:endSession", args),
    newSession: (
      args: string | { repoRoot: string; title?: string },
    ): Promise<unknown> => ipcRenderer.invoke("annotations:newSession", args),
    restoreSession: (args: {
      repoRoot: string;
      sessionId: string;
    }): Promise<unknown> =>
      ipcRenderer.invoke("annotations:restoreSession", args),
    exportSession: (args: {
      repoRoot: string;
      sessionId?: string;
    }): Promise<{ exportPath: string; payload: unknown }> =>
      ipcRenderer.invoke("annotations:exportSession", args),
    copyYamlPath: (
      args: string | { repoRoot: string; sessionId?: string },
    ): Promise<string> =>
      ipcRenderer.invoke("annotations:copyYamlPath", args),
  },
  terminal: {
    create: (args?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      kind?: TerminalSessionKind;
      command?: string;
      args?: string[];
      title?: string;
      agentId?: string;
    }): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:create", args ?? {}),
    list: (): Promise<TerminalTabInfo[]> => ipcRenderer.invoke("terminal:list"),
    rename: (id: string, title: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:rename", { id, title }),
    applyTitle: (id: string, title: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:applyTitle", { id, title }),
    applyAgentTopic: (id: string, line: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:applyAgentTopic", { id, line }),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
    kill: (id: string): Promise<void> =>
      ipcRenderer.invoke("terminal:kill", id),
    disposeAll: (): Promise<void> => ipcRenderer.invoke("terminal:disposeAll"),
    onData: (cb: (payload: { id: string; data: string }) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; data: string },
      ) => cb(payload);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onTitle: (
      cb: (payload: { id: string; info: TerminalTabInfo }) => void,
    ) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; info: TerminalTabInfo },
      ) => cb(payload);
      ipcRenderer.on("terminal:title", listener);
      return () => ipcRenderer.removeListener("terminal:title", listener);
    },
    onExit: (
      cb: (payload: {
        id: string;
        exitCode: number;
        kind?: TerminalSessionKind;
      }) => void,
    ) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: {
          id: string;
          exitCode: number;
          kind?: TerminalSessionKind;
        },
      ) => cb(payload);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },
  settings: {
    getTheme: (): Promise<"light" | "light-modern" | "dark" | "dark-modern"> =>
      ipcRenderer.invoke("settings:getTheme"),
    setTheme: (
      theme: "light" | "light-modern" | "dark" | "dark-modern",
    ): Promise<"light" | "light-modern" | "dark" | "dark-modern"> =>
      ipcRenderer.invoke("settings:setTheme", theme),
    getSessionTabLayout: (): Promise<"side" | "top"> =>
      ipcRenderer.invoke("settings:getSessionTabLayout"),
    setSessionTabLayout: (
      layout: "side" | "top",
    ): Promise<"side" | "top"> =>
      ipcRenderer.invoke("settings:setSessionTabLayout", layout),
    getWorkspaceFilter: (args: {
      workspaceRoot: string;
      hostProfileId?: string | null;
    }): Promise<{ excludes: string[] }> =>
      ipcRenderer.invoke("settings:getWorkspaceFilter", args),
    setWorkspaceFilter: (args: {
      workspaceRoot: string;
      hostProfileId?: string | null;
      excludes: string[];
    }): Promise<{ excludes: string[] }> =>
      ipcRenderer.invoke("settings:setWorkspaceFilter", args),
  },
  updates: {
    getState: (): Promise<AppUpdateState> =>
      ipcRenderer.invoke("app:getUpdateState"),
    check: (): Promise<AppUpdateState> =>
      ipcRenderer.invoke("app:checkForUpdates"),
    download: (): Promise<AppUpdateState> =>
      ipcRenderer.invoke("app:downloadUpdate"),
    install: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("app:installUpdate"),
    openReleasePage: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("app:openReleasePage"),
    onState: (cb: (state: AppUpdateState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: AppUpdateState) =>
        cb(state);
      ipcRenderer.on("app:updateState", listener);
      return () => ipcRenderer.removeListener("app:updateState", listener);
    },
  },
  agent: {
    listProfiles: (): Promise<AgentCliProfile[]> =>
      ipcRenderer.invoke("agent:listProfiles"),
    detect: (): Promise<AgentCliProfile[]> =>
      ipcRenderer.invoke("agent:detect"),
    saveProfiles: (profiles: AgentCliProfile[]): Promise<AgentCliProfile[]> =>
      ipcRenderer.invoke("agent:saveProfiles", profiles),
    upsertProfile: (profile: AgentCliProfile): Promise<AgentCliProfile[]> =>
      ipcRenderer.invoke("agent:upsertProfile", profile),
    getDefaultId: (): Promise<string | undefined> =>
      ipcRenderer.invoke("agent:getDefaultId"),
    setDefaultId: (id: string | null | undefined): Promise<void> =>
      ipcRenderer.invoke("agent:setDefaultId", id),
    discoverLaunch: (
      profileId: string | { profileId: string; force?: boolean },
    ) =>
      ipcRenderer.invoke(
        "agent:discoverLaunch",
        typeof profileId === "string"
          ? { profileId, force: false }
          : profileId,
      ),
    buildLaunchArgs: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
    }) => ipcRenderer.invoke("agent:buildLaunchArgs", args),
  },
};

contextBridge.exposeInMainWorld("anchor", anchor);

export type AnchorApi = typeof anchor;
