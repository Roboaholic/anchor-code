import { create } from "zustand";
import type { DirEntry, RecentWorkspace } from "@/shared/anchor-api";
import {
  filterDirEntries,
  isValidExcludePattern,
  normalizeExcludePattern,
  pruneExcludedPaths,
} from "@/core/workspace/pathFilter";
import {
  joinPath,
  relativeToRoot,
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
  /** Relative paths/globs excluded from Files view for this workspace. */
  excludes: string[];

  loadRecent: () => Promise<void>;
  openPath: (
    path: string,
    opts?: { hostProfileId?: string },
  ) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  setSelectedPath: (path: string | null) => void;
  addExclude: (relOrAbsPath: string) => Promise<void>;
  removeExclude: (pattern: string) => Promise<void>;
  addExcludePattern: (pattern: string) => Promise<void>;
  resetDocumentSideEffects?: () => void;
}

async function loadChildren(
  dirPath: string,
  workspaceRoot: string,
  excludes: string[],
): Promise<TreeNode[]> {
  const entries: DirEntry[] = await window.anchor.workspace.listDir(dirPath);
  const parentRel = relativeToRoot(workspaceRoot, dirPath);
  const filtered = filterDirEntries(
    entries.filter((e) => !shouldHideTreeEntry(e.name, e.type)),
    parentRel,
    excludes,
  );
  return filtered.map((e) => ({
    name: e.name,
    path: joinPath(dirPath, e.name),
    type: e.type,
    expanded: false,
    loaded: e.type === "file" ? true : false,
    children: e.type === "dir" ? [] : undefined,
  }));
}

async function persistExcludes(
  workspaceRoot: string,
  hostProfileId: string | null,
  excludes: string[],
): Promise<string[]> {
  try {
    const next = await window.anchor.settings.setWorkspaceFilter({
      workspaceRoot,
      hostProfileId,
      excludes,
    });
    return next.excludes ?? excludes;
  } catch {
    return excludes;
  }
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
  excludes: [],

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
    set({ status: "loading", error: null, excludes: [] });
    try {
      const opened = await window.anchor.workspace.open(
        opts?.hostProfileId
          ? { path: dirPath, hostProfileId: opts.hostProfileId }
          : dirPath,
      );
      const { root, name, hostKind, hostProfileId } = opened;
      const profileId = hostProfileId ?? opts?.hostProfileId ?? null;

      let excludes: string[] = [];
      try {
        const filter = await window.anchor.settings.getWorkspaceFilter({
          workspaceRoot: root,
          hostProfileId: profileId,
        });
        excludes = filter.excludes ?? [];
      } catch {
        excludes = [];
      }

      // Commit root immediately so UI leaves "NO WORKSPACE" even if tree load fails.
      set({
        workspaceRoot: root,
        workspaceName: name || workspaceDisplayName(root),
        hostKind: hostKind ?? null,
        hostProfileId: profileId,
        selectedPath: null,
        excludes,
        status: "loading",
        error: null,
      });

      let rootEntries: TreeNode[] = [];
      let treeError: string | null = null;
      try {
        rootEntries = await loadChildren(root, root, excludes);
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
        excludes,
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
    const { rootEntries, workspaceRoot, excludes } = get();
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
              const children = await loadChildren(
                node.path,
                workspaceRoot,
                excludes,
              );
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

  addExclude: async (relOrAbsPath) => {
    const root = get().workspaceRoot;
    if (!root) return;
    const rootNorm = root.replace(/\\/g, "/");
    const absNorm = relOrAbsPath.replace(/\\/g, "/");
    const rel = normalizeExcludePattern(
      absNorm === rootNorm || absNorm.startsWith(rootNorm + "/")
        ? relativeToRoot(root, relOrAbsPath)
        : relOrAbsPath,
    );
    await get().addExcludePattern(rel);
  },

  removeExclude: async (pattern) => {
    const { workspaceRoot, hostProfileId, excludes } = get();
    if (!workspaceRoot) return;
    const target = normalizeExcludePattern(pattern);
    const nextExcludes = excludes.filter(
      (p) => normalizeExcludePattern(p) !== target,
    );
    if (nextExcludes.length === excludes.length) return;
    const saved = await persistExcludes(
      workspaceRoot,
      hostProfileId,
      nextExcludes,
    );
    // Reload root listing so previously hidden entries reappear.
    try {
      const rootEntries = await loadChildren(workspaceRoot, workspaceRoot, saved);
      set({ excludes: saved, rootEntries });
    } catch (err) {
      set({
        excludes: saved,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  addExcludePattern: async (pattern) => {
    const { workspaceRoot, hostProfileId, excludes, rootEntries, selectedPath } =
      get();
    if (!workspaceRoot) return;
    const rel = normalizeExcludePattern(pattern);
    if (!isValidExcludePattern(rel)) return;
    if (excludes.some((p) => normalizeExcludePattern(p) === rel)) return;
    const nextExcludes = [...excludes, rel].sort((a, b) => a.localeCompare(b));
    const saved = await persistExcludes(
      workspaceRoot,
      hostProfileId,
      nextExcludes,
    );
    const pruned = pruneExcludedPaths(
      rootEntries,
      workspaceRoot,
      saved,
      relativeToRoot,
    );
    set({ excludes: saved, rootEntries: pruned });
    if (selectedPath) {
      const stillThere = (nodes: TreeNode[], path: string): boolean => {
        for (const n of nodes) {
          if (n.path === path) return true;
          if (n.children && stillThere(n.children, path)) return true;
        }
        return false;
      };
      if (!stillThere(pruned, selectedPath)) set({ selectedPath: null });
    }
  },
}));
