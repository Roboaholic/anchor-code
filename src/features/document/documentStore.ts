import { create } from "zustand";
import {
  basename,
  isMarkdownPath,
  languageFromPath,
  relativeToRoot,
} from "@/core/workspace/paths";
import type { DiffFile, DiffOpenPayload } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import { isRasterImagePath } from "@/core/workspace/markdownLinks";
import { invalidateWorktreeDiffCache } from "./fileDiffCache";

export type MdViewMode = "rendered" | "raw";

/** Temporary editor highlight when jumping from workspace search. */
export type SearchHighlight = {
  line: number;
  query: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  /** Bumps so the same line can be re-highlighted on every click. */
  nonce: number;
};

export type PersistedOpenItem =
  | { kind: "welcome" }
  | { kind: "file"; path: string; mdViewMode: MdViewMode }
  | {
      kind: "diff";
      title: string;
      repoRoot: string;
      base: string;
      head: string | "worktree";
      files: DiffFile[];
      activeFilePath: string | null;
      branch?: string | null;
      hideFileList?: boolean;
    };

export interface PersistedDocumentState {
  openItems: PersistedOpenItem[];
  activeIndex: number;
}

const WORKSPACE_DOCUMENTS_KEY = "anchor.workspace.documents.v1";
type DocumentWorkspaceView = { openItems: OpenItem[]; activeId: string | null };
const documentWorkspaceViews = new Map<string, DocumentWorkspaceView>();
// Requests belong to a particular document view, not merely to a path. A host
// switch or close/reopen can produce the same path while an old read is pending.
const fileLoads = new Map<string, { promise: Promise<void> }>();

export function dropWorkspaceDocumentView(
  workspaceRoot: string,
  hostProfileId: string | null,
): void {
  documentWorkspaceViews.delete(workspaceKey(workspaceRoot, hostProfileId));
}

function workspaceKey(workspaceRoot: string, hostProfileId: string | null): string {
  const root = normalizePathKey(workspaceRoot).replace(/\/+$/, "") || "/";
  return `${hostProfileId?.trim() || "local-default"}::${root}`;
}

/** Keys written by older builds (null/"" host and raw root), read as fallback. */
function legacyWorkspaceKeys(workspaceRoot: string, hostProfileId: string | null): string[] {
  const raw = normalizePathKey(workspaceRoot);
  const hosts = new Set([hostProfileId ?? "local-default", hostProfileId?.trim() || "local-default"]);
  const keys: string[] = [];
  for (const host of hosts) {
    keys.push(`${host}::${raw}`, `${host}::${raw.replace(/\/+$/, "")}`, `${host}::${raw}/`);
  }
  const current = workspaceKey(workspaceRoot, hostProfileId);
  return [...new Set(keys)].filter((k) => k !== current);
}

function readSavedDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): PersistedDocumentState | undefined {
  const saved = readPersistedDocuments();
  const current = saved[workspaceKey(workspaceRoot, hostProfileId)];
  if (current) return current;
  for (const key of legacyWorkspaceKeys(workspaceRoot, hostProfileId)) {
    if (saved[key]) return saved[key];
  }
  return undefined;
}

function readPersistedDocuments(): Record<string, PersistedDocumentState> {
  try {
    const raw = localStorage.getItem(WORKSPACE_DOCUMENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, PersistedDocumentState>)
      : {};
  } catch {
    return {};
  }
}

function persistedItem(item: OpenItem): PersistedOpenItem {
  if (item.kind === "welcome") return { kind: "welcome" };
  if (item.kind === "file") {
    return { kind: "file", path: item.path, mdViewMode: item.mdViewMode };
  }
  return {
    kind: "diff",
    title: item.title,
    repoRoot: item.repoRoot,
    base: item.base,
    head: item.head,
    files: item.files,
    activeFilePath: item.activeFilePath,
    branch: item.branch,
    hideFileList: item.hideFileList,
  };
}

