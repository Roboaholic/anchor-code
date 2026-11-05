// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotDiffPayload, SnapshotMeta } from "@/shared/anchor-api";
import { SnapshotsSection } from "./SnapshotsSection";
import { SnapshotDiffView } from "./SnapshotDiffView";
import { applySnapshotProgress, useSnapshotStore } from "./snapshotStore";
import { agentTurnEvents } from "./autoSnapshots";
import { useDocumentStore } from "@/features/document/documentStore";

vi.mock("@/features/document/DiffViewer", () => ({
  DiffViewer: ({ item }: { item: { repoRoot: string; activeFilePath: string; focusRangeLabel?: string } }) => (
    <div data-testid="diff-viewer" data-range={item.focusRangeLabel}>{`${item.repoRoot}:${item.activeFilePath}`}</div>
  ),
}));

const meta = (p: Partial<SnapshotMeta> & { id: string }): SnapshotMeta => ({
  v: 1,
  workspaceRoot: "/ws",
  name: p.id,
  source: "manual",
  createdAt: "2026-11-04T08:00:00.000Z",
  repos: [
    { root: "/ws/a", name: "a", head: "h", branch: "main", commit: "c", tree: "t", storage: "repo", largeFiles: [], status: "ok" },
  ],
  ...p,
});

const payload: SnapshotDiffPayload = {
  workspaceRoot: "/ws",
  baseId: "s1",
  targetId: "worktree",
  title: "16:40 → 当前",
  repos: [
    {
      root: "/ws/a",
      name: "a",
      state: "changed",
      base: "c1",
      head: "worktree",
      files: [{ path: "src/x.ts", status: "M" }],
      largeFiles: [{ path: "data/model.bin", size: 12 * 1024 * 1024, status: "A" }],
    },
    { root: "/ws/b", name: "b", state: "unchanged", base: "c2", head: "worktree", files: [], largeFiles: [] },
    { root: "/ws/c", name: "c", state: "added", base: "4b82", head: "worktree", files: [{ path: "z.txt", status: "A" }], largeFiles: [] },
  ],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  api = {
    list: vi.fn(async () => [
      meta({ id: "s2", name: "改完接口", source: "agent", agentLabel: "Codex", createdAt: "2026-11-04T08:52:00.000Z" }),
      meta({ id: "s1", name: "基线", createdAt: "2026-11-04T08:40:00.000Z" }),
    ]),
    create: vi.fn(async (args: { name?: string }) => meta({ id: "s3", name: args.name ?? "17:00", createdAt: "2026-11-04T09:00:00.000Z" })),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    compare: vi.fn(async () => payload),
    getAuto: vi.fn(async () => true),
    setAuto: vi.fn(async (v: boolean) => v),
  };
  (window as unknown as { anchor: unknown }).anchor = { snapshot: api };
  useSnapshotStore.setState({ snapshots: [], loaded: false, selected: [], filter: "all", turns: {}, autoEnabled: true, error: null, progress: {} });
  useDocumentStore.setState({ openItems: [], activeId: null });
});
afterEach(() => cleanup());

