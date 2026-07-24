import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_SELECTION } from "@/core/history/selection";
import {
  recentForRepo,
  selectionLabelForCard,
  useHistoryStore,
  type RepoCardState,
} from "./historyStore";

function mockAnchor(opts?: {
  discover?: Array<{ root: string; name: string }>;
  log?: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    dateIso: string;
  }>;
  status?: {
    repoRoot: string;
    entries: Array<{ path: string; status: string; code: string }>;
    modified: number;
    added: number;
    deleted: number;
    untracked: number;
    ahead: number | null;
    behind: number | null;
  };
  compare?: {
    repoRoot: string;
    base: string;
    head: string | "worktree";
    title: string;
    files: Array<{ path: string; status: string }>;
    branch?: string | null;
  };
}) {
  const discover = opts?.discover ?? [
    { root: "/ws/repo-a", name: "repo-a" },
    { root: "/ws/repo-b", name: "repo-b" },
  ];
  const log = opts?.log ?? [
    {
      hash: "aaa111",
      shortHash: "aaa111",
      subject: "first",
      author: "t",
      dateIso: "2026-01-01T00:00:00Z",
    },
    {
      hash: "bbb222",
      shortHash: "bbb222",
      subject: "second",
      author: "t",
      dateIso: "2026-01-02T00:00:00Z",
    },
  ];
  const status = opts?.status ?? {
    repoRoot: "/ws/repo-a",
    entries: [{ path: "x.ts", status: "M", code: " M" }],
    modified: 1,
    added: 0,
    deleted: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
  };
  const compare = opts?.compare ?? {
    repoRoot: "/ws/repo-a",
    base: "aaa111",
    head: "worktree" as const,
    title: "aaa111 → worktree",
    files: [{ path: "x.ts", status: "M" }],
    branch: "main",
  };

  const recent: unknown[] = [];

  (globalThis as { window?: unknown }).window = {
    anchor: {
      history: {
        discover: vi.fn(async () => discover),
        loadLog: vi.fn(async () => log),
        status: vi.fn(async (root: string) => ({ ...status, repoRoot: root })),
        compare: vi.fn(async () => compare),
        getRecentCompares: vi.fn(async () => recent),
        pushRecentCompare: vi.fn(async ({ entry }: { entry: unknown }) => {
          recent.unshift(entry);
          return [...recent];
        }),
        removeRecentCompare: vi.fn(async ({ id }: { id: string }) => {
          const next = recent.filter(
            (e) => (e as { id: string }).id !== id,
          );
          recent.length = 0;
          recent.push(...next);
          return [...recent];
        }),
      },
    },
  };

  return { discover, log, status, compare, recent };
}

describe("historyStore multi-repo", () => {
  beforeEach(() => {
    useHistoryStore.getState().reset();
    mockAnchor();
  });

  it("discovers repos without auto-loading commit logs", async () => {
    await useHistoryStore.getState().discover("/ws");
    const s = useHistoryStore.getState();
    expect(s.discoverStatus).toBe("idle");
    expect(s.repos.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    // Lazy: history closed, no commits until toggleHistory
    expect(s.repos.every((r) => r.historyOpen === false)).toBe(true);
    expect(s.repos.every((r) => r.commits.length === 0)).toBe(true);
    expect(s.repos.every((r) => r.changesOpen === true)).toBe(true);
    expect(s.repos.every((r) => r.comparesOpen === false)).toBe(true);
  });

  it("loads log only when history is expanded", async () => {
    await useHistoryStore.getState().discover("/ws");
    await useHistoryStore.getState().toggleHistory("/ws/repo-a");
    const card = useHistoryStore
      .getState()
      .repos.find((r) => r.root === "/ws/repo-a");
    expect(card?.historyOpen).toBe(true);
    expect(card?.commits.map((c) => c.hash)).toEqual(["aaa111", "bbb222"]);
  });

  it("runCompare with worktree selection returns payload and persists recent", async () => {
    await useHistoryStore.getState().discover("/ws");
    useHistoryStore.getState().toggleCommit("/ws/repo-a", WORKTREE_SELECTION);
    const payload = await useHistoryStore
      .getState()
      .runCompare("/ws/repo-a");
    expect(payload).not.toBeNull();
    expect(payload!.head).toBe("worktree");
    expect(payload!.title).toContain("repo-a");
    expect(useHistoryStore.getState().recentCompares.length).toBe(1);
    expect(
      recentForRepo(useHistoryStore.getState().recentCompares, "/ws/repo-a")
        .length,
    ).toBe(1);
  });

  it("toggleCommit caps at two selections", async () => {
    await useHistoryStore.getState().discover("/ws");
    await useHistoryStore.getState().toggleHistory("/ws/repo-a");
    const store = useHistoryStore.getState();
    store.toggleCommit("/ws/repo-a", "aaa111");
    store.toggleCommit("/ws/repo-a", "bbb222");
    store.toggleCommit("/ws/repo-a", "ccc333");
    const card = useHistoryStore
      .getState()
      .repos.find((r) => r.root === "/ws/repo-a");
    expect(card?.selectedHashes).toEqual(["aaa111", "bbb222"]);
    expect(useHistoryStore.getState().toast).toMatch(/two/i);
  });
});

describe("selectionLabelForCard", () => {
  it("labels worktree selection", () => {
    const card = {
      commits: [],
      selectedHashes: [WORKTREE_SELECTION],
    } as unknown as RepoCardState;
    expect(selectionLabelForCard(card)).toBe("HEAD → worktree");
  });
});
