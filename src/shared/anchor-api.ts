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

export interface AnchorApi {
  shell: {
    getVersion: () => Promise<AppVersionInfo>;
  };
  host: {
    getInfo: () => Promise<HostInfo>;
  };
}
