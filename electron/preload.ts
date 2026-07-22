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

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
}

const anchor = {
  shell: {
    getVersion: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("shell:getVersion"),
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
  },
  workspace: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:pickFolder"),
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
  },
  history: {
    discover: (workspaceRoot: string): Promise<RepoInfo[]> =>
      ipcRenderer.invoke("history:discover", workspaceRoot),
    loadLog: (repoRoot: string): Promise<CommitRow[]> =>
      ipcRenderer.invoke("history:loadLog", repoRoot),
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
    }): Promise<TerminalTabInfo> =>
      ipcRenderer.invoke("terminal:create", args ?? {}),
    list: (): Promise<TerminalTabInfo[]> => ipcRenderer.invoke("terminal:list"),
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
    onExit: (
      cb: (payload: { id: string; exitCode: number }) => void,
    ) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; exitCode: number },
      ) => cb(payload);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },
};

contextBridge.exposeInMainWorld("anchor", anchor);

export type AnchorApi = typeof anchor;