export function captureWorkspaceDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): void {
  const state = useDocumentStore.getState();
  documentWorkspaceViews.set(workspaceKey(workspaceRoot, hostProfileId), {
    openItems: state.openItems,
    activeId: state.activeId,
  });
}

export function restoreCachedWorkspaceDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): boolean {
  const cached = documentWorkspaceViews.get(workspaceKey(workspaceRoot, hostProfileId));
  if (!cached) return false;
  restoringDocuments += 1;
  cancelDocumentAutosave();
  try {
    fileLoads.clear();
    useDocumentStore.setState({
      // Reads from a parked view cannot complete into this view. Restart only
      // the selected one; its other unloaded tabs remain lazy.
      openItems: cached.openItems.map((item) =>
        item.kind === "file" && item.loadState === "loading"
          ? { ...item, loadState: "deferred" as const }
          : item,
      ),
      activeId: cached.activeId,
    });
  } finally {
    restoringDocuments -= 1;
  }
  return true;
}

export function saveWorkspaceDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): void {
  try {
    const state = useDocumentStore.getState();
    captureWorkspaceDocuments(workspaceRoot, hostProfileId);
    const activeIndex = Math.max(
      0,
      state.openItems.findIndex((item) => item.id === state.activeId),
    );
    const saved = readPersistedDocuments();
    for (const key of legacyWorkspaceKeys(workspaceRoot, hostProfileId)) delete saved[key];
    saved[workspaceKey(workspaceRoot, hostProfileId)] = {
      openItems: state.openItems.map(persistedItem),
      activeIndex,
    };
    localStorage.setItem(WORKSPACE_DOCUMENTS_KEY, JSON.stringify(saved));
  } catch {
    // Persistence must not interrupt navigation.
  }
}

export async function restoreWorkspaceDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): Promise<void> {
  if (restoreCachedWorkspaceDocuments(workspaceRoot, hostProfileId)) {
    const activeId = useDocumentStore.getState().activeId;
    if (activeId) await ensureFileLoaded(activeId);
    return;
  }
  restoringDocuments += 1;
  cancelDocumentAutosave();
  let activeLoad: Promise<void>;
  try {
    activeLoad = restoreSavedDocuments(workspaceRoot, hostProfileId);
  } finally {
    // Metadata is restored synchronously. A slow host read must not suppress
    // autosaves of user actions in this or a subsequently selected workspace.
    restoringDocuments -= 1;
  }
  await activeLoad;
}

function restoreSavedDocuments(
  workspaceRoot: string,
  hostProfileId: string | null,
): Promise<void> {
  const saved = readSavedDocuments(workspaceRoot, hostProfileId);
  fileLoads.clear();
  if (!saved || !Array.isArray(saved.openItems) || saved.openItems.length === 0) {
    useDocumentStore.setState({ openItems: [welcomeItem()], activeId: "welcome" });
    return Promise.resolve();
  }

  const openItems: OpenItem[] = [];
  const restoredIds: Array<string | undefined> = [];
  for (const item of saved.openItems) {
    let restored: OpenItem | undefined;
    if (item?.kind === "welcome") {
      restored = welcomeItem();
    } else if (item?.kind === "file" && typeof item.path === "string") {
      restored = fileItem(item.path, workspaceRoot);
      restored.mdViewMode = item.mdViewMode === "raw" ? "raw" : "rendered";
    } else if (
      item?.kind === "diff" &&
      typeof item.repoRoot === "string" &&
      typeof item.base === "string" &&
      typeof item.head === "string" &&
      Array.isArray(item.files)
    ) {
      if (item.head === "worktree") invalidateWorktreeDiffCache(item.repoRoot, item.base);
      restored = diffItem(item);
    }
    restoredIds.push(restored?.id);
    if (restored && !openItems.some((existing) => existing.id === restored.id)) {
      openItems.push(restored);
    }
  }
  if (openItems.length === 0) openItems.push(welcomeItem());
  const activeId = restoredIds[saved.activeIndex] ?? openItems.at(-1)!.id;
  // Restore the tab strip and selection in one update. Only the selected file
  // is read; selecting another deferred tab starts its read on demand.
  useDocumentStore.setState({ openItems, activeId });
  return ensureFileLoaded(activeId);
}

