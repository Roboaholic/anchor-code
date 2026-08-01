import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "./workspaceStore";

describe("workspace root refresh", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaceRoot: "/workspace",
      workspaceName: "workspace",
      hostProfileId: "wsl-default",
      hostKind: "wsl",
      recent: [],
      rootEntries: [
        {
          name: "existing.ts",
          path: "/workspace/existing.ts",
          type: "file",
          loaded: true,
          expanded: false,
        },
      ],
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
    vi.unstubAllGlobals();
  });
});
