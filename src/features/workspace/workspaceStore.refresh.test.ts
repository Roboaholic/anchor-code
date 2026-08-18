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