export type OpenItem =
  | {
      id: string;
      kind: "welcome";
      title: string;
    }
  | {
      id: string;
      kind: "file";
      path: string;
      title: string;
      relativePath: string;
      language: string;
      isMarkdown: boolean;
      content: string;
      /** Restored inactive tabs carry metadata until selected. */
      loadState?: "deferred" | "loading" | "loaded";
      truncated: boolean;
      size: number;
      mdViewMode: MdViewMode;
      error?: string;
      revealLine?: number;
      /** Comment to emphasize after jump / bubble open. */
      focusCommentId?: string | null;
      /** Bumps on every jump so repeated clicks re-run reveal. */
      revealNonce?: number;
      searchHighlight?: SearchHighlight | null;
    }
  | {
      id: string;
      kind: "diff";
      title: string;
      repoRoot: string;
      base: string;
      head: string | "worktree";
      files: DiffFile[];
      activeFilePath: string | null;
      branch?: string | null;
      /** Hide left file list (single-file focus from Changes). */
      hideFileList?: boolean;
    };

export interface DocumentState {
  openItems: OpenItem[];
  activeId: string | null;

  openWelcome: (opts?: { activate?: boolean }) => void;
  openFile: (opts: {
    path: string;
    workspaceRoot: string | null;
    revealLine?: number;
    focusCommentId?: string | null;
    searchHighlight?: Omit<SearchHighlight, "nonce"> | null;
    /** Restore many tabs without making each one active (avoids N Monaco mounts). */
    activate?: boolean;
  }) => Promise<void>;
  openDiff: (payload: DiffOpenPayload, opts?: { activate?: boolean }) => void;
  setDiffActiveFile: (id: string, filePath: string) => void;
  closeItem: (id: string) => void;
  /** Keep only the tab with `id` (activate it). */
  closeOtherItems: (id: string) => void;
  /** Close every tab to the right of `id` (strip order). */
  closeItemsToTheRight: (id: string) => void;
  /** Close every tab; restores the Welcome tab. */
  closeAllItems: () => void;
  setActive: (id: string) => void;
  /** Move tab at fromIndex to toIndex (array order = strip order). */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setMdViewMode: (id: string, mode: MdViewMode) => void;
  revealInFile: (path: string, line: number) => void;
  /** Alias of closeAllItems (kept for existing callers). */
  closeAllFiles: () => void;
  updateFileContent: (path: string, content: string) => void;
}

function welcomeItem(): OpenItem {
  return { id: "welcome", kind: "welcome", title: "Welcome" };
}

function normalizePathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function fileItemId(path: string): string {
  return `file:${normalizePathKey(path)}`;
}

function findOpenFile(
  openItems: OpenItem[],
  path: string,
): Extract<OpenItem, { kind: "file" }> | undefined {
  const key = normalizePathKey(path);
  return openItems.find(
    (i): i is Extract<OpenItem, { kind: "file" }> =>
      i.kind === "file" && normalizePathKey(i.path) === key,
  );
}

function diffItemId(payload: DiffOpenPayload): string {
  const base = `diff:${payload.repoRoot}:${payload.base}:${payload.head}`;
  if (payload.hideFileList && payload.activeFilePath) {
    return `${base}:${payload.activeFilePath}`;
  }
  return base;
}

function fileItem(path: string, workspaceRoot: string | null): Extract<OpenItem, { kind: "file" }> {
  const normalizedPath = normalizePathKey(path);
  const title = basename(normalizedPath);
  return {
    id: fileItemId(normalizedPath),
    kind: "file",
    path: normalizedPath,
    title,
    relativePath: workspaceRoot ? relativeToRoot(workspaceRoot, normalizedPath) || title : normalizedPath,
    language: languageFromPath(normalizedPath),
    isMarkdown: isMarkdownPath(normalizedPath),
    content: "",
    loadState: "deferred",
    truncated: false,
    size: 0,
    mdViewMode: "rendered",
  };
}

