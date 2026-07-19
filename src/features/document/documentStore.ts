import { create } from "zustand";
import {
  basename,
  isMarkdownPath,
  languageFromPath,
  relativeToRoot,
} from "@/core/workspace/paths";

export type MdViewMode = "rendered" | "raw";

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
    }
  | {
      id: string;
      kind: "diff";
      title: string;
      repoRoot: string;
      base: string;
      head: string | "worktree";
    };

export interface DocumentState {
  openItems: OpenItem[];
  activeId: string | null;

  openWelcome: () => void;
  openFile: (opts: {
    path: string;
    workspaceRoot: string | null;
  }) => Promise<void>;
  closeItem: (id: string) => void;
  setActive: (id: string) => void;
  setMdViewMode: (id: string, mode: MdViewMode) => void;
  closeAllFiles: () => void;
}

function welcomeItem(): OpenItem {
  return { id: "welcome", kind: "welcome", title: "Welcome" };
}

function fileItemId(path: string): string {
  return `file:${path}`;
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

  openFile: async ({ path, workspaceRoot }) => {
    const id = fileItemId(path);
    const existing = get().openItems.find((i) => i.id === id);
    if (existing && existing.kind === "file" && !existing.error) {
      set({ activeId: id });
      return;
    }

    const title = basename(path);
    const relativePath = workspaceRoot
      ? relativeToRoot(workspaceRoot, path) || title
      : path;
    const language = languageFromPath(path);
    const isMarkdown = isMarkdownPath(path);

    // Placeholder tab while loading
    const loading: OpenItem = {
      id,
      kind: "file",
      path,
      title,
      relativePath,
      language,
      isMarkdown,
      content: "",
      truncated: false,
      size: 0,
      mdViewMode: "rendered",
    };

    set((s) => {
      const without = s.openItems.filter((i) => i.id !== id);
      return { openItems: [...without, loading], activeId: id };
    });

    try {
      const result = await window.anchor.workspace.readText(path);
      set((s) => ({
        openItems: s.openItems.map((item) =>
          item.id === id && item.kind === "file"
            ? {
                ...item,
                content: result.text,
                size: result.size,
                truncated: result.truncated,
                error: undefined,
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

  setActive: (id) => set({ activeId: id }),

  setMdViewMode: (id, mode) => {
    set((s) => ({
      openItems: s.openItems.map((item) =>
        item.id === id && item.kind === "file"
          ? { ...item, mdViewMode: mode }
          : item,
      ),
    }));
  },

  closeAllFiles: () => {
    set({ openItems: [welcomeItem()], activeId: "welcome" });
  },
}));
