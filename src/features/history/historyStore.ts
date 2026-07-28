import { create } from "zustand";
import {
  WORKTREE_SELECTION,
  compareLabel,
  resolveCompareRange,
  toggleCommitSelection,
} from "@/core/history/selection";
import {
  makeCompareEntry,
  type CompareEntry,
} from "@/core/history/recentCompare";
import type {
  BranchInfo,
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
  /** Local branches for switcher (lazy-loaded). */
  branches: BranchInfo[];
  branchesStatus: "idle" | "loading" | "error";
  branchesError: string | null;
  switchingBranch: boolean;
  committing: boolean;
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
  refreshStatus: (
    repoRoot: string,
    opts?: { quiet?: boolean; badgeOnly?: boolean },
  ) => Promise<void>;
  refreshAllStatuses: (opts?: {
    quiet?: boolean;
    badgeOnly?: boolean;
  }) => Promise<void>;
  /**
   * Quiet badge-only refresh (M/A/D/?, ahead/behind).
   * Does not reload commit logs — expand History for that.
   */
  softRefreshStatuses: () => Promise<void>;
  toggleExpanded: (repoRoot: string) => void;
  toggleChanges: (repoRoot: string) => void;
  toggleHistory: (repoRoot: string) => Promise<void>;
  /** Reload commit log for an open History section. */
  refreshLog: (repoRoot: string) => Promise<void>;
  toggleCompares: (repoRoot: string) => void;
  toggleCommit: (repoRoot: string, hash: string) => void;
  loadBranches: (repoRoot: string) => Promise<void>;
  checkoutBranch: (repoRoot: string, branch: string) => Promise<boolean>;
  commitChanges: (repoRoot: string, message: string) => Promise<boolean>;
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
    branches: [],
    branchesStatus: "idle",
    branchesError: null,
    switchingBranch: false,
    committing: false,
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
      // Keep prior status/branch/UI expand state for roots that still exist.
      // Replacing with emptyCard made every row flash "detached" until status returned.
      const prevByRoot = new Map(get().repos.map((r) => [r.root, r]));
      const repos = found.map((info) => {
        const prev = prevByRoot.get(info.root);
        if (prev) {
          return {
            ...prev,
            root: info.root,
            name: info.name,
          };
        }
        return emptyCard(info);
      });
      set({ repos, discoverStatus: "idle", discoverError: null });
      void get().loadRecent(workspaceRoot);
      // Quiet: don't wipe badges mid-refresh; only update under the hood.
      void get().refreshAllStatuses({ quiet: true });
    } catch (err) {
      set({
        discoverStatus: "error",
        discoverError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshAllStatuses: async (opts) => {
    const quiet = opts?.quiet === true;
    // Badge-only is the default for bulk refresh: branch + M/A/D/↑↓ without
    // walking every untracked path. Full status happens when a repo expands.
    const badgeOnly = opts?.badgeOnly !== false;
    const { repos } = get();
    if (repos.length === 0) return;

    // Visible refresh: show a small "…" on every row until that row is updated.
    // Quiet polls keep the UI still.
    if (!quiet) {
      set({
        repos: repos.map((r) => ({
          ...r,
          statusState: "loading" as const,
          statusError: null,
        })),
      });
    }

    // One bulk call on WSL/SSH (N×wsl.exe hangs). Progressive events clear dots.
    if (badgeOnly && typeof window.anchor.history.statusBulk === "function") {
      const prevByRoot = new Map(get().repos.map((r) => [r.root, r]));
      const applyOne = (st: {
        repoRoot: string;
        entries: { path: string; status: string; code: string }[];
        modified: number;
        added: number;
        deleted: number;
        untracked: number;
        branch: string | null;
        ahead: number | null;
        behind: number | null;
      }) => {
        const prev = prevByRoot.get(st.repoRoot);
        const merged =
          prev?.status?.entries?.length && st.entries.length === 0
            ? {
                ...st,
                entries: prev.status.entries,
                untracked:
                  st.untracked > 0
                    ? st.untracked
                    : (prev.status.untracked ?? 0),
              }
            : st;
        set((s) => ({
          repos: mapCard(s.repos, st.repoRoot, {
            status: merged,
            statusState: "idle",
            statusError: null,
          }),
        }));
      };

      const unsub =
        typeof window.anchor.history.onStatusBulkOne === "function"
          ? window.anchor.history.onStatusBulkOne(applyOne)
          : null;

      try {
        const statuses = await Promise.race([
          window.anchor.history.statusBulk({
            repoRoots: repos.map((r) => r.root),
            badgeOnly: true,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Bulk status timed out. WSL may be busy — try Refresh.",
                  ),
                ),
              60_000,
            );
          }),
        ]);
        // Apply any that the stream missed (or if no progressive channel).
        for (const st of statuses) applyOne(st);
        // Anything still loading: clear dots, keep prior status.
        set((s) => ({
          repos: s.repos.map((r) =>
            r.statusState === "loading"
              ? { ...r, statusState: "idle" as const, statusError: null }
              : r,
          ),
        }));
        return;
      } catch (err) {
        set((s) => ({
          repos: s.repos.map((r) =>
            r.statusState === "loading"
              ? { ...r, statusState: "idle" as const }
              : r,
          ),
          toast: quiet
            ? s.toast
            : err instanceof Error
              ? err.message
              : "Failed to refresh statuses",
        }));
        return;
      } finally {
        unsub?.();
      }
    }

    // Full status / no bulk: low concurrency per-repo (shows/clears per card).
    const concurrency = 2;
    let i = 0;
    const roots = repos.map((r) => r.root);
    async function worker() {
      while (i < roots.length) {
        const idx = i++;
        const root = roots[idx];
        if (!root) break;
        await get().refreshStatus(root, { quiet, badgeOnly });
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, Math.max(roots.length, 1)) },
        () => worker(),
      ),
    );
  },

  refreshStatus: async (repoRoot, opts) => {
    const quiet = opts?.quiet === true;
    const badgeOnly = opts?.badgeOnly === true;
    const existing = findCard(get().repos, repoRoot);
    if (quiet && existing?.statusState === "loading") return;

    // Only show loading chrome when this card has never loaded status.
    if (!quiet && !existing?.status) {
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          statusState: "loading",
          statusError: null,
        }),
      }));
    }
    try {
      const status = await Promise.race([
        window.anchor.history.status(repoRoot, { badgeOnly }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  "Status timed out. Repo may be huge or WSL is busy — try Refresh.",
                ),
              ),
            badgeOnly ? 20_000 : 30_000,
          );
        }),
      ]);
      const merged =
        badgeOnly && existing?.status?.entries?.length
          ? {
              ...status,
              entries:
                status.entries.length > 0
                  ? status.entries
                  : existing.status.entries,
              untracked:
                status.untracked > 0
                  ? status.untracked
                  : (existing.status.untracked ?? 0),
            }
          : status;
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          status: merged,
          statusState: "idle",
          statusError: null,
        }),
      }));
    } catch (err) {
      // Keep last good status — never flip known branches to err/….
      if (existing?.status) {
        set((s) => ({
          repos: mapCard(s.repos, repoRoot, {
            statusState: "idle",
            statusError: quiet
              ? null
              : err instanceof Error
                ? err.message
                : String(err),
          }),
        }));
        return;
      }
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          statusState: "error",
          statusError: err instanceof Error ? err.message : String(err),
        }),
      }));
    }
  },

  softRefreshStatuses: async () => {
    const { repos, discoverStatus } = get();
    if (discoverStatus === "loading" || repos.length === 0) return;
    await get().refreshAllStatuses({ quiet: true, badgeOnly: true });
  },

  toggleExpanded: (repoRoot) => {
    const card = findCard(get().repos, repoRoot);
    if (!card) return;
    const next = !card.expanded;
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, { expanded: next }),
    }));
    // Opening a repo: full status (file list) for Changes.
    // Collapsed repos only get quiet badge polls from HistoryPane.
    if (next) {
      void get().refreshStatus(repoRoot, { badgeOnly: false });
    }
  },

  toggleChanges: (repoRoot) => {
    const card = findCard(get().repos, repoRoot);
    if (!card) return;
    const nextOpen = !card.changesOpen;
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, {
        changesOpen: nextOpen,
        expanded: nextOpen ? true : card.expanded,
      }),
    }));
    // Opening Changes (including first expand of a collapsed repo): full status.
    if (nextOpen) {
      void get().refreshStatus(repoRoot, { badgeOnly: false });
    }
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
      }),
    }));
    await get().refreshLog(repoRoot);
  },

  refreshLog: async (repoRoot) => {
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, {
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

  loadBranches: async (repoRoot) => {
    set((s) => ({
      repos: mapCard(s.repos, repoRoot, {
        branchesStatus: "loading",
        branchesError: null,
      }),
    }));
    try {
      const branches = await window.anchor.history.listBranches(repoRoot);
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          branches,
          branchesStatus: "idle",
          branchesError: null,
        }),
      }));
    } catch (err) {
      set((s) => ({
        repos: mapCard(s.repos, repoRoot, {
          branches: [],
          branchesStatus: "error",
          branchesError: err instanceof Error ? err.message : String(err),
        }),
      }));
    }
  },

  checkoutBranch: async (repoRoot, branch) => {
    const card = findCard(get().repos, repoRoot);
    if (!card || card.switchingBranch) return false;
    set((s) => ({
      toast: null,
      repos: mapCard(s.repos, repoRoot, { switchingBranch: true }),
    }));
    try {
      const result = await window.anchor.history.checkout({
        repoRoot,
        branch,
      });
      set((s) => ({
        toast: `Switched to ${result.branch}`,
        repos: mapCard(s.repos, repoRoot, {
          switchingBranch: false,
          // Invalidate log so next History open reloads for the new branch tip.
          commits: [],
          logStatus: "idle",
          logError: null,
          selectedHashes: [],
        }),
      }));
      await get().refreshStatus(repoRoot);
      await get().loadBranches(repoRoot);
      // If History section is open, reload commits for the new branch.
      const next = findCard(get().repos, repoRoot);
      if (next?.historyOpen) {
        set((s) => ({
          repos: mapCard(s.repos, repoRoot, {
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
      }
      return true;
    } catch (err) {
      set((s) => ({
        toast: err instanceof Error ? err.message : String(err),
        repos: mapCard(s.repos, repoRoot, { switchingBranch: false }),
      }));
      return false;
    }
  },

  commitChanges: async (repoRoot, message) => {
    const card = findCard(get().repos, repoRoot);
    if (!card || card.committing) return false;
    const msg = message.trim();
    if (!msg) {
      set({ toast: "Commit message is required" });
      return false;
    }
    set((s) => ({
      toast: null,
      repos: mapCard(s.repos, repoRoot, { committing: true }),
    }));
    try {
      const result = await window.anchor.history.commit({
        repoRoot,
        message: msg,
      });
      const short =
        result.shortHash ||
        (result.hash ? result.hash.slice(0, 7) : "");
      set((s) => {
        const prev = findCard(s.repos, repoRoot);
        return {
          toast: short
            ? `Committed ${short}: ${result.subject}`
            : `Committed: ${result.subject}`,
          repos: mapCard(s.repos, repoRoot, {
            committing: false,
            // Drop worktree from compare selection after a successful commit.
            selectedHashes: (prev?.selectedHashes ?? []).filter(
              (h) => h !== WORKTREE_SELECTION,
            ),
          }),
        };
      });
      await get().refreshStatus(repoRoot);
      const next = findCard(get().repos, repoRoot);
      if (next?.historyOpen) {
        try {
          const commits = await window.anchor.history.loadLog(repoRoot);
          set((s) => ({
            repos: mapCard(s.repos, repoRoot, {
              commits,
              logStatus: "idle",
              logError: null,
            }),
          }));
        } catch {
          // non-fatal; status already refreshed
        }
      }
      return true;
    } catch (err) {
      set((s) => ({
        toast: err instanceof Error ? err.message : String(err),
        repos: mapCard(s.repos, repoRoot, { committing: false }),
      }));
      return false;
    }
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