function diffItem(payload: DiffOpenPayload): Extract<OpenItem, { kind: "diff" }> {
  const preferred = payload.activeFilePath && payload.files.some((f) => f.path === payload.activeFilePath)
    ? payload.activeFilePath
    : (payload.files[0]?.path ?? null);
  return {
    id: diffItemId(payload),
    kind: "diff",
    title: payload.title,
    repoRoot: payload.repoRoot,
    base: payload.base,
    head: payload.head,
    files: payload.files,
    activeFilePath: preferred,
    branch: payload.branch ?? null,
    hideFileList: payload.hideFileList === true,
  };
}

function ensureFileLoaded(id: string): Promise<void> {
  const file = useDocumentStore.getState().openItems.find((item) => item.id === id);
  if (file?.kind !== "file") return Promise.resolve();
  const existing = fileLoads.get(id);
  if (existing) return existing.promise;
  if (file.loadState !== "deferred") return Promise.resolve();

  const request = { promise: Promise.resolve() };
  request.promise = Promise.resolve().then(async () => {
    // The user may have switched views before this queued read even started.
    if (fileLoads.get(id) !== request) return;
    try {
      if (isRasterImagePath(file.path)) {
        // Raster images render from bytes in ImageViewer; their text is noise.
        useDocumentStore.setState((state) => ({
          openItems: state.openItems.map((item) =>
            item.id === id && item.kind === "file"
              ? { ...item, content: "", truncated: false, loadState: "loaded", error: undefined }
              : item,
          ),
        }));
        return;
      }
      const result = await window.anchor.workspace.readText(file.path);
      if (fileLoads.get(id) !== request) return;
      useDocumentStore.setState((state) => ({
        openItems: state.openItems.map((item) =>
          item.id === id && item.kind === "file"
            ? { ...item, content: result.text, size: result.size, truncated: result.truncated, loadState: "loaded", error: undefined }
            : item,
        ),
      }));
    } catch (err) {
      if (fileLoads.get(id) !== request) return;
      const error = formatError(err);
      useDocumentStore.setState((state) => ({
        openItems: state.openItems.map((item) =>
          item.id === id && item.kind === "file"
            ? { ...item, content: "", loadState: "loaded", error }
            : item,
        ),
      }));
    } finally {
      if (fileLoads.get(id) === request) fileLoads.delete(id);
    }
  });
  fileLoads.set(id, request);
  useDocumentStore.setState((state) => ({
    openItems: state.openItems.map((item) => item.id === id && item.kind === "file"
      ? { ...item, loadState: "loading" }
      : item),
  }));
  return request.promise;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  openItems: [welcomeItem()],
  activeId: "welcome",

  openWelcome: (opts) => {
    const { openItems } = get();
    const activate = opts?.activate !== false;
    if (!openItems.some((i) => i.kind === "welcome")) {
      set({
        openItems: [welcomeItem(), ...openItems],
        activeId: activate ? "welcome" : get().activeId,
      });
    } else if (activate) {
      set({ activeId: "welcome" });
    }
  },

  openFile: async ({
    path,
    workspaceRoot,
    revealLine,
    focusCommentId,
    searchHighlight,
    activate = true,
  }) => {
    const normalizedPath = normalizePathKey(path);
    const id = fileItemId(normalizedPath);
    const existing = findOpenFile(get().openItems, normalizedPath);
    const nextHighlight: SearchHighlight | null | undefined =
      searchHighlight === undefined
        ? undefined
        : searchHighlight
          ? {
              ...searchHighlight,
              nonce: (existing?.searchHighlight?.nonce ?? 0) + 1,
            }
          : null;
    if (existing && !existing.error) {
      set((s) => ({
        activeId: activate ? existing.id : s.activeId,
        openItems: s.openItems.map((item) =>
          item.id === existing.id && item.kind === "file"
            ? {
                ...item,
                // Keep the already-open host path; only refresh reveal/focus.
                revealLine,
                focusCommentId: focusCommentId ?? null,
                revealNonce: (item.revealNonce ?? 0) + 1,
                ...(nextHighlight !== undefined
                  ? { searchHighlight: nextHighlight }
                  : {}),
                // Search jump: show raw MD so Monaco can highlight the line.
                mdViewMode:
                  nextHighlight && item.isMarkdown
                    ? "raw"
                    : item.mdViewMode,
              }
            : item,
        ),
      }));
      await ensureFileLoaded(existing.id);
      return;
    }

    const loading: OpenItem = {
      ...fileItem(normalizedPath, workspaceRoot),
      mdViewMode: nextHighlight && isMarkdownPath(normalizedPath) ? "raw" : existing?.mdViewMode ?? "rendered",
      revealLine,
      focusCommentId: focusCommentId ?? null,
      revealNonce: (existing?.revealNonce ?? 0) + 1,
      searchHighlight: nextHighlight ?? null,
    };
    fileLoads.delete(id);
    set((s) => ({
      openItems: existing
        ? s.openItems.map((item) => item.id === id ? loading : item)
        : [...s.openItems, loading],
      activeId: activate ? id : s.activeId,
    }));
    await ensureFileLoaded(id);
  },

  openDiff: (payload, opts) => {
    if (payload.head === "worktree") {
      invalidateWorktreeDiffCache(payload.repoRoot, payload.base);
    }
    const item = diffItem(payload);
    const id = item.id;
    set((s) => {
      const without = s.openItems.filter((i) => i.id !== id);
      return {
        openItems: [...without, item],
        activeId: opts?.activate === false ? s.activeId : id,
      };
    });
  },

  setDiffActiveFile: (id, filePath) => {
    set((s) => ({
      openItems: s.openItems.map((item) =>
        item.id === id && item.kind === "diff"
          ? { ...item, activeFilePath: filePath }
          : item,
      ),
    }));
  },

  closeItem: (id) => {
    set((s) => {
      const openItems = s.openItems.filter((i) => i.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = openItems[openItems.length - 1]?.id ?? null;
      }
      if (openItems.length === 0) {
        const w = welcomeItem();
        return { openItems: [w], activeId: w.id };
      }
      return { openItems, activeId };
    });
  },

  closeOtherItems: (id) => {
    set((s) => {
      const keep = s.openItems.find((i) => i.id === id);
      if (!keep) return s;
      return { openItems: [keep], activeId: keep.id };
    });
  },

  closeItemsToTheRight: (id) => {
    set((s) => {
      const idx = s.openItems.findIndex((i) => i.id === id);
      if (idx < 0) return s;
      const openItems = s.openItems.slice(0, idx + 1);
      let activeId = s.activeId;
      if (!openItems.some((i) => i.id === activeId)) {
        activeId = openItems[openItems.length - 1]?.id ?? null;
      }
      if (openItems.length === 0) {
        const w = welcomeItem();
        return { openItems: [w], activeId: w.id };
      }
      return { openItems, activeId };
    });
  },

  closeAllItems: () => {
    set({ openItems: [welcomeItem()], activeId: "welcome" });
  },

  setActive: (id) => set({ activeId: id }),

  reorderTabs: (fromIndex, toIndex) => {
    set((s) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= s.openItems.length ||
        toIndex >= s.openItems.length
      ) {
        return s;
      }
      const openItems = [...s.openItems];
      const [moved] = openItems.splice(fromIndex, 1);
      if (!moved) return s;
      openItems.splice(toIndex, 0, moved);
      // Keep the moved tab active so focus is not lost after drag-and-drop.
      return { openItems, activeId: moved.id };
    });
  },

  setMdViewMode: (id, mode) => {
    set((s) => ({
      openItems: s.openItems.map((item) =>
        item.id === id && item.kind === "file"
          ? { ...item, mdViewMode: mode }
          : item,
      ),
    }));
  },

  revealInFile: (path, line) => {
    const existing = findOpenFile(get().openItems, path);
    if (!existing) return;
    set((s) => ({
      activeId: existing.id,
      openItems: s.openItems.map((item) =>
        item.id === existing.id && item.kind === "file"
          ? {
              ...item,
              revealLine: line,
              revealNonce: (item.revealNonce ?? 0) + 1,
            }
          : item,
      ),
    }));
  },

  closeAllFiles: () => {
    get().closeAllItems();
  },

  updateFileContent: (path, content) => {
    const existing = findOpenFile(get().openItems, path);
    if (!existing) return;
    fileLoads.delete(existing.id);
    set((s) => ({
      openItems: s.openItems.map((item) =>
        item.id === existing.id && item.kind === "file"
          ? { ...item, content, loadState: "loaded" }
          : item,
      ),
    }));
  },
}));

