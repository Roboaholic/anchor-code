/** Mirror of preload bridge types for the renderer (no Electron imports). */

export interface AppVersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  hostId: string;
  hostKind: "local" | "ssh";
}

export interface HostInfo {
  id: string;
  kind: "local" | "ssh";
  workspaceRoot: string | null;
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

export interface AnchorApi {
  shell: {
    getVersion: () => Promise<AppVersionInfo>;
  };
  host: {
    getInfo: () => Promise<HostInfo>;
  };
  workspace: {
    pickFolder: () => Promise<string | null>;
    open: (path: string) => Promise<{ root: string; name: string }>;
    getRecent: () => Promise<RecentWorkspace[]>;
    listDir: (path: string) => Promise<DirEntry[]>;
    readText: (path: string) => Promise<ReadTextResult>;
    stat: (path: string) => Promise<StatResult>;
  };
}
