import { create } from "zustand";

import type { DirEntry, RecentWorkspace, WorkspaceInstance } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import {
  joinPath,
  shouldHideTreeEntry,
  shouldSkipExpand,
  workspaceDisplayName,
} from "@/core/workspace/paths";

let workspaceNavigation = 0;

/** Closing an active workspace also invalidates unfinished directory loads. */
export function cancelWorkspaceNavigation(): void { workspaceNavigation += 1; }

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
  /** Loaded children at least once */
  loaded?: boolean;
  expanded?: boolean;
  error?: string;
  /** Listing in flight (expanded optimistically before children arrive). */
  loading?: boolean;
}

type WorkspaceTreeStatus = "idle" | "loading" | "ready" | "error";

export interface WorkspaceViewState {
  rootEntries: TreeNode[];
  status: WorkspaceTreeStatus;
  error: string | null;
  selectedPath: string | null;
  loadedAt: string | null;
}

export interface WorkspaceState {
  workspaceRoot: string | null;
  workspaceName: string | null;
  hostProfileId: string | null;
  hostKind: "local" | "wsl" | "ssh" | null;
  recent: RecentWorkspace[];
  openWorkspaces: WorkspaceInstance[];
  activeWorkspaceId: string | null;
  rootEntries: TreeNode[];
  workspaceViews: Record<string, WorkspaceViewState>;
  status: WorkspaceTreeStatus;
  error: string | null;
  selectedPath: string | null;

  loadRecent: () => Promise<void>;
  loadOpenWorkspaces: () => Promise<void>;
  openPath: (
    path: string,
    opts?: { hostProfileId?: string },
  ) => Promise<void>;
  activateWorkspace: (id: string) => Promise<void>;
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
function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children?.length) {
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Replace the node at `path`; returns the same array when nothing matched. */
function mapNode(
  nodes: TreeNode[],
  path: string,
  fn: (node: TreeNode) => TreeNode,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === path) {
      changed = true;
      return fn(node);
    }
    if (!node.children?.length) return node;
    const children = mapNode(node.children, path, fn);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? next : nodes;
}

/** Tree-visible entries only (what loadChildren keeps). */
export function visibleEntrySignature(entries: DirEntry[]): string {
  return entries
    .filter((e) => !shouldHideTreeEntry(e.name, e.type))
    .map((e) => `${e.type[0]}${e.name}`)
    .sort()
    .join("\n");
}

async function loadWorkspaceInstancesSafe(): Promise<{
  openWorkspaces: WorkspaceInstance[];
  activeWorkspaceId: string | null;
} | null> {
  try {
    const instances = await window.anchor.workspace.listOpenInstances();
    return {
      openWorkspaces: instances.openWorkspaces,
      activeWorkspaceId: instances.activeWorkspaceId,
    };
  } catch {
    return null;
  }
}

function snapshotCurrentView(state: WorkspaceState): WorkspaceViewState {
  return {
    rootEntries: state.rootEntries,
    status: state.status,
    error: state.error,
    selectedPath: state.selectedPath,
    loadedAt: null,
  };
}

