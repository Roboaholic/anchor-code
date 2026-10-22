// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/shell/orchestrate", () => ({
  openHistoryCompare: vi.fn(),
  openHistoryRecent: vi.fn(),
  openWorkingTreeFileDiff: vi.fn(),
}));

vi.mock("@/shared/appActivity", async (orig) => ({
  ...(await orig<typeof import("@/shared/appActivity")>()),
  isAppActive: () => true,
}));

import { HistoryPane } from "./HistoryPane";
import { UNTRACKED_SCAN_MS, useHistoryStore, type RepoCardState } from "./historyStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { RepoStatus } from "@/shared/anchor-api";
import { mergeBadgePorcelain } from "@/core/history/statusParse";

const ROOT = "/ws";

function card(patch: Partial<RepoCardState> & { root: string; name: string }): RepoCardState {
  return {
    expanded: false,
    changesOpen: true,
    historyOpen: false,
    comparesOpen: false,
    commits: [],
    logHasMore: false,
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
    ...patch,
  };
}

const dirtyStatus: RepoStatus = {
  repoRoot: `${ROOT}/embedded_bmad_engineering`,
  entries: [
    { path: "src/a.ts", status: "M", code: " M" },
    { path: "src/b.ts", status: "M", code: " M" },
    { path: "src/new.ts", status: "A", code: "A " },
    { path: "old.md", status: "D", code: " D" },
    { path: "notes.txt", status: "?", code: "??" },
  ],
  modified: 2,
  added: 1,
  deleted: 1,
  untracked: 1,
  branch: "feature/very-long-branch-name-for-layout",
  ahead: 3,
  behind: 2,
};

function setRepos(repos: RepoCardState[]) {
  act(() => {
    useHistoryStore.setState({
      workspaceRoot: ROOT,
      discoverStatus: "idle",
      discoverError: null,
      repos,
      softRefreshStatuses: vi.fn(async () => {}),
      refreshAllStatuses: vi.fn(async () => {}),
      scanUntracked: vi.fn(async () => {}),
      refreshRepo: vi.fn(async () => {}),
    });
  });
}

