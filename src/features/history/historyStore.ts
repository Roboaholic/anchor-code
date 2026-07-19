import { create } from "zustand";
import {
  compareLabel,
  swapSelection,
  toggleCommitSelection,
} from "@/core/history/selection";
import type {
  CommitRow,
  DiffOpenPayload,
  RepoInfo,
} from "@/shared/anchor-api";

export interface HistoryState {
  repos: RepoInfo[];
  selectedRepoRoot: string | null;
  commits: CommitRow[];
  logStatus: "idle" | "loading" | "error";
  logError: string | null;
  selectedHashes: string[];
  toast: string | null;
  lastCompare: DiffOpenPayload | null;
  comparing: boolean;

  discover: (workspaceRoot: string) => Promise<void>;
  selectRepo: (repoRoot: string) => Promise<void>;
  toggleCommit: (hash: string) => void;
  swap: () => void;
  clearToast: () => void;
  runCompare: () => Promise<DiffOpenPayload | null>;
  reset: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  repos: [],
  selectedRepoRoot: null,
  commits: [],
  logStatus: "idle",
  logError: null,
  selectedHashes: [],
  toast: null,
  lastCompare: null,
  comparing: false,

  reset: () =>
    set({
      repos: [],
      selectedRepoRoot: null,
      commits: [],
      logStatus: "idle",
      logError: null,
      selectedHashes: [],
      lastCompare: null,
      toast: null,
    }),

  discover: async (workspaceRoot) => {
    set({ logStatus: "loading", logError: null });
    try {
      const repos = await window.anchor.history.discover(workspaceRoot);
      set({ repos });
      if (repos.length === 0) {
        set({
          selectedRepoRoot: null,
          commits: [],
          logStatus: "idle",
          selectedHashes: [],
        });
        return;
      }
      const preferred =
        repos.find((r) => r.root === workspaceRoot)?.root ?? repos[0]!.root;
      await get().selectRepo(preferred);
    } catch (err) {
      set({
        logStatus: "error",
        logError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectRepo: async (repoRoot) => {
    set({
      selectedRepoRoot: repoRoot,
      selectedHashes: [],
      commits: [],
      logStatus: "loading",
      logError: null,
    });
    try {
      const commits = await window.anchor.history.loadLog(repoRoot);
      set({ commits, logStatus: "idle" });
    } catch (err) {
      set({
        logStatus: "error",
        logError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  toggleCommit: (hash) => {
    const result = toggleCommitSelection(get().selectedHashes, hash);
    if (!result.ok) {
      set({ toast: result.reason, selectedHashes: result.selectedHashes });
      return;
    }
    set({ selectedHashes: result.selectedHashes, toast: null });
  },

  swap: () => {
    set({ selectedHashes: swapSelection(get().selectedHashes) });
  },

  clearToast: () => set({ toast: null }),

  runCompare: async () => {
    const { selectedRepoRoot, selectedHashes, commits } = get();
    if (!selectedRepoRoot) {
      set({ toast: "No repository selected" });
      return null;
    }
    if (selectedHashes.length === 0) {
      set({ toast: "Select one commit (vs worktree) or two commits" });
      return null;
    }
    set({ comparing: true, toast: null });
    try {
      const base = selectedHashes[0]!;
      const head =
        selectedHashes.length === 2 ? selectedHashes[1]! : ("worktree" as const);
      const payload = await window.anchor.history.compare({
        repoRoot: selectedRepoRoot,
        base,
        head,
      });
      // enrich short titles from commits if available
      const shortOf = (h: string) =>
        commits.find((c) => c.hash === h)?.shortHash ?? h.slice(0, 7);
      if (payload.head !== "worktree" && selectedHashes.length === 2) {
        payload.title = `${shortOf(base)} → ${shortOf(selectedHashes[1]!)}`;
      } else {
        payload.title = `${shortOf(base)} → worktree`;
      }
      set({ lastCompare: payload, comparing: false });
      return payload;
    } catch (err) {
      set({
        comparing: false,
        toast: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
}));

export function selectionLabel(
  selectedHashes: string[],
  commits: CommitRow[],
): string | null {
  const shortOf = (h: string) =>
    commits.find((c) => c.hash === h)?.shortHash ?? h.slice(0, 7);
  return compareLabel(selectedHashes, shortOf);
}
