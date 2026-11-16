import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotDiffPayload, SnapshotDiffRepo } from "@/shared/anchor-api";
import { useDocumentStore, type OpenItem } from "./documentStore";
import {
  applySnapshotWorktreeItems,
  applyWorktreeDiffItems,
  collectOpenWorktreeTargets,
  nextActiveDiffPath,
  pathInsideRoot,
} from "./worktreeDiffUpdate";

function worktreeDiff(
  files: { path: string; status: string }[],
  extra: Partial<Extract<OpenItem, { kind: "diff" }>> = {},
): Extract<OpenItem, { kind: "diff" }> {
  return {
    id: extra.id ?? `diff:/repo:HEAD:worktree${extra.hideFileList && files[0] ? `:${files[0].path}` : ""}`,
    kind: "diff",
    title: extra.title ?? "HEAD → worktree",
    repoRoot: extra.repoRoot ?? "/repo",
    base: extra.base ?? "HEAD",
    head: "worktree",
    files,
    activeFilePath: extra.activeFilePath ?? files[0]?.path ?? null,
    hideFileList: extra.hideFileList,
    worktreeContentEpoch: extra.worktreeContentEpoch,
  };
}

function commitDiff(): Extract<OpenItem, { kind: "diff" }> {
  return {
    id: "diff:/repo:aaa:bbb",
    kind: "diff",
    title: "aaa → bbb",
    repoRoot: "/repo",
    base: "aaa",
    head: "bbb",
    files: [{ path: "a.ts", status: "M" }],
    activeFilePath: "a.ts",
  };
}

function snapshotPayload(repos: SnapshotDiffRepo[], targetId: SnapshotDiffPayload["targetId"] = "worktree"): SnapshotDiffPayload {
  return {
    workspaceRoot: "/ws",
    baseId: "snap-1",
    targetId,
    title: "snap → 当前",
    repos,
  };
}

function snapshotRepo(partial: Partial<SnapshotDiffRepo> = {}): SnapshotDiffRepo {
  return {
    root: "/repo",
    name: "repo",
    state: "changed",
    base: "treebase",
    head: "worktree",
    files: [{ path: "a.ts", status: "M" }],
    largeFiles: [],
    ...partial,
  };
}

describe("nextActiveDiffPath", () => {
  const previous = [
    { path: "a.ts", status: "M" },
    { path: "b.ts", status: "M" },
    { path: "c.ts", status: "A" },
  ];

  it("keeps the current file when it still exists", () => {
    expect(nextActiveDiffPath(previous, "b.ts", previous)).toBe("b.ts");
  });

  it("selects the next surviving neighbor when the current file is gone", () => {
    const files = [
      { path: "a.ts", status: "M" },
      { path: "c.ts", status: "A" },
    ];
    expect(nextActiveDiffPath(files, "b.ts", previous)).toBe("c.ts");
  });

  it("falls back to the previous neighbor, then first file, then null", () => {
    expect(nextActiveDiffPath([{ path: "a.ts", status: "M" }], "b.ts", previous)).toBe("a.ts");
    expect(nextActiveDiffPath([], "b.ts", previous)).toBeNull();
  });
});

