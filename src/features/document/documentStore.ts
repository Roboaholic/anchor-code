import { create } from "zustand";
import {
  basename,
  isMarkdownPath,
  languageFromPath,
  relativeToRoot,
} from "@/core/workspace/paths";
import type { DiffFile, DiffOpenPayload } from "@/shared/anchor-api";

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

  openWelcome: () => void;
  openFile: (opts: {
    path: string;
    workspaceRoot: string | null;
    revealLine?: number;
    focusCommentId?: string | null;
    searchHighlight?: Omit<SearchHighlight, "nonce"> | null;
  }) => Promise<void>;
  openDiff: (payload: DiffOpenPayload) => void;
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

export const useDocumentStore = create<DocumentState>((set, get) => ({
  openItems: [welcomeItem()],
  activeId: "welcome",

  openWelcome: () => {
    const { openItems } = get();
    if (!openItems.some((i) => i.kind === "welcome")) {
      set({ openItems: [welcomeItem(), ...openItems], activeId: "welcome" });
    } else {
      set({ activeId: "welcome" });
    }
  },

  openFile: async ({
    path,
    workspaceRoot,
    revealLine,
    focusCommentId,
    searchHighlight,
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
        activeId: existing.id,
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
      return;
    }

    const title = basename(normalizedPath);
    const relativePath = workspaceRoot
      ? relativeToRoot(workspaceRoot, normalizedPath) || title
      : normalizedPath;
    const language = languageFromPath(normalizedPath);
    const isMarkdown = isMarkdownPath(normalizedPath);

    const loading: OpenItem = {
      id,
      kind: "file",
      path: normalizedPath,
      title,
      relativePath,
      language,
      isMarkdown,
      content: "",
      truncated: false,
      size: 0,
      mdViewMode: isMarkdown && nextHighlight ? "raw" : "rendered",
      revealLine,
      focusCommentId: focusCommentId ?? null,
      revealNonce: 1,
      searchHighlight: nextHighlight ?? null,
    };

    set((s) => {
      const without = s.openItems.filter((i) => i.id !== id);
      return { openItems: [...without, loading], activeId: id };
    });

    try {
      const result = await window.anchor.workspace.readText(normalizedPath);
      set((s) => ({
        openItems: s.openItems.map((item) =>
          item.id === id && item.kind === "file"
            ? {
                ...item,
                content: result.text,
                size: result.size,
                truncated: result.truncated,
                error: undefined,
                // MD annotations: prefer raw when opening for comment workflow later
                mdViewMode: item.isMarkdown ? "rendered" : item.mdViewMode,
              }
            : item,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        openItems: s.openItems.map((item) =>
          item.id === id && item.kind === "file"
            ? { ...item, content: "", error: message }
            : item,
        ),
      }));
    }
  },

  openDiff: (payload) => {
    const id = diffItemId(payload);
    const preferred =
      payload.activeFilePath &&
      payload.files.some((f) => f.path === payload.activeFilePath)
        ? payload.activeFilePath
        : (payload.files[0]?.path ?? null);
    const item: OpenItem = {
      id,
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
    set((s) => {
      const without = s.openItems.filter((i) => i.id !== id);
      return { openItems: [...without, item], activeId: id };
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
    set((s) => ({
      openItems: s.openItems.map((item) =>
        item.id === existing.id && item.kind === "file"
          ? { ...item, content }
          : item,
      ),
    }));
  },
}));
