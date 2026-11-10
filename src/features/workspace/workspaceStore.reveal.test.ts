import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore, type TreeNode } from "./workspaceStore";

function file(path: string, name = path.slice(path.lastIndexOf("/") + 1)): TreeNode {
  return { name, path, type: "file", loaded: true };
}

function dir(
  path: string,
  children: TreeNode[] = [],
  opts: Partial<TreeNode> = {},
): TreeNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const loaded = opts.loaded ?? children.length > 0;
  return {
    name,
    path,
    type: "dir",
    expanded: opts.expanded ?? false,
    loaded,
    loading: opts.loading ?? false,
    children,
    ...opts,
  };
}

const node = (path: string) => {
  const walk = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.path.replace(/\\/g, "/") === path.replace(/\\/g, "/")) return n;
      const hit = n.children && walk(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(useWorkspaceStore.getState().rootEntries);
};

describe("revealInExplorer", () => {
  const listDir = vi.fn(async (path: string): Promise<{ name: string; type: "file" | "dir" }[]> => {
    if (path === "/ws/src") return [{ name: "lib", type: "dir" }, { name: "a.ts", type: "file" }];
    if (path === "/ws/src/lib") return [{ name: "b.ts", type: "file" }];
    if (path === "/ws/missing-parent") return [{ name: "only.ts", type: "file" }];
    return [];
  });

  beforeEach(() => {
    listDir.mockClear();
    vi.stubGlobal("window", { anchor: { workspace: { listDir } } });
    useWorkspaceStore.setState({
      workspaceRoot: "/ws",
      activeWorkspaceId: null,
      workspaceViews: {},
      rootEntries: [
        dir("/ws/src"),
        file("/ws/readme.md"),
        dir("/ws/node_modules"),
      ],
      selectedPath: null,
      revealEpoch: 0,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("expands ancestor folders, selects the file, and bumps revealEpoch", async () => {
    const ok = await useWorkspaceStore.getState().revealInExplorer("/ws/src/lib/b.ts");
    expect(ok).toBe(true);
    expect(node("/ws/src")).toMatchObject({ expanded: true, loaded: true });
    expect(node("/ws/src/lib")).toMatchObject({ expanded: true, loaded: true });
    expect(node("/ws/src/lib/b.ts")).toBeTruthy();
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/src/lib/b.ts");
    expect(useWorkspaceStore.getState().revealEpoch).toBe(1);
    expect(listDir).toHaveBeenCalledWith("/ws/src");
    expect(listDir).toHaveBeenCalledWith("/ws/src/lib");
  });

  it("selects a root-level file without listing directories", async () => {
    const ok = await useWorkspaceStore.getState().revealInExplorer("/ws/readme.md");
    expect(ok).toBe(true);
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/readme.md");
    expect(listDir).not.toHaveBeenCalled();
    expect(node("/ws/src")?.expanded).toBe(false);
  });

  it("does not collapse directories that are already expanded", async () => {
    useWorkspaceStore.setState({
      rootEntries: [
        dir("/ws/src", [file("/ws/src/a.ts"), dir("/ws/src/lib", [file("/ws/src/lib/b.ts")], { expanded: true, loaded: true })], {
          expanded: true,
          loaded: true,
        }),
      ],
      selectedPath: "/ws/src/a.ts",
      revealEpoch: 3,
    });
    const ok = await useWorkspaceStore.getState().revealInExplorer("/ws/src/lib/b.ts");
    expect(ok).toBe(true);
    expect(node("/ws/src")?.expanded).toBe(true);
    expect(node("/ws/src/lib")?.expanded).toBe(true);
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/src/lib/b.ts");
    expect(useWorkspaceStore.getState().revealEpoch).toBe(4);
    expect(listDir).not.toHaveBeenCalled();
  });

  it("is a no-op when the path is outside the workspace", async () => {
    const ok = await useWorkspaceStore.getState().revealInExplorer("/other/a.ts");
    expect(ok).toBe(false);
    expect(useWorkspaceStore.getState().selectedPath).toBeNull();
    expect(useWorkspaceStore.getState().revealEpoch).toBe(0);
    expect(listDir).not.toHaveBeenCalled();
  });

  it("is a no-op when the file is not present in the tree", async () => {
    useWorkspaceStore.setState({ selectedPath: "/ws/readme.md" });
    const ok = await useWorkspaceStore.getState().revealInExplorer("/ws/src/nope.ts");
    expect(ok).toBe(false);
    expect(useWorkspaceStore.getState().selectedPath).toBe("/ws/readme.md");
    expect(useWorkspaceStore.getState().revealEpoch).toBe(0);
    expect(node("/ws/src")?.expanded).toBe(true);
  });

  it("is a no-op for files under a skipped directory", async () => {
    const ok = await useWorkspaceStore.getState().revealInExplorer("/ws/node_modules/pkg/index.js");
    expect(ok).toBe(false);
    expect(useWorkspaceStore.getState().selectedPath).toBeNull();
    expect(listDir).not.toHaveBeenCalled();
  });

  it("matches tree paths when separators differ", async () => {
    useWorkspaceStore.setState({
      workspaceRoot: "C:\\ws",
      rootEntries: [
        dir("C:\\ws\\src", [file("C:\\ws\\src\\a.ts")], { expanded: false, loaded: true }),
      ],
    });
    const ok = await useWorkspaceStore.getState().revealInExplorer("C:/ws/src/a.ts");
    expect(ok).toBe(true);
    expect(useWorkspaceStore.getState().selectedPath).toBe("C:\\ws\\src\\a.ts");
    expect(node("C:\\ws\\src")?.expanded).toBe(true);
    expect(listDir).not.toHaveBeenCalled();
  });
});
