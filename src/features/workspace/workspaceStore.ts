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
  hostProfileId: string | null;
  hostKind: "local" | "wsl" | "ssh" | null;
  recent: RecentWorkspace[];
  rootEntries: TreeNode[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  selectedPath: string | null;

  loadRecent: () => Promise<void>;
  openPath: (
    path: string,
    opts?: { hostProfileId?: string },
  ) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  /** Reload a directory's contents (for auto-refresh); no-op unless expanded+loaded. */
  refreshDir: (dirPath: string) => Promise<void>;
  /** File operations: call host IPC, then refresh the affected directory. */
  deleteNode: (path: string) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<void>;
  copyNode: (src: string) => Promise<void>;
  createEntry: (
    parentDir: string,
    name: string,
    type: "file" | "dir",
  ) => Promise<string | null>;
  setSelectedPath: (path: string | null) => void;
  resetDocumentSideEffects?: () => void;
}

async function loadChildren(
  dirPath: string,
): Promise<TreeNode[]> {
  const entries: DirEntry[] = await window.anchor.workspace.listDir(dirPath);
  const visible = entries.filter((e) => !shouldHideTreeEntry(e.name, e.type));
  return visible.map((e) => ({
    name: e.name,
    path: joinPath(dirPath, e.name),
    type: e.type,
    expanded: false,
    loaded: e.type === "file" ? true : false,
    children: e.type === "dir" ? [] : undefined,
  }));
}

/** Last path segment (basename), handling both / and \ separators. */
export function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Directory portion (without trailing separator); same on both OS styles. */
export function parentDirOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return p;
  const parent = norm.slice(0, i);
  return parent === "" ? "/" : parent.replace(/\//g, p.includes("\\") ? "\\" : "/");
}

/** Split a "name.ext" into [stem, ext] (dotfiles like .gitignore → full name). */
export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * Propose a non-clobbering copy name ("foo.txt" → "foo copy.txt").
 * Collision is reconciled by the next refreshDir.
 */
export function uniqueCopyName(parent: string, name: string): string {
  const [stem, ext] = splitExt(name);
  return joinPath(parent, `${stem} copy${ext}`);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaceRoot: null,
  workspaceName: null,
  hostProfileId: null,
  hostKind: null,
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

  openPath: async (dirPath, opts) => {
    if (!window.anchor?.workspace?.open) {
      const message =
        "IPC bridge missing (window.anchor.workspace). Restart the Electron app, not a browser tab.";
      set({ status: "error", error: message });
      throw new Error(message);
    }
    set({ status: "loading", error: null });
    try {
      const opened = await window.anchor.workspace.open(
        opts?.hostProfileId
          ? { path: dirPath, hostProfileId: opts.hostProfileId }
          : dirPath,
      );
      const { root, name, hostKind, hostProfileId } = opened;
      const profileId = hostProfileId ?? opts?.hostProfileId ?? null;

      // Commit root immediately so UI leaves "NO WORKSPACE" even if tree load fails.
      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        hostKind: hostKind ?? null,
        hostProfileId: profileId,
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
        hostKind: hostKind ?? get().hostKind,
        hostProfileId: profileId ?? get().hostProfileId,
        rootEntries,
        recent,
        status: treeError ? "error" : "ready",
        error: treeError,
        selectedPath: null,
      });
      if (treeError) {
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

  refreshDir: async (dirPath) => {
    const { rootEntries, workspaceRoot } = get();
    if (!workspaceRoot) return;

    // Root changed → reload top-level entries directly.
    if (dirPath === workspaceRoot) {
      try {
        const children = await loadChildren(workspaceRoot);
        set({ rootEntries: children });
      } catch {
        // non-fatal: leave existing tree
      }
      return;
    }

    // Reload only if the directory is currently expanded & loaded (mirrors
    // toggleDir's recursion, but always refetches the matched node).
    const reloadNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      const result: TreeNode[] = [];
      for (const node of nodes) {
        if (node.path === dirPath && node.type === "dir") {
          if (node.expanded && node.loaded) {
            try {
              const children = await loadChildren(node.path);
              result.push({ ...node, children, error: undefined });
            } catch {
              result.push(node);
            }
          } else {
            result.push(node);
          }
        } else if (node.children && node.children.length > 0) {
          result.push({
            ...node,
            children: await reloadNode(node.children),
          });
        } else {
          result.push(node);
        }
      }
      return result;
    };

    const next = await reloadNode(rootEntries);
    set({ rootEntries: next });
  },

  deleteNode: async (path) => {
    await window.anchor.workspace.deletePath(path);
    // Clear selection if the deleted path was selected (or a parent of it).
    const sel = get().selectedPath;
    if (sel && (sel === path || sel.startsWith(path + "/") || sel.startsWith(path + "\\"))) {
      set({ selectedPath: null });
    }
    await get().refreshDir(parentDirOf(path));
  },

  renameNode: async (oldPath, newName) => {
    const parent = parentDirOf(oldPath);
    const newPath = joinPath(parent, newName.trim());
    await window.anchor.workspace.renamePath(oldPath, newPath);
    if (get().selectedPath === oldPath) {
      set({ selectedPath: newPath });
    }
    await get().refreshDir(parent);
  },

  copyNode: async (src) => {
    const parent = parentDirOf(src);
    const base = basenameOf(src);
    const dst = uniqueCopyName(parent, base);
    await window.anchor.workspace.copyPath(src, dst);
    await get().refreshDir(parent);
  },

  createEntry: async (parentDir, name, type) => {
    const res = await window.anchor.workspace.createEntry(
      parentDir,
      name.trim(),
      type,
    );
    await get().refreshDir(parentDir);
    return res.path ?? null;
  },

  setSelectedPath: (path) => set({ selectedPath: path }),
}));