describe("HistoryPane repo rows", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspaceRoot: ROOT });
  });
  afterEach(() => cleanup());

  it("shows a single M badge with the change breakdown in the tooltip", () => {
    setRepos([card({ root: `${ROOT}/embedded_bmad_engineering`, name: "embedded_bmad_engineering", status: dirtyStatus })]);
    render(<HistoryPane />);
    const badges = [...document.querySelectorAll(".repo-row__badge")];
    expect(badges.map((b) => b.textContent)).toEqual(["M"]);
    expect(badges[0]!.getAttribute("title")).toBe(
      "Changes: 2 modified, 1 added, 1 deleted, 1 untracked",
    );
    expect(screen.queryByText("?1")).toBeNull();
    // One row: name left; right group = ↑↓, branch, one badge slot (last).
    const header = document.querySelector(".repo-row__header") as HTMLElement;
    expect([...header.children].map((c) => c.className.split(" ")[0])).toEqual([
      "repo-row__expand",
      "repo-row__fill",
      "repo-row__syncs",
      "repo-branch",
      "repo-row__meta",
    ]);
    expect(within(header.querySelector(".repo-branch") as HTMLElement).getByText("feature/very-long-branch-name-for-layout")).toBeTruthy();
    const syncs = header.querySelector(".repo-row__syncs") as HTMLElement;
    expect([...syncs.children].map((c) => c.textContent)).toEqual(["↑3", "↓2"]);
    const meta = header.querySelector(".repo-row__meta") as HTMLElement;
    expect([...meta.children].map((c) => c.textContent)).toEqual(["M"]);
    // No native tooltips on the row except the M breakdown.
    expect([...header.querySelectorAll("[title]")]).toEqual([badges[0]]);
  });

  it("shows M for untracked-only changes, omits zero parts, and shows nothing when clean", () => {
    setRepos([
      card({
        root: `${ROOT}/cli`,
        name: "cli",
        status: { ...dirtyStatus, entries: [{ path: "n.txt", status: "?", code: "??" }], modified: 0, added: 0, deleted: 0, untracked: 3, ahead: 0, behind: 0 },
      }),
      card({
        root: `${ROOT}/clean`,
        name: "clean",
        status: { ...dirtyStatus, entries: [], modified: 0, added: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0 },
      }),
    ]);
    render(<HistoryPane />);
    const rows = [...document.querySelectorAll(".repo-row")] as HTMLElement[];
    const dirty = rows[0]!.querySelectorAll(".repo-row__badge");
    expect([...dirty].map((b) => b.textContent)).toEqual(["M"]);
    expect(dirty[0]!.getAttribute("title")).toBe("Changes: 3 untracked");
    // Clean repo: nothing in the badge slot (no ✓, no label), slot still there.
    const cleanMeta = rows[1]!.querySelector(".repo-row__meta") as HTMLElement;
    expect(cleanMeta).not.toBeNull();
    expect(cleanMeta.children.length).toBe(0);
    expect(cleanMeta.textContent).toBe("");
    expect(screen.queryByLabelText("No local changes")).toBeNull();
    expect(screen.queryByLabelText("No tracked changes")).toBeNull();
    expect(document.querySelector(".repo-row__sync")).toBeNull();
  });

  it("keeps an untracked-only repo lit after a badge-only poll (U in the breakdown)", () => {
    const base = { repoRoot: `${ROOT}/gtest`, modified: 0, added: 0, deleted: 0, branch: "dev", ahead: 0, behind: 0 };
    // Full status (repo expanded once) saw the untracked file…
    const full: RepoStatus = { ...base, entries: [{ path: "notes.txt", status: "?", code: "??" }], untracked: 1 };
    // …the 30s badge poll runs with --untracked-files=no and sees nothing.
    const badgeOnly: RepoStatus = { ...base, entries: [], untracked: 0 };
    setRepos([card({ root: `${ROOT}/gtest`, name: "gtest", status: mergeBadgePorcelain(full, badgeOnly) })]);
    render(<HistoryPane />);
    const badge = document.querySelector(".repo-row__badge--modified") as HTMLElement;
    expect(badge.textContent).toBe("M");
    expect(badge.getAttribute("title")).toBe("Changes: 1 untracked");
    expect(document.querySelector(".repo-row__badge--clean")).toBeNull();
  });

  it("shows the per-repo refresh only when the repo is expanded", () => {
    setRepos([
      card({ root: `${ROOT}/a`, name: "a", status: dirtyStatus }),
      card({ root: `${ROOT}/b`, name: "b", status: dirtyStatus, expanded: true }),
    ]);
    render(<HistoryPane />);
    const rows = [...document.querySelectorAll(".repo-row")] as HTMLElement[];
    expect(within(rows[0]!).queryByRole("button", { name: "Refresh" })).toBeNull();
    const refresh = within(rows[1]!).getByRole("button", { name: "Refresh" });
    // Never in the repo title row: last item of the CHANGES head (far right).
    expect(refresh.closest(".repo-row__header")).toBeNull();
    const head = refresh.closest(".repo-block__head") as HTMLElement;
    expect(within(head).getByText("Changes")).toBeTruthy();
    expect(head.lastElementChild).toBe(refresh);
    expect(refresh.hasAttribute("title")).toBe(false);
    fireEvent.click(refresh);
    expect(useHistoryStore.getState().refreshRepo).toHaveBeenCalledWith(`${ROOT}/b`);
    // Top-level refresh-all stays.
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  });

  it("renders the Changes header on one line and Commit below the file list", () => {
    setRepos([card({ root: `${ROOT}/r`, name: "r", status: dirtyStatus, expanded: true })]);
    render(<HistoryPane />);
    const head = document.querySelector(".repo-block__head") as HTMLElement;
    expect(within(head).getByText("Changes")).toBeTruthy();
    expect(within(head).getByText("5")).toBeTruthy();
    const seg = within(head).getByRole("group", { name: "Select files to commit" });
    expect(within(seg).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Tracked"]);
    expect(within(head).queryByText(/commit/i)).toBeNull();
    expect(within(seg).getByText("Tracked").getAttribute("title")).toMatch(/untracked \(U\)/);

    const list = document.querySelector(".wt-list") as HTMLElement;
    const commit = screen.getByRole("button", { name: "Commit 5 files" });
    // Commit follows the list in document order.
    expect(list.compareDocumentPosition(commit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Untracked files read "U", not "?".
    const statuses = [...list.querySelectorAll(".wt-row__status")].map((s) => s.textContent);
    expect(statuses).toEqual(["M", "M", "A", "D", "U"]);

    fireEvent.click(within(seg).getByText("Tracked"));
    expect(screen.getByRole("button", { name: "Commit 4 files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Commit 4 files" }));
    expect(screen.getByPlaceholderText("Commit message")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Commit message")).toBeNull();
  });

  it("keeps the branch + badge columns aligned: ↑↓ left of the branch, fixed badge slot last", () => {
    const clean = { ...dirtyStatus, entries: [], modified: 0, added: 0, deleted: 0, untracked: 0, ahead: 0, behind: 0, branch: "miles_lv_suspend" };
    setRepos([
      card({ root: `${ROOT}/a`, name: "a", status: clean }),
      card({ root: `${ROOT}/b`, name: "b", status: { ...dirtyStatus, branch: null, ahead: 0, behind: 0 } }),
      card({ root: `${ROOT}/c`, name: "c", status: dirtyStatus, statusState: "loading" }),
    ]);
    render(<HistoryPane />);
    const headers = [...document.querySelectorAll(".repo-row__header")] as HTMLElement[];
    for (const h of headers) {
      // Branch then the badge slot are always the last two items.
      expect([...h.children].slice(-2).map((c) => c.className.split(" ")[0])).toEqual(["repo-branch", "repo-row__meta"]);
    }
    // Slot holds at most one badge; empty for the clean repo.
    expect(headers.map((h) => h.querySelector(".repo-row__meta")!.children.length)).toEqual([0, 1, 1]);
    expect(headers[0]!.querySelector(".repo-row__syncs")).toBeNull();
    expect(within(headers[0]!).getByText("miles_lv_suspend")).toBeTruthy();
    expect(within(headers[1]!).getByText("detached")).toBeTruthy();
    // Dirty + refreshing keeps the lit M (no second "…" badge).
    expect(headers[2]!.querySelector(".repo-row__meta")!.textContent).toBe("M");
  });
});

describe("HistoryPane untracked scan triggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ workspaceRoot: ROOT });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("scans every 5 minutes, never on the 30s tracked poll", async () => {
    setRepos([card({ root: `${ROOT}/a`, name: "a", status: dirtyStatus })]);
    render(<HistoryPane />);
    const { scanUntracked, softRefreshStatuses } = useHistoryStore.getState() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNTRACKED_SCAN_MS - 1);
    });
    expect(softRefreshStatuses!.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(scanUntracked).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(scanUntracked).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNTRACKED_SCAN_MS);
    });
    expect(scanUntracked).toHaveBeenCalledTimes(2);
  });

  it("Repos Refresh runs the tracked pass, then the untracked scan", async () => {
    setRepos([card({ root: `${ROOT}/a`, name: "a", status: dirtyStatus })]);
    render(<HistoryPane />);
    const { scanUntracked, refreshAllStatuses } = useHistoryStore.getState() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshAllStatuses).toHaveBeenCalledTimes(1);
    expect(scanUntracked).toHaveBeenCalledTimes(1);
    expect(refreshAllStatuses!.mock.invocationCallOrder[0]!).toBeLessThan(scanUntracked!.mock.invocationCallOrder[0]!);
  });
});