describe("SnapshotsSection", () => {
  it("shows per-repo progress for a manual 打点 and a quiet counter for auto snapshots", async () => {
    vi.useFakeTimers();
    try {
      render(<SnapshotsSection workspaceRoot="/ws" />);
      await act(async () => undefined);
      const repos = ["device", "ffmpeg", "hal"].map((name) => ({ name, state: "pending" as const }));
      act(() => applySnapshotProgress({ id: "m1", source: "manual", total: 3, done: 0, failed: 0, largeFiles: 0, repos }));
      expect(screen.getByTestId("snapshot-progress").textContent).toContain("0/3");
      act(() =>
        applySnapshotProgress({
          id: "m1", source: "manual", total: 3, done: 2, failed: 1, largeFiles: 0,
          repos: [{ name: "device", state: "ok" }, { name: "ffmpeg", state: "pending" }, { name: "hal", state: "error" }],
        }),
      );
      const bar = screen.getByTestId("snapshot-progress");
      expect(bar.textContent).toContain("2/3");
      expect(bar.textContent).toContain("失败 1");
      expect(bar.getAttribute("title")).toContain("✓ device");
      expect(bar.getAttribute("title")).toContain("… ffmpeg");
      expect(bar.getAttribute("title")).toContain("✗ hal");
      // Auto snapshots never add a bar, only a small counter in the header.
      act(() => applySnapshotProgress({ id: "a1", source: "auto", agentTabId: "t", total: 3, done: 1, failed: 0, largeFiles: 0, repos }));
      expect(screen.getAllByTestId("snapshot-progress")).toHaveLength(1);
      expect(screen.getByTestId("snapshot-auto-progress").textContent).toContain("1/3");
      act(() => applySnapshotProgress({ id: "m1", source: "manual", total: 3, done: 3, failed: 1, largeFiles: 0, repos }));
      act(() => void vi.advanceTimersByTime(1000));
      expect(screen.queryByTestId("snapshot-progress")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists newest first with source badges and creates a snapshot", async () => {
    render(<SnapshotsSection workspaceRoot="/ws" />);
    await act(async () => undefined);
    const rows = screen.getAllByTestId("snapshot-row");
    expect(rows[0]!.textContent).toContain("改完接口");
    expect(rows[0]!.textContent).toContain("Codex");
    expect(rows[1]!.textContent).toContain("你");
    const owners = screen.getAllByTestId("snapshot-owner");
    expect(owners.map((o) => o.textContent)).toEqual(["Codex", "你"]);
    expect(owners.every((o) => o.className.includes("snapshot-owner-tag"))).toBe(true);
    expect(owners[0]!.getAttribute("title")).toContain("Codex");
    expect(owners[0]!.className).toContain("repo-row__badge--ok");
    expect(owners[1]!.className).toContain("repo-row__badge--accent");
    // list rows carry no change/status hints
    expect(rows.some((r) => /无改动|大文件|失败/.test(r.textContent ?? ""))).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-create"));
    });
    expect(api.create).toHaveBeenCalledWith({ source: "manual" });
    expect(screen.getAllByTestId("snapshot-row")).toHaveLength(3);
  });

  it("click compares to worktree; two selections compare between them (old → new)", async () => {
    render(<SnapshotsSection workspaceRoot="/ws" />);
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByText("基线"));
    });
    expect(api.compare).toHaveBeenCalledWith({ baseId: "s1", targetId: "worktree" });
    expect(useDocumentStore.getState().openItems[0]?.kind).toBe("snapshot-diff");

    for (const cb of screen.getAllByRole("checkbox")) fireEvent.click(cb);
    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-compare"));
    });
    expect(api.compare).toHaveBeenLastCalledWith({ baseId: "s1", targetId: "s2" });
  });

  it("filters by source, renames and deletes", async () => {
    render(<SnapshotsSection workspaceRoot="/ws" />);
    await act(async () => undefined);
    act(() => useSnapshotStore.getState().setFilter("agent"));
    expect(screen.getAllByTestId("snapshot-row")).toHaveLength(1);
    act(() => useSnapshotStore.getState().setFilter("all"));
    fireEvent.click(screen.getAllByLabelText("重命名")[1]!);
    const input = screen.getByLabelText("快照名称");
    fireEvent.change(input, { target: { value: "重构前" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(api.rename).toHaveBeenCalledWith({ id: "s1", name: "重构前" });
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText("删除快照")[0]!);
    });
    expect(api.remove).toHaveBeenCalledWith({ ids: ["s2"] });
    expect(screen.getAllByTestId("snapshot-row")).toHaveLength(1);
  });
});

