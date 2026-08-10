import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";

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

export interface RemoteAccessInfo {
  enabled: boolean;
  relay: {
    enabled: boolean;
    state: "disabled" | "connecting" | "online" | "offline";
    url: string;
    roomId: string;
    hostPeerId: string;
    connectedGuests: number;
    devices: Array<{ peerId: string; online: boolean }>;
    pendingDevices: string[];
    error?: string;
    pairing?: {
      v: 1;
      type: "anchor-code-relay";
      relayUrl: string;
      roomId: string;
      hostPeerId: string;
      ticket: string;
      secret: string;
      expiresAt: string;
    };
  };
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
    knownHostsPolicy?: "accept-new" | "strict" | "ignore";
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

export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  dateIso: string;
  subject: string;
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
  agentSessionId?: string;
  titleSource?: TerminalTitleSource;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
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
      cb: (cmd: { type: string; path?: string; hostProfileId?: string }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        cmd: { type: string; path?: string; hostProfileId?: string },
      ) => cb(cmd);
      ipcRenderer.on("shell:command", listener);
      return () => ipcRenderer.removeListener("shell:command", listener);
    },
  },
  remote: {
    getInfo: (): Promise<RemoteAccessInfo> =>
      ipcRenderer.invoke("remote:getInfo"),
    update: (value: Partial<{
      enabled: boolean;
    }>): Promise<RemoteAccessInfo> =>
      ipcRenderer.invoke("remote:update", value),
    revokeDevice: (peerId: string): Promise<RemoteAccessInfo> =>
      ipcRenderer.invoke("remote:revokeDevice", peerId),
    approveDevice: (peerId: string): Promise<RemoteAccessInfo> =>
      ipcRenderer.invoke("remote:approveDevice", peerId),
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
      kind?: "wsl" | "ssh";
      distro?: string;
      profileId?: string;
    }): Promise<DirEntry[]> => ipcRenderer.invoke("host:browseListDir", args),
    testProfile: (profileId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke("host:testProfile", profileId),
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
    hasImage: (): Promise<boolean> =>
      ipcRenderer.invoke("clipboard:hasImage"),
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
      query?: string;
    }): Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source?: "git" | "walk" | "multi-git";
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
    /** Start watching the workspace root for file changes (local hosts only). */
    watchStart: (root?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("fileWatcher:start", root),
    watchStop: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("fileWatcher:stop"),
    /** A directory's contents changed (debounced by the main process). */
    onFileChange: (
      cb: (payload: { dir: string }) => void,
    ): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: { dir: string }) =>
        cb(payload);
      ipcRenderer.on("fileWatcher:change", listener);
      return () => ipcRenderer.removeListener("fileWatcher:change", listener);
    },
    deletePath: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace:delete", { path }),
    renamePath: (
      oldPath: string,
      newPath: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace:rename", { oldPath, newPath }),
    copyPath: (src: string, dst: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace:copy", { src, dst }),
    createEntry: (
      parentDir: string,
      name: string,
      type: "file" | "dir",
    ): Promise<{ ok: boolean; path?: string }> =>
      ipcRenderer.invoke("workspace:newEntry", { parentDir, name, type }),
  },
  history: {
    discover: (workspaceRoot: string): Promise<RepoInfo[]> =>
      ipcRenderer.invoke("history:discover", workspaceRoot),
    loadLog: (repoRoot: string): Promise<CommitRow[]> =>
      ipcRenderer.invoke("history:loadLog", repoRoot),
    fileBlame: (args: {
      repoRoot: string;
      filePath: string;
      revision?: string;
    }): Promise<BlameLine[]> => ipcRenderer.invoke("history:fileBlame", args),
    status: (
      repoRoot: string,
      opts?: { badgeOnly?: boolean },
    ): Promise<{
      repoRoot: string;
      entries: { path: string; status: string; code: string }[];
      modified: number;
      added: number;
      deleted: number;
      untracked: number;
      branch: string | null;
      ahead: number | null;
      behind: number | null;
    }> => ipcRenderer.invoke("history:status", repoRoot, opts),
    statusBulk: (args: {
      repoRoots: string[];
      badgeOnly?: boolean;
    }): Promise<
      Array<{
        repoRoot: string;
        entries: { path: string; status: string; code: string }[];
        modified: number;
        added: number;
        deleted: number;
        untracked: number;
        branch: string | null;
        ahead: number | null;
        behind: number | null;
      }>
    > => ipcRenderer.invoke("history:statusBulk", args),
    onStatusBulkOne: (
      cb: (status: {
        repoRoot: string;
        entries: { path: string; status: string; code: string }[];
        modified: number;
        added: number;
        deleted: number;
        untracked: number;
        branch: string | null;
        ahead: number | null;
        behind: number | null;
      }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        status: {
          repoRoot: string;
          entries: { path: string; status: string; code: string }[];
          modified: number;
          added: number;
          deleted: number;
          untracked: number;
          branch: string | null;
          ahead: number | null;
          behind: number | null;
        },
      ) => cb(status);
      ipcRenderer.on("history:statusBulk:one", listener);
      return () =>
        ipcRenderer.removeListener("history:statusBulk:one", listener);
    },
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
      paths?: string[];
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
      agentSessionId?: string;
    }): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:create", args ?? {}),
    list: (): Promise<TerminalTabInfo[]> => ipcRenderer.invoke("terminal:list"),
    snapshot: (id: string): Promise<{ data: string; seq: number }> =>
      ipcRenderer.invoke("terminal:snapshot", id),
    rename: (id: string, title: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:rename", { id, title }),
    applyTitle: (id: string, title: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:applyTitle", { id, title }),
    applyAgentTitle: (id: string, title: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:applyAgentTitle", { id, title }),
    applyAgentTopic: (id: string, line: string): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:applyAgentTopic", { id, line }),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
    kill: (id: string): Promise<void> =>
      ipcRenderer.invoke("terminal:kill", id),
    disposeAll: (): Promise<void> => ipcRenderer.invoke("terminal:disposeAll"),
    onData: (cb: (payload: { id: string; data: string; seq: number }) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; data: string; seq: number },
      ) => cb(payload);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onCreated: (cb: (payload: { info: TerminalTabInfo }) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { info: TerminalTabInfo },
      ) => cb(payload);
      ipcRenderer.on("terminal:created", listener);
      return () => ipcRenderer.removeListener("terminal:created", listener);
    },
    onUpdated: (cb: (payload: { info: TerminalTabInfo }) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { info: TerminalTabInfo },
      ) => cb(payload);
      ipcRenderer.on("terminal:updated", listener);
      return () => ipcRenderer.removeListener("terminal:updated", listener);
    },
    onRemoved: (
      cb: (payload: { id: string; kind: TerminalSessionKind }) => void,
    ) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; kind: TerminalSessionKind },
      ) => cb(payload);
      ipcRenderer.on("terminal:removed", listener);
      return () => ipcRenderer.removeListener("terminal:removed", listener);
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
    getFontSize: (): Promise<number> =>
      ipcRenderer.invoke("settings:getFontSize"),
    setFontSize: (fontSize: number): Promise<number> =>
      ipcRenderer.invoke("settings:setFontSize", fontSize),
    getUiScale: async (): Promise<number> => {
      const uiScale = await ipcRenderer.invoke("settings:getUiScale") as number;
      webFrame.setZoomFactor(uiScale / 100);
      return uiScale;
    },
    setUiScale: async (uiScale: number): Promise<number> => {
      webFrame.setZoomFactor(uiScale / 100);
      const saved = await ipcRenderer.invoke("settings:setUiScale", uiScale) as number;
      if (saved !== uiScale) webFrame.setZoomFactor(saved / 100);
      return saved;
    }
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
    listSessions: (args: { profileId: string; limit?: number }): Promise<AgentSessionSummary[]> =>
      ipcRenderer.invoke("agent:listSessions", args),
    buildLaunchArgs: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
    }) => ipcRenderer.invoke("agent:buildLaunchArgs", args),
    createSession: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
      resume?: boolean;
      sessionId?: string;
      cols?: number;
      rows?: number;
    }): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("agent:createSession", args),
  },
  skill: {
    status: (args?: { workspaceRoot?: string | null }) =>
      ipcRenderer.invoke("skill:status", args ?? {}),
    install: (args?: {
      workspaceRoot?: string | null;
      targetIds?: string[];
    }) => ipcRenderer.invoke("skill:install", args ?? {}),
    installWorkspace: (workspaceRoot: string) =>
      ipcRenderer.invoke("skill:installWorkspace", workspaceRoot),
    isWorkspaceInstalled: (workspaceRoot: string) =>
      ipcRenderer.invoke("skill:isWorkspaceInstalled", workspaceRoot),
  },
};

contextBridge.exposeInMainWorld("anchor", anchor);

export type AnchorApi = typeof anchor;
