import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "./workspaceStore";

describe("workspace root refresh", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaceRoot: "/workspace",
      workspaceName: "workspace",
      hostProfileId: "wsl-default",
      hostKind: "wsl",
      recent: [],
      openWorkspaces: [],
      activeWorkspaceId: null,
      rootEntries: [
        {
          name: "existing.ts",
          path: "/workspace/existing.ts",
          type: "file",
          loaded: true,
          expanded: false,
        },
      ],
      workspaceViews: {},
      status: "ready",
      error: null,
      selectedPath: null,
    });
  });

  it("adds files created in the workspace root", async () => {
    const listDir = vi.fn().mockResolvedValue([
      { name: "existing.ts", type: "file" },
      { name: "new-file.ts", type: "file" },
    ]);
    vi.stubGlobal("window", {
      anchor: { workspace: { listDir } },
    });

    await useWorkspaceStore.getState().refreshDir("/workspace");

    expect(listDir).toHaveBeenCalledWith("/workspace");
    expect(useWorkspaceStore.getState().rootEntries.map((node) => node.name)).toEqual([
      "existing.ts",
      "new-file.ts",
    ]);
  });

  it("activates a cached workspace without entering a loading state", async () => {
    const workspaceA = {
      id: "workspace-a",
      root: "/workspace-a",
      name: "workspace-a",
      hostProfileId: "wsl-default",
      hostKind: "wsl" as const,
      definitionPath: null,
      openedAt: "2026-08-23T00:00:00.000Z",
      lastActiveAt: "2026-08-23T00:00:00.000Z",
      foreground: false,
      restore: {
        ui: {
          leftMode: "files" as const,
          selectedPath: null,
          expandedDirs: [],
          agentVisible: false,
          terminalVisible: false,
        },
        documents: { activeItemId: null, openItems: [] },
        agents: { activeAgentId: null, openSessions: [] },
        terminals: { activeTerminalId: null, openTabs: [] },
      },
    };
    const workspaceB = { ...workspaceA, id: "workspace-b", root: "/workspace-b", name: "workspace-b", foreground: true };
    const cachedTree = [
      {
        name: "README.md",
        path: "/workspace-b/README.md",
        type: "file" as const,
        loaded: true,
        expanded: false,
      },
    ];
    const activate = vi.fn().mockResolvedValue({
      root: workspaceB.root,
      name: workspaceB.name,
      hostKind: workspaceB.hostKind,
      hostProfileId: workspaceB.hostProfileId,
      workspaceInstance: workspaceB,
      workspaceInstances: {
        version: 1,
        activeWorkspaceId: workspaceB.id,
        openWorkspaces: [workspaceA, workspaceB],
      },
    });
    const listOpenInstances = vi.fn().mockResolvedValue({
      version: 1 as const,
      activeWorkspaceId: workspaceB.id,
      openWorkspaces: [workspaceA, workspaceB],
    });

    useWorkspaceStore.setState({
      workspaceRoot: workspaceA.root,
      workspaceName: workspaceA.name,
      hostProfileId: workspaceA.hostProfileId,
      hostKind: workspaceA.hostKind,
      openWorkspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceA.id,
      rootEntries: [],
      workspaceViews: {
        [workspaceB.id]: {
          rootEntries: cachedTree,
          status: "ready",
          error: null,
          selectedPath: cachedTree[0]!.path,
          loadedAt: "2026-08-23T00:00:00.000Z",
        },
      },
      status: "ready",
      error: null,
      selectedPath: null,
    });
    vi.stubGlobal("window", {
      anchor: {
        workspace: { activate, listOpenInstances },
      },
    });

    await useWorkspaceStore.getState().activateWorkspace(workspaceB.id);

    expect(activate).toHaveBeenCalledWith(workspaceB.id);
    expect(listOpenInstances).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaceRoot).toBe(workspaceB.root);
    expect(useWorkspaceStore.getState().rootEntries).toBe(cachedTree);
    expect(useWorkspaceStore.getState().selectedPath).toBe(cachedTree[0]!.path);
    expect(useWorkspaceStore.getState().status).toBe("ready");
  });

  it("does not apply a directory refresh after switching the host at the same path", async () => {
    let finish!: (entries: Array<{ name: string; type: "file" }>) => void;
    const listDir = vi.fn(() => new Promise<Array<{ name: string; type: "file" }>>((resolve) => { finish = resolve; }));
    vi.stubGlobal("window", { anchor: { workspace: { listDir } } });
    const refresh = useWorkspaceStore.getState().refreshDir("/workspace");
    const currentTree = useWorkspaceStore.getState().rootEntries;
    useWorkspaceStore.setState({ hostProfileId: "other-host" });
    finish([{ name: "stale.ts", type: "file" }]);
    await refresh;
    expect(useWorkspaceStore.getState().rootEntries).toBe(currentTree);
  });

  it("keeps the newest workspace when activation replies arrive out of order", async () => {
    const response = (root: string) => ({
      root, name: root, hostKind: "local", hostProfileId: "local-default",
      workspaceInstance: { id: root },
      workspaceInstances: { version: 1, activeWorkspaceId: root, openWorkspaces: [] },
    });
    let finishFirst!: (value: ReturnType<typeof response>) => void;
    const activate = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(response("/latest"));
    vi.stubGlobal("window", { anchor: { workspace: { activate } } });
    const first = useWorkspaceStore.getState().activateWorkspace("/older");
    await useWorkspaceStore.getState().activateWorkspace("/latest");
    finishFirst(response("/older"));
    await first;
    expect(useWorkspaceStore.getState().workspaceRoot).toBe("/latest");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("/latest");
  });
  it("restores a cached open workspace tree without reloading the root", async () => {
    const cachedTree = [
      {
        name: "src",
        path: "/workspace/src",
        type: "dir" as const,
        loaded: true,
        expanded: true,
        children: [
          {
            name: "index.ts",
            path: "/workspace/src/index.ts",
            type: "file" as const,
            loaded: true,
            expanded: false,
          },
        ],
      },
    ];
    const restore = {
      ui: {
        leftMode: "files" as const,
        selectedPath: "/workspace/src/index.ts",
        expandedDirs: ["/workspace/src"],
        agentVisible: true,
        terminalVisible: false,
      },
      documents: { activeItemId: null, openItems: [] },
      agents: { activeAgentId: null, openSessions: [] },
      terminals: { activeTerminalId: null, openTabs: [] },
    };
    const instance = {
      id: "workspace-1",
      root: "/workspace",
      name: "workspace",
      hostProfileId: "wsl-default",
      hostKind: "wsl" as const,
      definitionPath: null,
      openedAt: "2026-08-18T00:00:00.000Z",
      lastActiveAt: "2026-08-18T00:00:00.000Z",
      foreground: true,
      restore,
    };
    const listDir = vi.fn().mockRejectedValue(new Error("root should stay cached"));
    const open = vi.fn().mockResolvedValue({
      root: "/workspace",
      name: "workspace",
      hostKind: "wsl" as const,
      hostProfileId: "wsl-default",
      workspaceInstance: instance,
    });
    const listOpenInstances = vi.fn().mockResolvedValue({
      version: 1 as const,
      activeWorkspaceId: "workspace-1",
      openWorkspaces: [instance],
    });
    const getRecent = vi.fn().mockResolvedValue([]);

    useWorkspaceStore.setState({
      workspaceRoot: "/other",
      workspaceName: "other",
      activeWorkspaceId: "other-1",
      selectedPath: "/other/file.ts",
      workspaceViews: {
        "workspace-1": {
          rootEntries: cachedTree,
          status: "ready",
          error: null,
          selectedPath: "/workspace/src/index.ts",
          loadedAt: "2026-08-18T00:00:00.000Z",
        },
      },
    });
    vi.stubGlobal("window", {
      anchor: {
        workspace: {
          open,
          listOpenInstances,
          getRecent,
          listDir,
        },
      },
    });

    await useWorkspaceStore.getState().openPath("/workspace", {
      hostProfileId: "wsl-default",
    });

    expect(listDir).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().rootEntries).toBe(cachedTree);
    expect(useWorkspaceStore.getState().selectedPath).toBe("/workspace/src/index.ts");
    expect(useWorkspaceStore.getState().status).toBe("ready");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
