import { create } from "zustand";
import {
  WORKTREE_SELECTION,
  compareLabel,
  resolveCompareRange,
  swapSelection,
  toggleCommitSelection,
} from "@/core/history/selection";
import {
  makeCompareEntry,
  type CompareEntry,
} from "@/core/history/recentCompare";
import type {
  CommitRow,
  DiffOpenPayload,
  HistoryCompareEntry,
  RepoInfo,
  RepoStatus,
  StatusEntry,
} from "@/shared/anchor-api";

export type RepoLogStatus = "idle" | "loading" | "error";
export type RepoStatusState = "idle" | "loading" | "error";

export interface RepoCardState {
  root: string;
  name: string;
  /** Whole repo row expanded. */
  expanded: boolean;
  /** Sections inside the repo (Changes default open). */
  changesOpen: boolean;
  historyOpen: boolean;
  comparesOpen: boolean;
  commits: CommitRow[];
  logStatus: RepoLogStatus;
  logError: string | null;
  selectedHashes: string[];
  status: RepoStatus | null;
  statusState: RepoStatusState;
  statusError: string | null;
  comparing: boolean;
}

export interface HistoryState {
  workspaceRoot: string | null;
  discoverStatus: "idle" | "loading" | "error";
  discoverError: string | null;
  repos: RepoCardState[];
  /** Flat list for workspace; UI filters by repoRoot. */
  recentCompares: HistoryCompareEntry[];
  toast: string | null;

  discover: (workspaceRoot: string) => Promise<void>;
  refreshStatus: (repoRoot: string) => Promise<void>;
  refreshAllStatuses: () => Promise<void>;
  toggleExpanded: (repoRoot: string) => void;
  toggleChanges: (repoRoot: string) => void;
  toggleHistory: (repoRoot: string) => Promise<void>;
  toggleCompares: (repoRoot: string) => void;
  toggleCommit: (repoRoot: string, hash: string) => void;
  swap: (repoRoot: string) => void;
  clearToast: () => void;
  /** Explicit Start Compare for a repo selection (may include worktree). */
  runCompare: (repoRoot: string) => Promise<DiffOpenPayload | null>;
  /** Re-open a recent compare without re-selecting commits. */
  openRecentCompare: (entry: HistoryCompareEntry) => Promise<DiffOpenPayload | null>;
  removeRecent: (id: string) => Promise<void>;
  loadRecent: (workspaceRoot: string) => Promise<void>;
  reset: () => void;
}

function emptyCard(repo: RepoInfo): RepoCardState {
  return {
    root: repo.root,
    name: repo.name,
    expanded: false,
    changesOpen: true,
    historyOpen: false,
    comparesOpen: false,
    commits: [],
    logStatus: "idle",
    logError: null,
    selectedHashes: [],
    status: null,
    statusState: "idle",
    statusError: null,
    comparing: false,
  };
}

function mapCard(
  repos: RepoCardState[],
  repoRoot: string,
  patch: Partial<RepoCardState>,
): RepoCardState[] {
  return repos.map((r) => (r.root === repoRoot ? { ...r, ...patch } : r));
}