// Selection can change through tab clicks, close/reorder, or comment jumps.
// Handle every path here instead of requiring each caller to remember lazy I/O.
useDocumentStore.subscribe((state) => {
  for (const id of fileLoads.keys()) {
    if (!state.openItems.some((item) => item.id === id && item.kind === "file")) fileLoads.delete(id);
  }
  const selected = state.openItems.find((item) => item.id === state.activeId);
  if (selected?.kind === "file" && selected.loadState === "deferred") {
    void ensureFileLoaded(selected.id);
  }
});

// ---------------------------------------------------------------------------
// Auto-save: persist tab changes (close all, close tab, reorder, open) shortly
// after they happen instead of relying only on beforeunload / workspace switch.

export const DOCUMENT_AUTOSAVE_DELAY_MS = 250;

type AutosaveTarget = { workspaceRoot: string; hostProfileId: string | null };

let restoringDocuments = 0;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTarget: AutosaveTarget | null = null;
let unsubscribeAutosave: (() => void) | null = null;

function cancelDocumentAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
  pendingTarget = null;
}

/** Ask the main process to commit localStorage to disk (Chromium writes lazily). */
function requestStorageFlush(): void {
  try {
    const flush = (globalThis as { window?: { anchor?: { shell?: { flushStorage?: () => Promise<void> } } } })
      .window?.anchor?.shell?.flushStorage;
    void flush?.().catch(() => undefined);
  } catch {
    // best effort
  }
}

