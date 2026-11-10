// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore, type OpenItem } from "@/features/document/documentStore";
import { useWorkspaceStore, type TreeNode } from "@/features/workspace/workspaceStore";
import {
  explorerPathForItem,
  suppressExplorerRevealFor,
  useRevealActiveFileInExplorer,
  useScrollSelectedTreeRow,
} from "./revealActiveFile";

function fileItem(path: string): Extract<OpenItem, { kind: "file" }> {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return {
    id: `file:${path}`,
    kind: "file",
    path,
    title: name,
    relativePath: name,
    language: "typescript",
    isMarkdown: false,
    content: "",
    truncated: false,
    size: 0,
    mdViewMode: "rendered",
  };
}

function dir(path: string, children: TreeNode[] = [], expanded = false): TreeNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    type: "dir",
    expanded,
    loaded: true,
    children,
  };
}

function fileNode(path: string): TreeNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { name, path, type: "file", loaded: true };
}

function Harness() {
  useRevealActiveFileInExplorer();
  return null;
}

describe("explorerPathForItem", () => {
  it("resolves file, git diff, and snapshot-diff paths", () => {
    expect(explorerPathForItem(undefined)).toBeNull();
    expect(explorerPathForItem({ id: "welcome", kind: "welcome", title: "Welcome" })).toBeNull();
    expect(explorerPathForItem(fileItem("/ws/src/a.ts"))).toBe("/ws/src/a.ts");
    expect(
      explorerPathForItem({
        id: "diff:1",
        kind: "diff",
        title: "a.ts",
        repoRoot: "/ws",
        base: "HEAD",
        head: "worktree",
        files: [{ path: "src/a.ts", status: "M" }],
        activeFilePath: "src/a.ts",
      }),
    ).toBe("/ws/src/a.ts");
    expect(
      explorerPathForItem({
        id: "snap:1",
        kind: "snapshot-diff",
        title: "snap",
        payload: { workspaceRoot: "/ws", baseId: "a", targetId: "worktree", title: "snap", repos: [] },
        active: { repoRoot: "/ws/repo-b", path: "lib/b.ts" },
      }),
    ).toBe("/ws/repo-b/lib/b.ts");
  });
});

describe("useRevealActiveFileInExplorer", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaceRoot: "/ws",
      activeWorkspaceId: null,
      workspaceViews: {},
      rootEntries: [
        dir("/ws/src", [fileNode("/ws/src/a.ts"), fileNode("/ws/src/b.ts")]),
        fileNode("/ws/readme.md"),
      ],
      selectedPath: null,
      revealEpoch: 0,
    });
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
  });
  afterEach(() => {
    suppressExplorerRevealFor(null);
    cleanup();
  });

  it("reveals and selects the file when the active editor file changes", async () => {
    render(<Harness />);
    await act(async () => {
      useDocumentStore.setState({
        openItems: [fileItem("/ws/src/b.ts")],
        activeId: "file:/ws/src/b.ts",
      });
    });
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/src/b.ts");
    expect(useWorkspaceStore.getState().rootEntries[0]).toMatchObject({
      path: "/ws/src",
      expanded: true,
    });
    expect(useWorkspaceStore.getState().revealEpoch).toBe(1);
  });

  it("does not change selection when the active path is not in the tree", async () => {
    useWorkspaceStore.setState({ selectedPath: "/ws/readme.md" });
    render(<Harness />);
    await act(async () => {
      useDocumentStore.setState({
        openItems: [fileItem("/ws/not-in-tree.ts")],
        activeId: "file:/ws/not-in-tree.ts",
      });
    });
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/readme.md");
    expect(useWorkspaceStore.getState().revealEpoch).toBe(0);
  });

  it("skips reveal when the user just clicked that row in the tree", async () => {
    const reveal = vi.spyOn(useWorkspaceStore.getState(), "revealInExplorer");
    suppressExplorerRevealFor("/ws/src/a.ts");
    render(<Harness />);
    await act(async () => {
      useDocumentStore.setState({
        openItems: [fileItem("/ws/src/a.ts")],
        activeId: "file:/ws/src/a.ts",
      });
    });
    expect(reveal).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().selectedPath).toBeNull();
    reveal.mockRestore();
  });
});

describe("useScrollSelectedTreeRow", () => {
  afterEach(() => cleanup());

  it("scrolls the selected row into view when revealEpoch changes", () => {
    const scrollIntoView = vi.fn();
    function ScrollHarness() {
      const ref = { current: document.getElementById("tree-root") };
      useScrollSelectedTreeRow(ref);
      return (
        <div id="tree-root">
          <button type="button" className="file-tree__row">other</button>
          <button type="button" className="file-tree__row is-selected">target</button>
        </div>
      );
    }
    useWorkspaceStore.setState({ selectedPath: "/ws/src/a.ts", revealEpoch: 0 });
    const { rerender } = render(<ScrollHarness />);
    const selected = screen.getByText("target");
    selected.scrollIntoView = scrollIntoView;
    act(() => {
      useWorkspaceStore.setState({ revealEpoch: 1 });
    });
    rerender(<ScrollHarness />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});