describe("applyWorktreeDiffItems", () => {
  it("updates content for the same file without rewriting an unchanged list", () => {
    const items: OpenItem[] = [worktreeDiff([{ path: "a.ts", status: "M" }], { worktreeContentEpoch: 0 })];
    const next = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [{ path: "a.ts", status: "M" }],
      changedPaths: ["a.ts"],
    });
    expect(next).not.toBeNull();
    const item = next![0] as Extract<OpenItem, { kind: "diff" }>;
    expect(item.files).toBe((items[0] as Extract<OpenItem, { kind: "diff" }>).files);
    expect(item.activeFilePath).toBe("a.ts");
    expect(item.worktreeContentEpoch).toBe(1);
  });

  it("adds and removes files on a full compare tab and keeps the current file", () => {
    const items: OpenItem[] = [
      worktreeDiff(
        [
          { path: "a.ts", status: "M" },
          { path: "old.ts", status: "A" },
        ],
        { activeFilePath: "a.ts" },
      ),
    ];
    const files = [
      { path: "a.ts", status: "M" },
      { path: "new.ts", status: "A" },
    ];
    const next = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files,
      changedPaths: ["new.ts", "old.ts"],
    });
    const item = next![0] as Extract<OpenItem, { kind: "diff" }>;
    expect(item.files).toEqual(files);
    expect(item.activeFilePath).toBe("a.ts");
    expect(item.worktreeContentEpoch ?? 0).toBe(0);
  });

  it("moves selection when the current file is deleted and the tree becomes empty", () => {
    const items: OpenItem[] = [
      worktreeDiff(
        [
          { path: "a.ts", status: "M" },
          { path: "b.ts", status: "M" },
        ],
        { activeFilePath: "a.ts" },
      ),
    ];
    const afterDelete = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [{ path: "b.ts", status: "M" }],
      changedPaths: ["a.ts"],
    });
    expect((afterDelete![0] as Extract<OpenItem, { kind: "diff" }>).activeFilePath).toBe("b.ts");

    const empty = applyWorktreeDiffItems(afterDelete!, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [],
      changedPaths: ["b.ts"],
    });
    const item = empty![0] as Extract<OpenItem, { kind: "diff" }>;
    expect(item.files).toEqual([]);
    expect(item.activeFilePath).toBeNull();
  });

  it("keeps a Changes single-file tab focused and does not absorb other files", () => {
    const items: OpenItem[] = [
      worktreeDiff([{ path: "a.ts", status: "M" }], { hideFileList: true, activeFilePath: "a.ts" }),
    ];
    const next = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
      changedPaths: ["b.ts"],
    });
    expect(next).toBeNull();

    const gone = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [{ path: "b.ts", status: "A" }],
      changedPaths: ["a.ts"],
    });
    const item = gone![0] as Extract<OpenItem, { kind: "diff" }>;
    expect(item.files).toEqual([]);
    expect(item.activeFilePath).toBeNull();
    expect(item.hideFileList).toBe(true);
  });

  it("updates multiple worktree tabs and leaves commit comparisons alone", () => {
    const items: OpenItem[] = [
      worktreeDiff([{ path: "a.ts", status: "M" }], { id: "full" }),
      worktreeDiff([{ path: "a.ts", status: "M" }], {
        id: "focus",
        hideFileList: true,
        activeFilePath: "a.ts",
      }),
      commitDiff(),
    ];
    const next = applyWorktreeDiffItems(items, {
      repoRoot: "/repo",
      base: "HEAD",
      files: [{ path: "a.ts", status: "M" }],
      changedPaths: ["a.ts"],
    });
    expect(next).toHaveLength(3);
    expect((next![0] as Extract<OpenItem, { kind: "diff" }>).worktreeContentEpoch).toBe(1);
    expect((next![1] as Extract<OpenItem, { kind: "diff" }>).worktreeContentEpoch).toBe(1);
    expect(next![2]).toBe(items[2]);
  });

  it("is a no-op when the list and fingerprints are unchanged", () => {
    const items: OpenItem[] = [worktreeDiff([{ path: "a.ts", status: "M" }])];
    expect(
      applyWorktreeDiffItems(items, {
        repoRoot: "/repo",
        base: "HEAD",
        files: [{ path: "a.ts", status: "M" }],
        changedPaths: [],
      }),
    ).toBeNull();
  });
});

