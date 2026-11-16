import { setActiveInterval } from "@/shared/appActivity";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { invalidateWorktreeDiffPaths } from "./fileDiffCache";
import { useDocumentStore } from "./documentStore";
import {
  collectOpenWorktreeTargets,
  pathInsideRoot,
  relativeToRootPath,
  type WorktreeDiffTarget,
} from "./worktreeDiffUpdate";

/** Batch bursty local saves / agent writes before re-running git diff. */
export const WORKTREE_DIFF_SYNC_DEBOUNCE_MS = 400;
/** Poll when fs.watch is unavailable (WSL / SSH). */
export const WORKTREE_DIFF_SYNC_POLL_MS = 3_000;
/** Slow safety-net poll while a native watcher is already covering the tree. */
export const WORKTREE_DIFF_SYNC_LOCAL_POLL_MS = 15_000;

function fingerprintToken(fp: {
  status?: string;
  mtimeMs?: number | null;
  size?: number | null;
}): string {
  return `${fp.status ?? ""}|${fp.mtimeMs ?? ""}|${fp.size ?? ""}`;
}

function filesKey(files: { path: string; status: string }[]): string {
  return files.map((file) => `${file.path}\0${file.status}`).join("\n");
}

type FileChangeEvent = {
  root?: string;
  hostProfileId?: string;
  dir: string;
  changes?: { path: string; rel: string; eventType: string; kind?: string }[];
};

/** Map watch events to repo roots and, when known, the relative paths that changed. */
export function watchTouchedRepos(
  event: FileChangeEvent,
  repoRoots: string[],
): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  const ensure = (root: string): Set<string> => {
    const current = hits.get(root);
    if (current) return current;
    const created = new Set<string>();
    hits.set(root, created);
    return created;
  };

  if (!event.changes?.length) {
    for (const root of repoRoots) {
      if (pathInsideRoot(event.dir, root)) ensure(root);
    }
    return hits;
  }

  for (const change of event.changes) {
    for (const root of repoRoots) {
      if (!pathInsideRoot(change.path, root) && !pathInsideRoot(event.dir, root)) continue;
      const rel = relativeToRootPath(change.path, root);
      const set = ensure(root);
      if (rel) set.add(rel);
    }
  }
  return hits;
}

/**
 * Subscribe to local fs.watch batches and poll worktree diffs on remote hosts.
 * Returns a disposer. No-ops when no worktree diff tab is open.
 */
