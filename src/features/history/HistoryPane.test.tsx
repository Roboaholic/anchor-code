// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/shell/orchestrate", () => ({
  openHistoryCompare: vi.fn(),
  openHistoryRecent: vi.fn(),
  openWorkingTreeFileDiff: vi.fn(),
}));

import { HistoryPane } from "./HistoryPane";
import { useHistoryStore, type RepoCardState } from "./historyStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { RepoStatus } from "@/shared/anchor-api";

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
    // Ahead / behind live on the branch line, not in the badge.
    const branchLine = document.querySelector(".repo-row__line--branch") as HTMLElement;
    expect(within(branchLine).getByText("feature/very-long-branch-name-for-layout")).toBeTruthy();
    expect(within(branchLine).getByText("↑3")).toBeTruthy();
    expect(within(branchLine).getByText("↓2")).toBeTruthy();
  });

  it("shows M for untracked-only changes, omits zero parts, and hides it when clean", () => {
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
    expect(rows[1]!.querySelector(".repo-row__badge")).toBeNull();
    expect(document.querySelector(".repo-row__sync")).toBeNull();
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
    expect(refresh.closest(".repo-row__line--branch")).not.toBeNull();
    // Branch line order: branch, then ↑/↓, then refresh last (far right).
    const line = refresh.closest(".repo-row__line--branch") as HTMLElement;
    expect([...line.children].map((c) => c.className.split(" ").find((k) => k.startsWith("repo-")))).toEqual([
      "repo-branch",
      "repo-row__sync",
      "repo-row__sync",
      "repo-row__refresh",
    ]);
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
});
