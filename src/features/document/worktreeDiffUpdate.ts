import type { DiffFile, SnapshotDiffPayload, SnapshotDiffRepo } from "@/shared/anchor-api";
import type { OpenItem, SnapshotDiffActive } from "./documentStore";

function normalizeOpenFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function diffFilesEqual(a: DiffFile[], b: DiffFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.path !== b[i]!.path || a[i]!.status !== b[i]!.status) return false;
  }
  return true;
}

export function largeFilesEqual(
  a: SnapshotDiffRepo["largeFiles"],
  b: SnapshotDiffRepo["largeFiles"],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.path !== right.path || left.status !== right.status || left.size !== right.size) {
      return false;
    }
  }
  return true;
}

/** Keep the current file when it still exists; otherwise the next surviving neighbor. */
export function nextActiveDiffPath(
  files: DiffFile[],
  current: string | null,
  previousFiles: DiffFile[],
): string | null {
  if (current && files.some((file) => file.path === current)) return current;
  if (!current) return files[0]?.path ?? null;
  const idx = previousFiles.findIndex((file) => file.path === current);
  if (idx >= 0) {
    for (let i = idx + 1; i < previousFiles.length; i += 1) {
      const path = previousFiles[i]!.path;
      if (files.some((file) => file.path === path)) return path;
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
      const path = previousFiles[i]!.path;
      if (files.some((file) => file.path === path)) return path;
    }
  }
  return files[0]?.path ?? null;
}