function updateActiveWorkspaceView(
  state: WorkspaceState,
  updates: Partial<WorkspaceViewState>,
): Record<string, WorkspaceViewState> {
  if (!state.activeWorkspaceId) return state.workspaceViews;
  return {
    ...state.workspaceViews,
    [state.activeWorkspaceId]: {
      ...(state.workspaceViews[state.activeWorkspaceId] ?? snapshotCurrentView(state)),
      ...updates,
    },
  };
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
  openWorkspaces: [],
  activeWorkspaceId: null,
  rootEntries: [],
  workspaceViews: {},
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

  loadOpenWorkspaces: async () => {
    try {
      const instances = await window.anchor.workspace.listOpenInstances();
      set({
        openWorkspaces: instances.openWorkspaces,
        activeWorkspaceId: instances.activeWorkspaceId,
      });
    } catch {
      // non-fatal
    }
  },

  openPath: async (dirPath, opts) => {
    const navigation = ++workspaceNavigation;
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
      const { root, name, hostKind, hostProfileId, workspaceInstance } = opened;
      const workspaceInstances = await loadWorkspaceInstancesSafe();
      if (navigation !== workspaceNavigation) return;
      const profileId = hostProfileId ?? opts?.hostProfileId ?? null;
      const activeWorkspaceId =
        workspaceInstances?.activeWorkspaceId ?? workspaceInstance?.id ?? null;
      const cachedView = activeWorkspaceId
        ? get().workspaceViews[activeWorkspaceId]
        : undefined;
      const restoredView =
        cachedView?.status === "ready" || cachedView?.status === "error"
          ? cachedView
          : null;

      // Commit root immediately so UI leaves "NO WORKSPACE" even if tree load fails.
      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        hostKind: hostKind ?? null,
        hostProfileId: profileId,
        rootEntries: restoredView ? restoredView.rootEntries : [],
        selectedPath: restoredView ? restoredView.selectedPath : null,
        ...(workspaceInstance
          ? {
              openWorkspaces: workspaceInstances?.openWorkspaces ?? [workspaceInstance],
              activeWorkspaceId,
            }
          : {}),
        status: restoredView ? restoredView.status : "loading",
        error: restoredView ? restoredView.error : null,
      });

      let rootEntries: TreeNode[] = [];
      let treeError: string | null = null;
      if (restoredView) {
        rootEntries = restoredView.rootEntries;
        treeError = restoredView.error;
      } else {
        try {
          rootEntries = await loadChildren(root);
        } catch (err) {
          treeError = formatError(err);
        }
      }

      let recent = get().recent;
      try {
        recent = await window.anchor.workspace.getRecent();
      } catch {
        // non-fatal
      }

      if (navigation !== workspaceNavigation) return;
      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        hostKind: hostKind ?? get().hostKind,
        hostProfileId: profileId ?? get().hostProfileId,
        rootEntries,
        workspaceViews: activeWorkspaceId
          ? {
              ...get().workspaceViews,
              [activeWorkspaceId]: {
                rootEntries,
                status: treeError ? "error" : "ready",
                error: treeError,
                selectedPath: restoredView ? restoredView.selectedPath : null,
                loadedAt: restoredView
                  ? restoredView.loadedAt
                  : new Date().toISOString(),
              },
            }
          : get().workspaceViews,
        ...(workspaceInstance
          ? {
              openWorkspaces: workspaceInstances?.openWorkspaces ?? [workspaceInstance],
              activeWorkspaceId,
            }
          : {}),
        recent,
        status: treeError ? "error" : "ready",
        error: treeError,
        selectedPath: restoredView ? restoredView.selectedPath : null,
      });
      if (treeError) {
        console.warn("[workspace] listDir failed:", treeError);
      }
    } catch (err) {
      if (navigation !== workspaceNavigation) return;
      const message = formatError(err);
      set({ status: "error", error: message });
      throw err;
    }
  },

  activateWorkspace: async (id) => {
    const navigation = ++workspaceNavigation;
    if (!window.anchor?.workspace?.activate) {
      const message =
        "IPC bridge missing (window.anchor.workspace.activate). Restart the Electron app.";
      set({ status: "error", error: message });
      throw new Error(message);
    }
    try {
      const activated = await window.anchor.workspace.activate(id);
      if (navigation !== workspaceNavigation) return;
      const workspaceInstances = activated.workspaceInstances;
      const activeWorkspaceId =
        workspaceInstances?.activeWorkspaceId ?? activated.workspaceInstance.id;
      const cachedView = get().workspaceViews[activeWorkspaceId];
      const restoredView =
        cachedView?.status === "ready" || cachedView?.status === "error"
          ? cachedView
          : null;
      set({
        workspaceRoot: activated.root,
        workspaceName: activated.name || workspaceDisplayName(activated.root),
        hostKind: activated.hostKind,
        hostProfileId: activated.hostProfileId,
        rootEntries: restoredView?.rootEntries ?? [],
        status: restoredView?.status ?? "ready",
        error: restoredView?.error ?? null,
        selectedPath: restoredView?.selectedPath ?? null,
        openWorkspaces: workspaceInstances?.openWorkspaces ?? [activated.workspaceInstance],
        activeWorkspaceId,
        workspaceViews: activeWorkspaceId
          ? {
              ...get().workspaceViews,
              [activeWorkspaceId]: restoredView ?? {
                rootEntries: [],
                status: "ready",
                error: null,
                selectedPath: null,
                loadedAt: null,
              },
            }
          : get().workspaceViews,
      });
    } catch (err) {
      if (navigation !== workspaceNavigation) return;
      const message = formatError(err);
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
    const target = findNode(rootEntries, dirPath);
    if (!target || target.type !== "dir") return;

    // Every update below maps the *latest* tree, so concurrent toggles and
    // watcher refreshes compose instead of overwriting each other.
    const apply = (fn: (node: TreeNode) => TreeNode) =>
      set((state) => {
        const next = mapNode(state.rootEntries, dirPath, fn);
        if (next === state.rootEntries) return {};
        return {
          rootEntries: next,
          workspaceViews: updateActiveWorkspaceView(state, { rootEntries: next }),
        };
      });

    if (shouldSkipExpand(target.name)) {
      apply((node) => ({
        ...node,
        expanded: !node.expanded,
        loaded: true,
        children: [],
        error: node.name === ".git" ? "Contents hidden" : undefined,
      }));
      return;
    }
    if (target.expanded || target.loaded || target.loading) {
      apply((node) => ({ ...node, expanded: !node.expanded }));
      return;
    }

    // Expand immediately; children arrive when the (possibly remote) listing
    // returns, instead of the click appearing to do nothing until then.
    apply((node) => ({ ...node, expanded: true, loading: true, error: undefined }));
    let children: TreeNode[] = [];
    let error: string | undefined;
    try {
      children = await loadChildren(dirPath);
    } catch (err) {
      error = formatError(err);
    }
    apply((node) => ({
      ...node,
      loading: false,
      loaded: true,
      children,
      error,
    }));
  },

  refreshDir: async (dirPath) => {
    const workspaceRoot = get().workspaceRoot;
    const hostProfileId = get().hostProfileId;
    const navigation = workspaceNavigation;
    if (!workspaceRoot) return;

    let children: TreeNode[];
    try {
      children = await loadChildren(dirPath);
    } catch {
      // Non-fatal: preserve the current tree on transient watcher errors.
      return;
    }

    const preserveLoadedState = (
      fresh: TreeNode[],
      previous: TreeNode[],
    ): TreeNode[] => {
      const byPath = new Map(previous.map((node) => [node.path, node]));
      return fresh.map((node) => {
        const old = byPath.get(node.path);
        if (!old || node.type !== "dir" || old.type !== "dir") return node;
        return {
          ...node,
          expanded: old.expanded,
          loaded: old.loaded,
          loading: old.loading,
          children: old.children,
          error: old.error,
        };
      });
    };

    set((state) => {
      if (navigation !== workspaceNavigation || state.workspaceRoot !== workspaceRoot || state.hostProfileId !== hostProfileId) return state;
      // Apply against the latest tree so concurrent watcher refreshes compose.
      if (dirPath === workspaceRoot) {
        const rootEntries = preserveLoadedState(children, state.rootEntries);
        return {
          rootEntries,
          workspaceViews: updateActiveWorkspaceView(state, {
            rootEntries,
            status: "ready",
            error: null,
            loadedAt: new Date().toISOString(),
          }),
        };
      }

      const reloadNode = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === dirPath && node.type === "dir") {
            if (!node.expanded || !node.loaded) return node;
            return {
              ...node,
              children: preserveLoadedState(children, node.children ?? []),
              error: undefined,
            };
          }
          if (!node.children?.length) return node;
          return { ...node, children: reloadNode(node.children) };
        });

      const rootEntries = reloadNode(state.rootEntries);
      return {
        rootEntries,
        workspaceViews: updateActiveWorkspaceView(state, {
          rootEntries,
          status: "ready",
          error: null,
          loadedAt: new Date().toISOString(),
        }),
      };
    });
  },

  deleteNode: async (path) => {
    await window.anchor.workspace.deletePath(path);
    // Clear selection if the deleted path was selected (or a parent of it).
    const sel = get().selectedPath;
    if (sel && (sel === path || sel.startsWith(path + "/") || sel.startsWith(path + "\\"))) {
      get().setSelectedPath(null);
    }
    await get().refreshDir(parentDirOf(path));
  },

  renameNode: async (oldPath, newName) => {
    const parent = parentDirOf(oldPath);
    const newPath = joinPath(parent, newName.trim());
    await window.anchor.workspace.renamePath(oldPath, newPath);
    if (get().selectedPath === oldPath) {
      get().setSelectedPath(newPath);
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

  setSelectedPath: (path) => {
    set((state) => ({
      selectedPath: path,
      workspaceViews: updateActiveWorkspaceView(state, { selectedPath: path }),
    }));
  },
}));
