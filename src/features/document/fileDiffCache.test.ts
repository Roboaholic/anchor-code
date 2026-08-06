import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFileDiffCache,
  invalidateWorktreeDiffCache,
  loadFileDiff,
  prefetchFileDiff,
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

  it("promotes a clicked file ahead of queued background work", async () => {
    const first = deferred<{ path: string; oldText: string; newText: string; status: string }>();
    const clicked = deferred<{ path: string; oldText: string; newText: string; status: string }>();
    const getFileDiff = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(clicked.promise);
    (globalThis as { window?: unknown }).window = {
      anchor: { history: { getFileDiff } },
    };
    const secondRequest = { ...worktreeRequest, path: "src/b.ts" };

    prefetchFileDiff(worktreeRequest);
    prefetchFileDiff(secondRequest);
    expect(getFileDiff).toHaveBeenCalledTimes(1);

    const selected = loadFileDiff(secondRequest);
    expect(getFileDiff).toHaveBeenCalledTimes(2);
    expect(getFileDiff.mock.calls[1]?.[0]).toMatchObject({ path: "src/b.ts" });

    clicked.resolve({ path: "src/b.ts", oldText: "old", newText: "clicked", status: "M" });
    await expect(selected).resolves.toMatchObject({ newText: "clicked" });
    first.resolve({ path: "src/a.ts", oldText: "old", newText: "warm", status: "M" });
  });
});