export function pathInsideRoot(absPath: string, root: string): boolean {
  const path = normalizeOpenFilePath(absPath);
  const base = normalizeOpenFilePath(root).replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

export function relativeToRootPath(absPath: string, root: string): string | null {
  const path = normalizeOpenFilePath(absPath);
  const base = normalizeOpenFilePath(root).replace(/\/+$/, "");
  if (path === base) return "";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return null;
}

function bumpEpoch(epoch: number | undefined): number {
  return (epoch ?? 0) + 1;
}

function shouldBumpForPaths(
  activePath: string | null,
  previousStatus: string | undefined,
  nextStatus: string | undefined,
  changedPaths: Set<string>,
  filesChanged: boolean,
  activeChanged: boolean,
): boolean {
  if (activeChanged) return true;
  if (activePath && changedPaths.has(activePath)) return true;
  if (activePath && previousStatus !== nextStatus) return true;
  if (filesChanged && !activePath) return true;
  return false;
}

/**
 * Apply a fresh worktree compare to every matching open diff tab.
 * Full compare tabs get the new file list; Changes single-file tabs stay focused
 * on their one path. Returns `null` when nothing visible should change.
 */
export function applyWorktreeDiffItems(
  openItems: OpenItem[],
  args: {
    repoRoot: string;
    base: string;
    files: DiffFile[];
    changedPaths: Iterable<string>;
  },
): OpenItem[] | null {
  const changedPaths = new Set(args.changedPaths);
  let any = false;
  const nextItems = openItems.map((item) => {
    if (item.kind !== "diff" || item.head !== "worktree") return item;
    if (item.repoRoot !== args.repoRoot || item.base !== args.base) return item;

    if (item.hideFileList) {
      const focused = item.activeFilePath ?? item.files[0]?.path ?? null;
      const entry = focused ? args.files.find((file) => file.path === focused) : undefined;
      const nextFiles = entry ? [entry] : [];
      const filesChanged = !diffFilesEqual(item.files, nextFiles);
      const activeChanged = (entry?.path ?? null) !== focused || (!entry && focused !== null);
      const nextActive = entry ? focused : null;
      const bump = shouldBumpForPaths(
        focused,
        item.files[0]?.status,
        entry?.status,
        changedPaths,
        filesChanged,
        activeChanged,
      );
      if (!filesChanged && !bump) return item;
      any = true;
      return {
        ...item,
        files: filesChanged ? nextFiles : item.files,
        activeFilePath: nextActive,
        worktreeContentEpoch: bump ? bumpEpoch(item.worktreeContentEpoch) : item.worktreeContentEpoch,
      };
    }

    const filesChanged = !diffFilesEqual(item.files, args.files);
    const nextActive = filesChanged
      ? nextActiveDiffPath(args.files, item.activeFilePath, item.files)
      : item.activeFilePath;
    const activeChanged = nextActive !== item.activeFilePath;
    const bump = shouldBumpForPaths(
      item.activeFilePath,
      item.files.find((file) => file.path === item.activeFilePath)?.status,
      args.files.find((file) => file.path === nextActive)?.status,
      changedPaths,
      filesChanged,
      activeChanged,
    );
    if (!filesChanged && !bump) return item;
    any = true;
    return {
      ...item,
      files: filesChanged ? args.files : item.files,
      activeFilePath: nextActive,
      worktreeContentEpoch: bump ? bumpEpoch(item.worktreeContentEpoch) : item.worktreeContentEpoch,
    };
  });
  return any ? nextItems : null;
}

function snapshotRepoEqual(a: SnapshotDiffRepo, b: SnapshotDiffRepo): boolean {
  return (
    a.root === b.root &&
    a.state === b.state &&
    a.base === b.base &&
    a.head === b.head &&
    a.error === b.error &&
    diffFilesEqual(a.files, b.files) &&
    largeFilesEqual(a.largeFiles, b.largeFiles)
  );
}

function nextSnapshotActive(
  payload: SnapshotDiffPayload,
  current: SnapshotDiffActive | null,
): SnapshotDiffActive | null {
  if (!current) return firstChangedEntry(payload);
  const repo = payload.repos.find((item) => item.root === current.repoRoot);
  if (!repo) return firstChangedEntry(payload);
  if (current.large) {
    if (repo.largeFiles.some((file) => file.path === current.path)) return current;
    const firstLarge = repo.largeFiles[0];
    if (firstLarge) return { repoRoot: repo.root, path: firstLarge.path, large: true };
    if (repo.files[0]) return { repoRoot: repo.root, path: repo.files[0].path };
    return firstChangedEntry(payload);
  }
  if (repo.files.some((file) => file.path === current.path)) return current;
  const nextPath = nextActiveDiffPath(repo.files, current.path, repo.files);
  if (nextPath) return { repoRoot: repo.root, path: nextPath };
  if (repo.largeFiles[0]) return { repoRoot: repo.root, path: repo.largeFiles[0].path, large: true };
  return firstChangedEntry(payload);
}

function firstChangedEntry(payload: SnapshotDiffPayload): SnapshotDiffActive | null {
  for (const repo of payload.repos) {
    if (repo.state === "unchanged" || repo.state === "removed") continue;
    if (repo.files[0]) return { repoRoot: repo.root, path: repo.files[0].path };
    if (repo.largeFiles[0]) return { repoRoot: repo.root, path: repo.largeFiles[0].path, large: true };
  }
  return null;
}

export function applySnapshotWorktreeItems(
  openItems: OpenItem[],
  args: {
    workspaceRoot: string;
    baseId: string;
    repos: SnapshotDiffRepo[];
    changedPaths: Iterable<{ repoRoot: string; path: string }>;
  },
): OpenItem[] | null {
  const changed = new Set(
    [...args.changedPaths].map((item) => `${normalizeOpenFilePath(item.repoRoot)}\0${item.path}`),
  );
  let any = false;
  const nextItems = openItems.map((item) => {
    if (item.kind !== "snapshot-diff") return item;
    if (item.payload.targetId !== "worktree") return item;
    if (item.payload.workspaceRoot !== args.workspaceRoot || item.payload.baseId !== args.baseId) {
      return item;
    }
    const reposChanged =
      item.payload.repos.length !== args.repos.length ||
      item.payload.repos.some((repo, index) => {
        const next = args.repos[index];
        return !next || !snapshotRepoEqual(repo, next);
      });
    const nextPayload: SnapshotDiffPayload = reposChanged
      ? { ...item.payload, repos: args.repos }
      : item.payload;
    const nextActive = nextSnapshotActive(nextPayload, item.active);
    const activeChanged =
      nextActive?.repoRoot !== item.active?.repoRoot ||
      nextActive?.path !== item.active?.path ||
      Boolean(nextActive?.large) !== Boolean(item.active?.large);
    const activeKey = item.active
      ? `${normalizeOpenFilePath(item.active.repoRoot)}\0${item.active.path}`
      : null;
    const bump = activeChanged || (activeKey !== null && changed.has(activeKey)) || (!item.active && reposChanged);
    if (!reposChanged && !bump && nextActive === item.active) return item;
    any = true;
    return {
      ...item,
      payload: nextPayload,
      active: nextActive,
      worktreeContentEpoch: bump ? bumpEpoch(item.worktreeContentEpoch) : item.worktreeContentEpoch,
    };
  });
  return any ? nextItems : null;
}

export type WorktreeDiffTarget =
  | { kind: "diff"; repoRoot: string; base: string }
  | { kind: "snapshot"; workspaceRoot: string; baseId: string; repoRoots: string[] };

export function collectOpenWorktreeTargets(openItems: OpenItem[]): WorktreeDiffTarget[] {
  const diffs: WorktreeDiffTarget[] = [];
  const seenDiff = new Set<string>();
  const snapshots: WorktreeDiffTarget[] = [];
  const seenSnap = new Set<string>();
  for (const item of openItems) {
    if (item.kind === "diff" && item.head === "worktree") {
      const key = `${item.repoRoot}\0${item.base}`;
      if (seenDiff.has(key)) continue;
      seenDiff.add(key);
      diffs.push({ kind: "diff", repoRoot: item.repoRoot, base: item.base });
    } else if (item.kind === "snapshot-diff" && item.payload.targetId === "worktree") {
      const key = `${item.payload.workspaceRoot}\0${item.payload.baseId}`;
      if (seenSnap.has(key)) continue;
      seenSnap.add(key);
      snapshots.push({
        kind: "snapshot",
        workspaceRoot: item.payload.workspaceRoot,
        baseId: item.payload.baseId,
        repoRoots: item.payload.repos.filter((repo) => repo.head === "worktree").map((repo) => repo.root),
      });
    }
  }
  return [...diffs, ...snapshots];
}