describe("applySnapshotWorktreeItems", () => {
  it("updates snapshot → current and leaves snapshot → snapshot alone", () => {
    const worktreeItem: OpenItem = {
      id: "snapshot-diff:/ws:snap-1:worktree",
      kind: "snapshot-diff",
      title: "snap → 当前",
      payload: snapshotPayload([snapshotRepo()]),
      active: { repoRoot: "/repo", path: "a.ts" },
      worktreeContentEpoch: 0,
    };
    const frozen: OpenItem = {
      id: "snapshot-diff:/ws:snap-1:snap-2",
      kind: "snapshot-diff",
      title: "snap-1 → snap-2",
      payload: snapshotPayload([snapshotRepo({ head: "commit2" })], "snap-2"),
      active: { repoRoot: "/repo", path: "a.ts" },
    };
    const next = applySnapshotWorktreeItems([worktreeItem, frozen], {
      workspaceRoot: "/ws",
      baseId: "snap-1",
      repos: [
        snapshotRepo({
          files: [
            { path: "a.ts", status: "M" },
            { path: "b.ts", status: "A" },
          ],
        }),
      ],
      changedPaths: [{ repoRoot: "/repo", path: "b.ts" }],
    });
    expect(next).toHaveLength(2);
    const updated = next![0] as Extract<OpenItem, { kind: "snapshot-diff" }>;
    expect(updated.payload.repos[0]!.files).toEqual([
      { path: "a.ts", status: "M" },
      { path: "b.ts", status: "A" },
    ]);
    expect(updated.active).toEqual({ repoRoot: "/repo", path: "a.ts" });
    expect(next![1]).toBe(frozen);
  });

  it("bumps the epoch when the active snapshot file changes", () => {
    const item: OpenItem = {
      id: "s",
      kind: "snapshot-diff",
      title: "snap → 当前",
      payload: snapshotPayload([snapshotRepo()]),
      active: { repoRoot: "/repo", path: "a.ts" },
      worktreeContentEpoch: 2,
    };
    const next = applySnapshotWorktreeItems([item], {
      workspaceRoot: "/ws",
      baseId: "snap-1",
      repos: [snapshotRepo()],
      changedPaths: [{ repoRoot: "/repo", path: "a.ts" }],
    });
    expect((next![0] as Extract<OpenItem, { kind: "snapshot-diff" }>).worktreeContentEpoch).toBe(3);
  });
});

describe("collectOpenWorktreeTargets", () => {
  it("dedupes worktree diffs and ignores fixed comparisons", () => {
    const targets = collectOpenWorktreeTargets([
      worktreeDiff([{ path: "a.ts", status: "M" }]),
      worktreeDiff([{ path: "a.ts", status: "M" }], { id: "focus", hideFileList: true }),
      commitDiff(),
      {
        id: "s",
        kind: "snapshot-diff",
        title: "snap → 当前",
        payload: snapshotPayload([snapshotRepo(), snapshotRepo({ root: "/other", name: "other" })]),
        active: { repoRoot: "/repo", path: "a.ts" },
      },
      {
        id: "frozen",
        kind: "snapshot-diff",
        title: "s1 → s2",
        payload: snapshotPayload([snapshotRepo({ head: "c" })], "s2"),
        active: { repoRoot: "/repo", path: "a.ts" },
      },
    ]);
    expect(targets).toEqual([
      { kind: "diff", repoRoot: "/repo", base: "HEAD" },
      {
        kind: "snapshot",
        workspaceRoot: "/ws",
        baseId: "snap-1",
        repoRoots: ["/repo", "/other"],
      },
    ]);
  });
});

describe("pathInsideRoot", () => {
  it("matches files under a repo and ignores siblings", () => {
    expect(pathInsideRoot("/repo/a.ts", "/repo")).toBe(true);
    expect(pathInsideRoot("/repo-other/a.ts", "/repo")).toBe(false);
  });
});

describe("documentStore worktree apply methods", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
  });

  it("applies a live worktree update in the store", () => {
    useDocumentStore.getState().openDiff({
      repoRoot: "/repo",
      base: "HEAD",
      head: "worktree",
      title: "HEAD → worktree",
      files: [{ path: "a.ts", status: "M" }],
    });
    useDocumentStore.getState().applyWorktreeDiffUpdate({
      repoRoot: "/repo",
      base: "HEAD",
      files: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
      changedPaths: ["b.ts"],
    });
    const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "diff");
    if (item?.kind !== "diff") throw new Error("missing");
    expect(item.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(item.activeFilePath).toBe("a.ts");
  });
});
