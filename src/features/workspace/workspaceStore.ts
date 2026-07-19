import { create } from "zustand";
import type { DirEntry, RecentWorkspace } from "@/shared/anchor-api";
import {
  joinPath,
  shouldHideTreeEntry,
  shouldSkipExpand,
  workspaceDisplayName,
} from "@/core/workspace/paths";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
  /** Loaded children at least once */
  loaded?: boolean;
  expanded?: boolean;
  error?: string;
}

export interface WorkspaceState {
  workspaceRoot: string | null;
  workspaceName: string | null;
  recent: RecentWorkspace[];
  rootEntries: TreeNode[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedPath: string | null;

  loadRecent: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  setSelectedPath: (path: string | null) => void;
  resetDocumentSideEffects?: () => void;
}

async function loadChildren(dirPath: string): Promise<TreeNode[]> {
  const entries: DirEntry[] = await window.anchor.workspace.listDir(dirPath);
  return entries
    .filter((e) => !shouldHideTreeEntry(e.name, e.type))
    .map((e) => ({
      name: e.name,
      path: joinPath(dirPath, e.name),
      type: e.type,
      expanded: false,
      loaded: e.type === "file" ? true : false,
      children: e.type === "dir" ? [] : undefined,
    }));
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaceRoot: null,
  workspaceName: null,
  recent: [],
  rootEntries: [],
  status: "idle",
  error: null,
  selectedPath: null,

  loadRecent: async () => {
    try {
      const recent = await window.anchor.workspace.getRecent();
      set({ recent });
    } catch {
      // non-fatal
    }
  },

  openPath: async (dirPath: string) => {
    if (!window.anchor?.workspace?.open) {
      const message =
        "IPC bridge missing (window.anchor.workspace). Restart the Electron app, not a browser tab.";
      set({ status: "error", error: message });
      throw new Error(message);
    }
    set({ status: "loading", error: null });
    try {
      const { root, name } = await window.anchor.workspace.open(dirPath);
      // Commit root immediately so UI leaves "NO WORKSPACE" even if tree load fails.
      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        selectedPath: null,
        status: "loading",
        error: null,
      });

      let rootEntries: TreeNode[] = [];
      let treeError: string | null = null;
      try {
        rootEntries = await loadChildren(root);
      } catch (err) {
        treeError = err instanceof Error ? err.message : String(err);
      }

      let recent = get().recent;
      try {
        recent = await window.anchor.workspace.getRecent();
      } catch {
        // non-fatal
      }

      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        rootEntries,
        recent,
        status: treeError ? "error" : "ready",
        error: treeError,
        selectedPath: null,
      });
      if (treeError) {
        // Root is open; tree failure is recoverable — do not throw away the open.
        console.warn("[workspace] listDir failed:", treeError);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: message });
      throw err;
    }
  },

  pickAndOpen: async () => {
    if (!window.anchor?.workspace?.pickFolder) {
      const message =
        "IPC bridge missing (window.anchor.workspace.pickFolder). Use the Electron window.";
      set({ status: "error", error: message });
      throw new Error(message);
    }
    const picked = await window.anchor.workspace.pickFolder();
    if (!picked) return;
    await get().openPath(picked);
  },

  toggleDir: async (dirPath: string) => {
    const { rootEntries, workspaceRoot } = get();
    if (!workspaceRoot) return;

    const updateNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      const result: TreeNode[] = [];
      for (const node of nodes) {
        if (node.path === dirPath && node.type === "dir") {
          if (shouldSkipExpand(node.name)) {
            result.push({
              ...node,
              expanded: !node.expanded,
              loaded: true,
              children: [],
              error: node.name === ".git" ? "Contents hidden" : undefined,
            });
            continue;
          }
          const willExpand = !node.expanded;
          if (willExpand && !node.loaded) {
            try {
              const children = await loadChildren(node.path);
              result.push({
                ...node,
                expanded: true,
                loaded: true,
                children,
                error: undefined,
              });
            } catch (err) {
              result.push({
                ...node,
                expanded: true,
                loaded: true,
                children: [],
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            result.push({ ...node, expanded: willExpand });
          }
        } else if (node.children && node.children.length > 0) {
          result.push({
            ...node,
            children: await updateNode(node.children),
          });
        } else {
          result.push(node);
        }
      }
      return result;
    };

    const next = await updateNode(rootEntries);
    set({ rootEntries: next });
  },

  setSelectedPath: (path) => set({ selectedPath: path }),
}));
