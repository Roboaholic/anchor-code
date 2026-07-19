import { contextBridge, ipcRenderer } from "electron";

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

/**
 * Preload bridge — Renderer talks only through window.anchor.
 * Domain IPC names follow modules (history.*, annotations.*); never git.*.
 */
const anchor = {
  shell: {
    getVersion: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("shell:getVersion"),
  },
  host: {
    getInfo: (): Promise<HostInfo> => ipcRenderer.invoke("host:getInfo"),
  },
  workspace: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:pickFolder"),
    open: (path: string): Promise<{ root: string; name: string }> =>
      ipcRenderer.invoke("workspace:open", path),
    getRecent: (): Promise<RecentWorkspace[]> =>
      ipcRenderer.invoke("workspace:getRecent"),
    listDir: (path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke("workspace:listDir", path),
    readText: (path: string): Promise<ReadTextResult> =>
      ipcRenderer.invoke("workspace:readText", path),
    stat: (path: string): Promise<StatResult> =>
      ipcRenderer.invoke("workspace:stat", path),
  },
};

contextBridge.exposeInMainWorld("anchor", anchor);

export type AnchorApi = typeof anchor;
