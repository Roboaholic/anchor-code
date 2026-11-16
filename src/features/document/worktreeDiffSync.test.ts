// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { peekFileDiff, clearFileDiffCache } from "./fileDiffCache";
import {
  WORKTREE_DIFF_SYNC_DEBOUNCE_MS,
  WORKTREE_DIFF_SYNC_LOCAL_POLL_MS,
  WORKTREE_DIFF_SYNC_POLL_MS,
  startWorktreeDiffSync,
  watchTouchedRepos,
} from "./worktreeDiffSync";

type Listener = (event: {
  root?: string;
  hostProfileId?: string;
  dir: string;
  changes?: { path: string; rel: string; eventType: string; kind?: string }[];
}) => void;

const listeners: Listener[] = [];
const worktreeDiffState = vi.fn();
const refreshWorktree = vi.fn();
const getFileDiff = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openWorktree(files = [{ path: "a.ts", status: "M" }]) {
  useDocumentStore.getState().openDiff({
    repoRoot: "/repo",
    base: "HEAD",
    head: "worktree",
    title: "HEAD → worktree",
    files,
    activeFilePath: files[0]?.path,
  });
}

describe("watchTouchedRepos", () => {
  it("maps file changes onto the containing repo", () => {
    const hits = watchTouchedRepos(
      {
        dir: "/repo",
        changes: [
          { path: "/repo/a.ts", rel: "a.ts", eventType: "change" },
          { path: "/other/z.ts", rel: "z.ts", eventType: "change" },
        ],
      },
      ["/repo", "/other"],
    );
    expect([...hits.get("/repo")!]).toEqual(["a.ts"]);
    expect([...hits.get("/other")!]).toEqual(["z.ts"]);
  });
});