export function startWorktreeDiffSync(): () => void {
  if (typeof window === "undefined") return () => undefined;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let generation = 0;
  const fingerprints = new Map<string, string>();
  const pendingPaths = new Map<string, Set<string>>();
  const inflight = new Set<string>();
  const requestSeq = new Map<string, number>();
  const pendingForced = new Map<string, Set<string>>();

  const targetKey = (target: WorktreeDiffTarget): string =>
    target.kind === "diff"
      ? `diff\0${target.repoRoot}\0${target.base}`
      : `snapshot\0${target.workspaceRoot}\0${target.baseId}`;

  const resetSession = () => {
    generation += 1;
    fingerprints.clear();
    pendingPaths.clear();
    inflight.clear();
    requestSeq.clear();
    pendingForced.clear();
  };

  const scheduleRefresh = () => {
    if (disposed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
  };

  const scheduleWatch = (repoRoot: string, paths: Iterable<string>) => {
    if (disposed) return;
    const current = pendingPaths.get(repoRoot) ?? new Set<string>();
    for (const path of paths) current.add(path);
    pendingPaths.set(repoRoot, current);
    scheduleRefresh();
  };

  const takeForcedPaths = (repoRoots: string[]): Set<string> => {
    const paths = new Set<string>();
    for (const root of repoRoots) {
      const entry = pendingPaths.get(root);
      pendingPaths.delete(root);
      if (entry) for (const path of entry) paths.add(path);
    }
    return paths;
  };

  const rememberAndDiff = (
    key: string,
    token: string,
    forced: boolean,
  ): boolean => {
    const prev = fingerprints.get(key);
    fingerprints.set(key, token);
    if (prev === undefined) return forced;
    return forced || prev !== token;
  };

  const syncDiffTarget = async (
    target: Extract<WorktreeDiffTarget, { kind: "diff" }>,
    forcedPaths: Set<string>,
    gen: number,
    requestId: number,
    key: string,
  ) => {
    const state = await window.anchor.history.worktreeDiffState({
      repoRoot: target.repoRoot,
      base: target.base,
    });
    if (disposed || gen !== generation || requestSeq.get(key) !== requestId) return;

    const prefix = `${target.repoRoot}\0${target.base}\0`;
    const listKey = `${prefix}__files__`;
    const live = new Set<string>([listKey]);
    const changedPaths = new Set<string>();
    const listChanged = rememberAndDiff(listKey, filesKey(state.files), false);

    for (const file of state.files) {
      const fp = state.fingerprints.find((item) => item.path === file.path);
      const key = `${prefix}${file.path}`;
      live.add(key);
      const changed = rememberAndDiff(
        key,
        fingerprintToken({ status: file.status, mtimeMs: fp?.mtimeMs, size: fp?.size }),
        forcedPaths.has(file.path),
      );
      if (changed) changedPaths.add(file.path);
    }
    for (const path of forcedPaths) changedPaths.add(path);
    for (const key of [...fingerprints.keys()]) {
      if (key.startsWith(prefix) && !live.has(key)) fingerprints.delete(key);
    }
    if (!listChanged && changedPaths.size === 0) return;
    invalidateWorktreeDiffPaths(target.repoRoot, target.base, changedPaths);
    useDocumentStore.getState().applyWorktreeDiffUpdate({
      repoRoot: target.repoRoot,
      base: target.base,
      files: state.files,
      changedPaths,
    });
  };

  const syncSnapshotTarget = async (
    target: Extract<WorktreeDiffTarget, { kind: "snapshot" }>,
    forcedPaths: Set<string>,
    gen: number,
    requestId: number,
    key: string,
  ) => {
    const refresh = window.anchor.snapshot.refreshWorktree;
    if (typeof refresh !== "function") return;
    const result = await refresh({ baseId: target.baseId });
    if (disposed || gen !== generation || requestSeq.get(key) !== requestId) return;
    const payload = result.payload;
    const prints = result.fingerprints ?? [];

    const prefix = `${target.workspaceRoot}\0${target.baseId}\0`;
    const listKey = `${prefix}__files__`;
    const live = new Set<string>([listKey]);
    const changed: { repoRoot: string; path: string }[] = [];
    const listToken = payload.repos
      .map(
        (repo) =>
          `${repo.root}\0${repo.state}\0${filesKey(repo.files)}\0${repo.largeFiles
            .map((file) => `${file.path}:${file.status}:${file.size}`)
            .join(",")}`,
      )
      .join("\n");
    const listChanged = rememberAndDiff(listKey, listToken, false);

    for (const repo of payload.repos) {
      if (repo.head !== "worktree") continue;
      const repoChanged: string[] = [];
      for (const file of repo.files) {
        const fp = prints.find((item) => item.repoRoot === repo.root && item.path === file.path);
        const key = `${prefix}${repo.root}\0${file.path}`;
        live.add(key);
        const changedFile = rememberAndDiff(
          key,
          fingerprintToken({ status: file.status, mtimeMs: fp?.mtimeMs, size: fp?.size }),
          forcedPaths.has(file.path),
        );
        if (changedFile) {
          changed.push({ repoRoot: repo.root, path: file.path });
          repoChanged.push(file.path);
        }
      }
      for (const file of repo.largeFiles) {
        const key = `${prefix}${repo.root}\0large:${file.path}`;
        live.add(key);
        const changedFile = rememberAndDiff(
          key,
          `${file.status}|${file.size}`,
          forcedPaths.has(file.path),
        );
        if (changedFile) changed.push({ repoRoot: repo.root, path: file.path });
      }
      for (const path of forcedPaths) {
        if (!repoChanged.includes(path) && !changed.some((item) => item.repoRoot === repo.root && item.path === path)) {
          // Path may be new / deleted; still drop any cached worktree snapshot for it.
          repoChanged.push(path);
          changed.push({ repoRoot: repo.root, path });
        }
      }
      invalidateWorktreeDiffPaths(repo.root, repo.base, repoChanged);
    }
    for (const key of [...fingerprints.keys()]) {
      if (key.startsWith(prefix) && !live.has(key)) fingerprints.delete(key);
    }
    if (!listChanged && changed.length === 0) return;
    useDocumentStore.getState().applySnapshotWorktreeDiffUpdate({
      workspaceRoot: target.workspaceRoot,
      baseId: target.baseId,
      repos: payload.repos,
      changedPaths: changed,
    });
  };

  const runTarget = async (target: WorktreeDiffTarget, forcedPaths: Set<string>) => {
    const key = targetKey(target);
    const requestId = (requestSeq.get(key) ?? 0) + 1;
    requestSeq.set(key, requestId);
    const pending = pendingForced.get(key) ?? new Set<string>();
    for (const path of forcedPaths) pending.add(path);
    pendingForced.set(key, pending);
    if (inflight.has(key)) return;
    inflight.add(key);
    const gen = generation;
    try {
      while (!disposed && gen === generation) {
        const latest = requestSeq.get(key) ?? requestId;
        const paths = pendingForced.get(key) ?? new Set<string>();
        pendingForced.set(key, new Set());
        if (target.kind === "diff") await syncDiffTarget(target, paths, gen, latest, key);
        else await syncSnapshotTarget(target, paths, gen, latest, key);
        if (requestSeq.get(key) === latest) break;
      }
    } catch {
      // Background refresh must not toast or tear down the open tab.
    } finally {
      inflight.delete(key);
    }
  };

  const flush = async () => {
    if (disposed) return;
    const targets = collectOpenWorktreeTargets(useDocumentStore.getState().openItems);
    if (targets.length === 0) {
      pendingPaths.clear();
      fingerprints.clear();
      return;
    }
    const gen = generation;
    await Promise.all(
      targets.map((target) => {
        const roots = target.kind === "diff" ? [target.repoRoot] : target.repoRoots;
        return runTarget(target, takeForcedPaths(roots));
      }),
    );
    if (gen === generation && pendingPaths.size && !debounceTimer) scheduleRefresh();
  };

  const offWatch =
    window.anchor?.workspace?.onFileChange?.((event) => {
      const ws = useWorkspaceStore.getState();
      if (!ws.workspaceRoot) return;
      if (event.root && event.root !== ws.workspaceRoot) return;
      if (event.hostProfileId && event.hostProfileId !== ws.hostProfileId) return;
      const targets = collectOpenWorktreeTargets(useDocumentStore.getState().openItems);
      if (targets.length === 0) return;
      const repoRoots = [
        ...new Set(targets.flatMap((target) => (target.kind === "diff" ? [target.repoRoot] : target.repoRoots))),
      ];
      const hits = watchTouchedRepos(event, repoRoots);
      if (hits.size === 0) return;
      for (const [root, paths] of hits) scheduleWatch(root, paths);
    }) ?? (() => undefined);

  const pollMs = () =>
    useWorkspaceStore.getState().hostKind === "local"
      ? WORKTREE_DIFF_SYNC_LOCAL_POLL_MS
      : WORKTREE_DIFF_SYNC_POLL_MS;

  const startPoll = (ms: number) =>
    setActiveInterval(() => {
      if (collectOpenWorktreeTargets(useDocumentStore.getState().openItems).length === 0) return;
      scheduleRefresh();
    }, ms);

  let stopPoll = startPoll(pollMs());

  const unsubHost = useWorkspaceStore.subscribe((state, prev) => {
    if (state.hostKind === prev.hostKind && state.workspaceRoot === prev.workspaceRoot) return;
    resetSession();
    stopPoll();
    stopPoll = startPoll(
      state.hostKind === "local" ? WORKTREE_DIFF_SYNC_LOCAL_POLL_MS : WORKTREE_DIFF_SYNC_POLL_MS,
    );
  });

  const unsubDocs = useDocumentStore.subscribe((state, prev) => {
    if (state.openItems === prev.openItems) return;
    if (collectOpenWorktreeTargets(state.openItems).length === 0) fingerprints.clear();
  });

  return () => {
    disposed = true;
    resetSession();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    offWatch();
    stopPoll();
    unsubHost();
    unsubDocs();
  };
}