function findCard(
  repos: RepoCardState[],
  repoRoot: string,
): RepoCardState | undefined {
  return repos.find((r) => r.root === repoRoot);
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  workspaceRoot: null,
  discoverStatus: "idle",
  discoverError: null,
  repos: [],
  recentCompares: [],
  toast: null,

  reset: () =>
    set({
      workspaceRoot: null,
      discoverStatus: "idle",
      discoverError: null,
      repos: [],
      recentCompares: [],
      toast: null,
    }),

  clearToast: () => set({ toast: null }),

  loadRecent: async (workspaceRoot) => {
    try {
      const list = await window.anchor.history.getRecentCompares(workspaceRoot);
      set({ recentCompares: list });
    } catch {
      // non-fatal
    }
  },

  discover: async (workspaceRoot) => {
    set({
      workspaceRoot,
      discoverStatus: "loading",
      discoverError: null,
      toast: null,
    });
    try {
      const found = await Promise.race([
        window.anchor.history.discover(workspaceRoot),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "Scanning timed out (20s). WSL may be cold-starting — try Rescan.",
                ),
              ),
            20_000,
          );
        }),
      ]);
      const repos = found.map(emptyCard);
      set({ repos, discoverStatus: "idle", discoverError: null });
      void get().loadRecent(workspaceRoot);
      void get().refreshAllStatuses();
    } catch (err) {
      set({
        discoverStatus: "error",
        discoverError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshAllStatuses: async () => {
    const { repos } = get();
    // Cap concurrency — WSL chokes on 50+ parallel git status.
    const concurrency = 4;
    let i = 0;
    async function worker() {
      while (i < repos.length) {
        const idx = i++;
        const r = repos[idx];
        if (!r) break;
        await get().refreshStatus(r.root);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, Math.max(repos.length, 1)) }, () =>
        worker(),
      ),
    );
  },

  refreshStatus: async (repoRoot) => {
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, {
        statusState: "loading",
        statusError: null,
      }),
    }));
    try {
      const status = await window.anchor.history.status(repoRoot);
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          status,
          statusState: "idle",
          statusError: null,
        }),
      }));
    } catch (err) {
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          statusState: "error",
          statusError: err instanceof Error ? err.message : String(err),
        }),
      }));
    }
  },

  toggleExpanded: (repoRoot) => {
    set((s) => {
      const card = findCard(s.repos, repoRoot);
      if (!card) return s;
      return {
        repos: mapCard(s.repos, repoRoot, { expanded: !card.expanded }),
      };
    });
  },

  toggleChanges: (repoRoot) => {
    set((s) => {
      const card = findCard(s.repos, repoRoot);
      if (!card) return s;
      return {
        repos: mapCard(s.repos, repoRoot, {
          changesOpen: !card.changesOpen,
        }),
      };
    });
  },

  toggleCompares: (repoRoot) => {
    set((s) => {
      const card = findCard(s.repos, repoRoot);
      if (!card) return s;
      return {
        repos: mapCard(s.repos, repoRoot, {
          comparesOpen: !card.comparesOpen,
        }),
      };
    });
  },

  toggleHistory: async (repoRoot) => {
    const card = findCard(get().repos, repoRoot);
    if (!card) return;
    if (card.historyOpen) {
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, { historyOpen: false }),
      }));
      return;
    }
    // Open + load log (lazy)
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, {
        historyOpen: true,
        expanded: true,
        logStatus: "loading",
        logError: null,
      }),
    }));
    try {
      const commits = await window.anchor.history.loadLog(repoRoot);
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          commits,
          logStatus: "idle",
          logError: null,
        }),
      }));
    } catch (err) {
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          commits: [],
          logStatus: "error",
          logError: err instanceof Error ? err.message : String(err),
        }),
      }));
    }
  },

  toggleCommit: (repoRoot, hash) => {
    const card = findCard(get().repos, repoRoot);
    if (!card) return;
    const result = toggleCommitSelection(card.selectedHashes, hash);
    if (!result.ok) {
      set({
        toast: result.reason,
        repos: mapCard(get().repos, repoRoot, {
          selectedHashes: result.selectedHashes,
        }),
      });
      return;
    }
    set({
      toast: null,
      repos: mapCard(get().repos, repoRoot, {
        selectedHashes: result.selectedHashes,
      }),
    });
  },

  swap: (repoRoot) => {
    const card = findCard(get().repos, repoRoot);
    if (!card) return;
    set({
      repos: mapCard(get().repos, repoRoot, {
        selectedHashes: swapSelection(card.selectedHashes),
      }),
    });
  },

  runCompare: async (repoRoot) => {
    const card = findCard(get().repos, repoRoot);
    const workspaceRoot = get().workspaceRoot;
    if (!card) {
      set({ toast: "Repository not found" });
      return null;
    }

    const range = resolveCompareRange(card.selectedHashes);
    if (!range) {
      set({
        toast: "Select uncommitted changes and/or one or two commits",
      });
      return null;
    }
    const { base, head } = range;

    set({
      toast: null,
      repos: mapCard(get().repos, repoRoot, { comparing: true }),
    });
    try {
      const payload = await window.anchor.history.compare({
        repoRoot,
        base,
        head,
      });
      const shortOf = (h: string) => {
        if (h === "HEAD") return "HEAD";
        if (h === WORKTREE_SELECTION) return "worktree";
        return (
          card.commits.find((c) => c.hash === h)?.shortHash ?? h.slice(0, 7)
        );
      };
      const label = compareLabel(card.selectedHashes, shortOf);
      payload.title = `${card.name} · ${label ?? payload.title}`;

      await persistRecent(workspaceRoot, card, base, head, payload.title);

      set((s) => ({
        repos: mapCard(s.repos, repoRoot, { comparing: false }),
      }));
      return payload;
    } catch (err) {
      set((s) => ({
        toast: err instanceof Error ? err.message : String(err),
        repos: mapCard(s.repos, repoRoot, { comparing: false }),
      }));
      return null;
    }
  },

  openRecentCompare: async (entry) => {
    const workspaceRoot = get().workspaceRoot;
    const card = findCard(get().repos, entry.repoRoot);
    set({ toast: null });
    if (card) {
      set({
        repos: mapCard(get().repos, entry.repoRoot, { comparing: true }),
      });
    }
    try {
      const payload = await window.anchor.history.compare({
        repoRoot: entry.repoRoot,
        base: entry.base,
        head: entry.head,
      });
      payload.title = entry.label.startsWith(entry.repoName)
        ? entry.label
        : `${entry.repoName} · ${entry.label}`;
      await persistRecent(
        workspaceRoot,
        card ?? {
          root: entry.repoRoot,
          name: entry.repoName,
          commits: [],
        },
        entry.base,
        entry.head,
        payload.title,
      );
      if (card) {
        set((s) => ({
          repos: mapCard(s.repos, entry.repoRoot, { comparing: false }),
        }));
      }
      return payload;
    } catch (err) {
      set((s) => ({
        toast: err instanceof Error ? err.message : String(err),
        repos: card
          ? mapCard(s.repos, entry.repoRoot, { comparing: false })
          : s.repos,
      }));
      return null;
    }
  },

  removeRecent: async (id) => {
    const workspaceRoot = get().workspaceRoot;
    if (!workspaceRoot) return;
    try {
      const list = await window.anchor.history.removeRecentCompare({
        workspaceRoot,
        id,
      });
      set({ recentCompares: list });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },
}));

async function persistRecent(
  workspaceRoot: string | null,
  card: { root: string; name: string; commits?: CommitRow[] },
  base: string,
  head: string | "worktree",
  label: string,
): Promise<void> {
  if (!workspaceRoot) return;
  const entry = makeCompareEntry({
    repoRoot: card.root,
    repoName: card.name,
    base,
    head,
    label,
  });
  try {
    const list = await window.anchor.history.pushRecentCompare({
      workspaceRoot,
      entry,
    });
    useHistoryStore.setState({ recentCompares: list });
  } catch {
    // non-fatal — still open the diff
  }
}

export function selectionLabelForCard(card: RepoCardState): string | null {
  const shortOf = (h: string) =>
    card.commits.find((c) => c.hash === h)?.shortHash ?? h.slice(0, 7);
  return compareLabel(card.selectedHashes, shortOf);
}

export function recentForRepo(
  recent: HistoryCompareEntry[],
  repoRoot: string,
): HistoryCompareEntry[] {
  return recent.filter((e) => e.repoRoot === repoRoot);
}

export function statusEntries(card: RepoCardState): StatusEntry[] {
  return card.status?.entries ?? [];
}

export { WORKTREE_SELECTION };
export type { CompareEntry };
