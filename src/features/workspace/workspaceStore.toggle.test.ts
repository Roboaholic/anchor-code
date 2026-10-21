import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore, visibleEntrySignature, type TreeNode } from "./workspaceStore";

const dir = (name: string): TreeNode => ({
  name, path: `/ws/${name}`, type: "dir", expanded: false, loaded: false, children: [],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const node = (path: string) => {
  const walk = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.path === path) return n;
      const hit = n.children && walk(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(useWorkspaceStore.getState().rootEntries);
};

describe("toggleDir on slow (remote) listings", () => {
  const pending = new Map<string, ReturnType<typeof deferred<{ name: string; type: "file" | "dir" }[]>>>();
  const listDir = vi.fn((path: string) => {
    const d = deferred<{ name: string; type: "file" | "dir" }[]>();
    pending.set(path, d);
    return d.promise;
  });

  beforeEach(() => {
    pending.clear();
    listDir.mockClear();
    vi.stubGlobal("window", { anchor: { workspace: { listDir } } });
    useWorkspaceStore.setState({
      workspaceRoot: "/ws",
      activeWorkspaceId: null,
      workspaceViews: {},
      rootEntries: [dir("a"), dir("b"), dir("node_modules")],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("expands immediately and fills children when the listing arrives", async () => {
    const done = useWorkspaceStore.getState().toggleDir("/ws/a");
    expect(node("/ws/a")).toMatchObject({ expanded: true, loading: true, loaded: false });
    pending.get("/ws/a")!.resolve([{ name: "x.ts", type: "file" }]);
    await done;
    expect(node("/ws/a")).toMatchObject({ expanded: true, loading: false, loaded: true });
    expect(node("/ws/a")!.children!.map((c) => c.name)).toEqual(["x.ts"]);
  });

  it("does not let one slow expand overwrite another", async () => {
    const first = useWorkspaceStore.getState().toggleDir("/ws/a");
    const second = useWorkspaceStore.getState().toggleDir("/ws/b");
    pending.get("/ws/b")!.resolve([{ name: "b.ts", type: "file" }]);
    await second;
    pending.get("/ws/a")!.resolve([{ name: "a.ts", type: "file" }]);
    await first;
    expect(node("/ws/a/a.ts")).toBeTruthy();
    expect(node("/ws/b/b.ts")).toBeTruthy();
    expect(node("/ws/a")!.expanded && node("/ws/b")!.expanded).toBe(true);
  });

  it("keeps a listing error on the node and does not list again on re-toggle", async () => {
    const done = useWorkspaceStore.getState().toggleDir("/ws/a");
    pending.get("/ws/a")!.reject(new Error("boom"));
    await done;
    expect(node("/ws/a")).toMatchObject({ expanded: true, loaded: true, error: expect.stringContaining("boom") });
    await useWorkspaceStore.getState().toggleDir("/ws/a");
    await useWorkspaceStore.getState().toggleDir("/ws/a");
    expect(listDir).toHaveBeenCalledTimes(1);
  });

  it("never lists skipped directories", async () => {
    await useWorkspaceStore.getState().toggleDir("/ws/node_modules");
    expect(listDir).not.toHaveBeenCalled();
    expect(node("/ws/node_modules")).toMatchObject({ expanded: true, loaded: true });
  });
});

describe("visibleEntrySignature", () => {
  it("ignores entries the tree hides, so polling does not see phantom changes", () => {
    const shown = [{ name: "src", type: "dir" as const }, { name: "a.ts", type: "file" as const }];
    expect(visibleEntrySignature([...shown, { name: "node_modules", type: "dir" }, { name: ".DS_Store", type: "file" }]))
      .toBe(visibleEntrySignature([...shown].reverse()));
    expect(visibleEntrySignature(shown)).not.toBe(visibleEntrySignature([...shown, { name: "b.ts", type: "file" }]));
  });
});