/** Write any pending debounced save right now (beforeunload / quit / close workspace). */
export function flushDocumentAutosave(): void {
  const target = pendingTarget;
  cancelDocumentAutosave();
  if (target) saveWorkspaceDocuments(target.workspaceRoot, target.hostProfileId);
}

/**
 * Subscribe to tab changes and save them for the workspace that was current
 * when the change happened. Returns an unsubscribe function.
 */
export function bindDocumentAutosave(
  getTarget: () => AutosaveTarget | null,
  delayMs = DOCUMENT_AUTOSAVE_DELAY_MS,
): () => void {
  unsubscribeAutosave?.();
  const unsubscribe = useDocumentStore.subscribe((state, prev) => {
    if (state.openItems === prev.openItems && state.activeId === prev.activeId) return;
    if (restoringDocuments > 0) return;
    const target = getTarget();
    if (!target?.workspaceRoot) return;
    if (
      pendingTarget &&
      workspaceKey(pendingTarget.workspaceRoot, pendingTarget.hostProfileId) !==
        workspaceKey(target.workspaceRoot, target.hostProfileId)
    ) {
      flushDocumentAutosave();
    }
    pendingTarget = target;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      const t = pendingTarget;
      pendingTarget = null;
      if (t) {
        saveWorkspaceDocuments(t.workspaceRoot, t.hostProfileId);
        requestStorageFlush();
      }
    }, delayMs);
  });
  unsubscribeAutosave = () => {
    unsubscribe();
    cancelDocumentAutosave();
    unsubscribeAutosave = null;
  };
  return unsubscribeAutosave;
}
