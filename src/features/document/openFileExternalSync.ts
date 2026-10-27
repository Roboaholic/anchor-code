import { setActiveInterval } from "@/shared/appActivity";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  normalizeOpenFilePath,
  useDocumentStore,
  type OpenItem,
} from "./documentStore";

/** Debounce bursty local watch / save storms before stating open tabs. */
export const OPEN_FILE_SYNC_DEBOUNCE_MS = 350;
/** Poll open-tab fingerprints when fs.watch is unavailable (WSL / SSH). */
export const OPEN_FILE_SYNC_POLL_MS = 3_000;
/** Slow safety-net poll while a native watcher is already covering the tree. */
export const OPEN_FILE_SYNC_LOCAL_POLL_MS = 15_000;

type DiskStat = { mtimeMs: number; size: number };

function openFileItems(items: OpenItem[]): Extract<OpenItem, { kind: "file" }>[] {
  return items.filter((item): item is Extract<OpenItem, { kind: "file" }> => item.kind === "file");
}

function pathsNeedingWatch(items: OpenItem[]): string[] {
  return openFileItems(items)
    .filter((item) => item.loadState === "loaded" && !item.error)
    .map((item) => item.path);
}

async function statPath(path: string): Promise<DiskStat | null> {
  try {
    const st = await window.anchor.workspace.stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Compare disk fingerprints for currently open file tabs and reload or prompt.
 * Safe to call often; no-ops when nothing changed.
 */
export async function checkOpenFilesAgainstDisk(paths?: string[]): Promise<void> {
  const wanted = new Set(
    (paths ?? pathsNeedingWatch(useDocumentStore.getState().openItems)).map(normalizeOpenFilePath),
  );
  if (wanted.size === 0) return;
  const files = openFileItems(useDocumentStore.getState().openItems).filter((item) =>
    wanted.has(normalizeOpenFilePath(item.path)),
  );
  await Promise.all(
    files.map(async (file) => {
      const st = await statPath(file.path);
      if (!st) return;
      useDocumentStore.getState().applyExternalDiskStat(file.path, st);
    }),
  );
}

type FileChangeEvent = {
  root?: string;
  hostProfileId?: string;
  dir: string;
  changes?: { path: string; rel: string; eventType: string; kind?: string }[];
};

/** Paths from a watch batch that might affect an open tab (content or rename). */
export function openPathsTouchedByWatchEvent(
  event: FileChangeEvent,
  openPaths: string[],
): string[] {
  if (!openPaths.length) return [];
  const open = new Set(openPaths.map(normalizeOpenFilePath));
  const hit = new Set<string>();
  for (const change of event.changes ?? []) {
    const key = normalizeOpenFilePath(change.path);
    if (open.has(key)) hit.add(key);
  }
  // Directory-only batches (no per-file list) still warrant a check of open files under dir.
  if (!event.changes?.length && event.dir) {
    const dir = normalizeOpenFilePath(event.dir).replace(/\/+$/, "");
    for (const path of open) {
      if (path === dir || path.startsWith(`${dir}/`)) hit.add(path);
    }
  }
  return [...hit];
}

/**
 * Subscribe to local fs.watch batches and/or poll open tabs on remote hosts.
 * Returns a disposer. Idempotent start/stop for the current workspace.
 */
export function startOpenFileExternalSync(): () => void {
  if (typeof window === "undefined") return () => undefined;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();
  let disposed = false;

  const flush = () => {
    debounceTimer = null;
    if (disposed) return;
    const paths = [...pending];
    pending.clear();
    void checkOpenFilesAgainstDisk(paths.length ? paths : undefined);
  };

  const schedule = (paths: string[]) => {
    for (const path of paths) pending.add(normalizeOpenFilePath(path));
    if (debounceTimer) return;
    debounceTimer = setTimeout(flush, OPEN_FILE_SYNC_DEBOUNCE_MS);
  };

  const offWatch =
    window.anchor?.workspace?.onFileChange?.((event) => {
      const ws = useWorkspaceStore.getState();
      if (!ws.workspaceRoot) return;
      if (event.root && event.root !== ws.workspaceRoot) return;
      if (event.hostProfileId && event.hostProfileId !== ws.hostProfileId) return;
      const openPaths = pathsNeedingWatch(useDocumentStore.getState().openItems);
      const touched = openPathsTouchedByWatchEvent(event, openPaths);
      if (touched.length) schedule(touched);
    }) ?? (() => undefined);

  const hostKind = () => useWorkspaceStore.getState().hostKind;
  const pollMs = () =>
    hostKind() === "local" ? OPEN_FILE_SYNC_LOCAL_POLL_MS : OPEN_FILE_SYNC_POLL_MS;

  // Re-create the interval when the host kind changes by checking each tick's cadence
  // via a short base interval is awkward; use the remote interval and skip extras on local
  // by comparing elapsed — simpler: always poll at remote rate on non-local, slow on local.
  let stopPoll = setActiveInterval(() => {
    void checkOpenFilesAgainstDisk();
  }, pollMs());

  const unsubHost = useWorkspaceStore.subscribe((state, prev) => {
    if (state.hostKind === prev.hostKind && state.workspaceRoot === prev.workspaceRoot) return;
    stopPoll();
    stopPoll = setActiveInterval(() => {
      void checkOpenFilesAgainstDisk();
    }, state.hostKind === "local" ? OPEN_FILE_SYNC_LOCAL_POLL_MS : OPEN_FILE_SYNC_POLL_MS);
  });

  return () => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pending.clear();
    offWatch();
    stopPoll();
    unsubHost();
  };
}