describe("SnapshotDiffView", () => {
  it("groups by repo, collapses unchanged, marks added repos and shows large files without content", async () => {
    useDocumentStore.getState().openSnapshotDiff(payload);
    const item = useDocumentStore.getState().openItems[0]!;
    if (item.kind !== "snapshot-diff") throw new Error("kind");
    const { rerender } = render(<SnapshotDiffView item={item} />);
    expect(await screen.findByTestId("diff-viewer")).toHaveProperty("textContent", "/ws/a:src/x.ts");
    expect(screen.getByTestId("diff-viewer").getAttribute("data-range")).toBe("16:40 → 当前");
    expect(screen.getByText("无变化")).toBeTruthy();
    expect(screen.getByText("快照后新增仓")).toBeTruthy();
    expect(screen.getByText("大文件，未记录内容")).toBeTruthy();

    fireEvent.click(screen.getByText("data/model.bin"));
    const next = useDocumentStore.getState().openItems[0]!;
    if (next.kind !== "snapshot-diff") throw new Error("kind");
    rerender(<SnapshotDiffView item={next} />);
    const info = screen.getByTestId("snapshot-large-info");
    expect(info.textContent).toContain("12.0 MB");
    expect(info.textContent).toContain("新增");
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });
});

describe("snapshot list loading", () => {
  it("dedupes concurrent loads and drops a stale workspace's result after reset", async () => {
    const st = useSnapshotStore.getState();
    st.reset();
    let release!: (v: unknown) => void;
    api.list!.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const p1 = st.load();
    const p2 = st.load();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(useSnapshotStore.getState().loading).toBe(true);
    useSnapshotStore.getState().reset(); // workspace switched while the old list was in flight
    const p3 = useSnapshotStore.getState().load();
    expect(api.list).toHaveBeenCalledTimes(2);
    await p3;
    release([meta({ id: "old", name: "旧工作区" })]);
    await Promise.all([p1, p2]);
    const s = useSnapshotStore.getState();
    expect(s.snapshots.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
  });
});

describe("auto snapshots", () => {
  it("derives turn start/end from agent activity, including exit", () => {
    const tab = { id: "t1", title: "Codex", cwd: "/ws", status: "running" as const, kind: "agent" as const };
    const base = { tabs: [tab], agentProfiles: [] };
    expect(agentTurnEvents({ ...base, agentActivity: { t1: "idle" } }, { ...base, agentActivity: { t1: "working" } })).toEqual([
      { tabId: "t1", phase: "start" },
    ]);
    expect(
      agentTurnEvents({ ...base, agentActivity: { t1: "working" } }, { ...base, agentActivity: { t1: "completed-unread" } }),
    ).toEqual([{ tabId: "t1", phase: "end" }]);
    expect(
      agentTurnEvents({ ...base, agentActivity: { t1: "working" } }, { tabs: [{ ...tab, status: "exited" }], agentProfiles: [], agentActivity: { t1: "working" } }),
    ).toEqual([{ tabId: "t1", phase: "end" }]);
  });

  it("merges starts within 5s, pairs the end with its start and labels empty turns", async () => {
    api.create.mockImplementation(async (args: { turn?: { phase: string }; name?: string; pairWithId?: string }) =>
      meta({ id: args.turn?.phase === "start" ? "start1" : "end1", source: "auto", name: args.name, ...(args.pairWithId ? { empty: true } : {}) }),
    );
    const store = useSnapshotStore.getState();
    await store.agentTurnStarted("t1", "Codex");
    await store.agentTurnStarted("t1", "Codex");
    expect(api.create).toHaveBeenCalledTimes(1);
    await store.agentTurnEnded("t1", "Codex");
    expect(api.create).toHaveBeenLastCalledWith(expect.objectContaining({ pairWithId: "start1", turn: { index: 1, phase: "end" } }));
    expect(useSnapshotStore.getState().snapshots.find((s) => s.id === "end1")!.name).toBe("第 1 轮结束");
    expect(api.rename).not.toHaveBeenCalled();
  });

  it("does nothing when auto snapshots are off", async () => {
    useSnapshotStore.setState({ autoEnabled: false });
    await useSnapshotStore.getState().agentTurnStarted("t1", "Codex");
    expect(api.create).not.toHaveBeenCalled();
  });
});
