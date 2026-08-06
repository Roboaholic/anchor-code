import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFileDiffCache,
  invalidateWorktreeDiffCache,
  loadFileDiff,
} from "./fileDiffCache";

const worktreeRequest = {
  repoRoot: "/repo",
  base: "abc123",
  head: "worktree" as const,
  path: "src/a.ts",
  status: "M",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fileDiffCache", () => {
  beforeEach(() => {
    clearFileDiffCache();
  });

  it("reloads worktree content after invalidation", async () => {
    const getFileDiff = vi
      .fn()
      .mockResolvedValueOnce({
        path: "src/a.ts",
        oldText: "old",
        newText: "stale worktree",
        status: "M",
      })
      .mockResolvedValueOnce({
        path: "src/a.ts",
        oldText: "old",
        newText: "current worktree",
        status: "M",
      });
    (globalThis as { window?: unknown }).window = {
      anchor: { history: { getFileDiff } },
    };

    expect((await loadFileDiff(worktreeRequest)).newText).toBe("stale worktree");
    invalidateWorktreeDiffCache("/repo", "abc123");
    expect((await loadFileDiff(worktreeRequest)).newText).toBe("current worktree");
    expect(getFileDiff).toHaveBeenCalledTimes(2);
  });

  it("does not let an invalidated in-flight response overwrite fresh content", async () => {
    const stale = deferred<{
      path: string;
      oldText: string;
      newText: string;
      status: string;
    }>();
    const getFileDiff = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        path: "src/a.ts",
        oldText: "old",
        newText: "current worktree",
        status: "M",
      });
    (globalThis as { window?: unknown }).window = {
      anchor: { history: { getFileDiff } },
    };

    const staleRequest = loadFileDiff(worktreeRequest);
    invalidateWorktreeDiffCache("/repo", "abc123");
    const fresh = await loadFileDiff(worktreeRequest);
    stale.resolve({
      path: "src/a.ts",
      oldText: "old",
      newText: "stale worktree",
      status: "M",
    });
    await staleRequest;

    expect(fresh.newText).toBe("current worktree");
    expect((await loadFileDiff(worktreeRequest)).newText).toBe("current worktree");
    expect(getFileDiff).toHaveBeenCalledTimes(2);
  });

  it("keeps immutable commit comparisons cached", async () => {
    const getFileDiff = vi.fn().mockResolvedValue({
      path: "src/a.ts",
      oldText: "old",
      newText: "committed",
      status: "M",
    });
    (globalThis as { window?: unknown }).window = {
      anchor: { history: { getFileDiff } },
    };
    const commitRequest = { ...worktreeRequest, head: "def456" };

    await loadFileDiff(commitRequest);
    invalidateWorktreeDiffCache("/repo", "abc123");
    await loadFileDiff(commitRequest);

    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });
});
