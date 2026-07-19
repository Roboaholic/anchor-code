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
};

contextBridge.exposeInMainWorld("anchor", anchor);

export type AnchorApi = typeof anchor;