describe("startWorktreeDiffSync", () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    listeners.length = 0;
    worktreeDiffState.mockReset();
    refreshWorktree.mockReset();
    getFileDiff.mockReset();
    clearFileDiffCache();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.assign(window, {
      anchor: {
        workspace: {
          onFileChange: (cb: Listener) => {
            listeners.push(cb);
            return () => {
              const i = listeners.indexOf(cb);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
        },
        history: { worktreeDiffState, getFileDiff },
        snapshot: { refreshWorktree },
      },
    });
    useDocumentStore.setState(useDocumentStore.getInitialState(), true);
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getInitialState(),
      workspaceRoot: "/ws",
      hostKind: "local",
      hostProfileId: "local-default",
    });
    stop = startWorktreeDiffSync();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("reloads same-file worktree content after a watch event", async () => {
    openWorktree();
    worktreeDiffState.mockResolvedValue({
      files: [{ path: "a.ts", status: "M" }],
      fingerprints: [{ path: "a.ts", mtimeMs: 2_000, size: 12 }],
    });
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [{ path: "/repo/a.ts", rel: "a.ts", eventType: "change" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (item?.kind !== "diff") throw new Error("missing");
    expect(item.worktreeContentEpoch).toBe(1);
    expect(worktreeDiffState).toHaveBeenCalledTimes(1);
  });

  it("adds a new file and drops a deleted file from an open compare", async () => {
    openWorktree([
      { path: "a.ts", status: "M" },
      { path: "gone.ts", status: "A" },
    ]);
    worktreeDiffState.mockResolvedValue({
      files: [
        { path: "a.ts", status: "M" },
        { path: "new.ts", status: "A" },
      ],
      fingerprints: [
        { path: "a.ts", mtimeMs: 1, size: 1 },
        { path: "new.ts", mtimeMs: 1, size: 1 },
      ],
    });
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [
        { path: "/repo/new.ts", rel: "new.ts", eventType: "rename" },
        { path: "/repo/gone.ts", rel: "gone.ts", eventType: "rename" },
      ],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (item?.kind !== "diff") throw new Error("missing");
    expect(item.files.map((file) => file.path)).toEqual(["a.ts", "new.ts"]);
    expect(item.activeFilePath).toBe("a.ts");
  });

  it("does not refresh a fixed commit comparison", async () => {
    useDocumentStore.getState().openDiff({
      repoRoot: "/repo",
      base: "aaa",
      head: "bbb",
      title: "aaa → bbb",
      files: [{ path: "a.ts", status: "M" }],
    });
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [{ path: "/repo/a.ts", rel: "a.ts", eventType: "change" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    expect(worktreeDiffState).not.toHaveBeenCalled();
  });

  it("drops a stale in-flight refresh after a newer one finishes", async () => {
    openWorktree();
    const first = deferred<{
      files: { path: string; status: string }[];
      fingerprints: { path: string; mtimeMs: number | null; size: number | null }[];
    }>();
    worktreeDiffState.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
      fingerprints: [
        { path: "a.ts", mtimeMs: 2, size: 2 },
        { path: "b.ts", mtimeMs: 2, size: 2 },
      ],
    });
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [{ path: "/repo/a.ts", rel: "a.ts", eventType: "change" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [{ path: "/repo/b.ts", rel: "b.ts", eventType: "rename" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    expect(worktreeDiffState).toHaveBeenCalledTimes(1);
    first.resolve({
      files: [{ path: "stale.ts", status: "A" }],
      fingerprints: [{ path: "stale.ts", mtimeMs: 9, size: 9 }],
    });
    await first.promise;
    await vi.waitFor(() => expect(worktreeDiffState).toHaveBeenCalledTimes(2));
    const after = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (after?.kind !== "diff") throw new Error("missing");
    expect(after.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores a late result after the sync is disposed", async () => {
    openWorktree();
    const pending = deferred<{
      files: { path: string; status: string }[];
      fingerprints: { path: string; mtimeMs: number | null; size: number | null }[];
    }>();
    worktreeDiffState.mockReturnValueOnce(pending.promise);
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/repo",
      changes: [{ path: "/repo/a.ts", rel: "a.ts", eventType: "change" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    stop();
    pending.resolve({
      files: [{ path: "late.ts", status: "A" }],
      fingerprints: [{ path: "late.ts", mtimeMs: 1, size: 1 }],
    });
    await pending.promise;
    await Promise.resolve();
    const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (item?.kind !== "diff") throw new Error("missing");
    expect(item.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("polls remote hosts more often than local", async () => {
    stop();
    useWorkspaceStore.setState({ hostKind: "ssh" });
    stop = startWorktreeDiffSync();
    openWorktree();
    worktreeDiffState.mockResolvedValue({
      files: [{ path: "a.ts", status: "M" }],
      fingerprints: [{ path: "a.ts", mtimeMs: 1, size: 1 }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_POLL_MS + WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    expect(worktreeDiffState).toHaveBeenCalled();
    worktreeDiffState.mockClear();

    stop();
    useWorkspaceStore.setState({ hostKind: "local" });
    stop = startWorktreeDiffSync();
    openWorktree();
    worktreeDiffState.mockResolvedValue({
      files: [{ path: "a.ts", status: "M" }],
      fingerprints: [{ path: "a.ts", mtimeMs: 1, size: 1 }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_POLL_MS + WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    expect(worktreeDiffState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(
      WORKTREE_DIFF_SYNC_LOCAL_POLL_MS - WORKTREE_DIFF_SYNC_POLL_MS,
    );
    expect(worktreeDiffState).toHaveBeenCalled();
  });

  it("does not invalidate cached text when nothing changed", async () => {
    openWorktree();
    const cached = { path: "a.ts", oldText: "old", newText: "new", status: "M" };
    (window.anchor.history.getFileDiff as ReturnType<typeof vi.fn>).mockResolvedValue(cached);
    await (await import("./fileDiffCache")).loadFileDiff({
      repoRoot: "/repo",
      base: "HEAD",
      head: "worktree",
      path: "a.ts",
      status: "M",
    });
    worktreeDiffState.mockResolvedValue({
      files: [{ path: "a.ts", status: "M" }],
      fingerprints: [{ path: "a.ts", mtimeMs: 1, size: 1 }],
    });
    // First observation only records fingerprints.
    listeners[0]!({
      root: "/ws",
      hostProfileId: "local-default",
      dir: "/other",
      changes: [{ path: "/other/x.ts", rel: "x.ts", eventType: "change" }],
    });
    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_DEBOUNCE_MS);
    expect(worktreeDiffState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKTREE_DIFF_SYNC_LOCAL_POLL_MS);
    expect(worktreeDiffState).toHaveBeenCalledTimes(1);
    expect(
      peekFileDiff({
        repoRoot: "/repo",
        base: "HEAD",
        head: "worktree",
        path: "a.ts",
        status: "M",
      }),
    ).toEqual(cached);
    const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (item?.kind !== "diff") throw new Error("missing");
    expect(item.worktreeContentEpoch ?? 0).toBe(0);
  });
});
