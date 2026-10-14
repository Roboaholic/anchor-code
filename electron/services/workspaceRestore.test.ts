import { describe, expect, it, vi } from "vitest";
import { resolveRestoreTarget, type RestoreDeps } from "./workspaceRestore";
import type { WorkspaceInstancesState } from "./workspaceState";

const instance = (id: string, root: string, hostProfileId = "local-default") => ({
  id,
  root,
  name: root,
  hostProfileId,
  hostKind: "local" as const,
  definitionPath: null,
  openedAt: "",
  lastActiveAt: "",
  foreground: false,
  restore: {} as never,
});

function deps(over: Partial<RestoreDeps> = {}, state?: WorkspaceInstancesState): RestoreDeps {
  return {
    enabled: async () => true,
    loadInstances: async () =>
      state ?? {
        version: 1,
        activeWorkspaceId: "b",
        openWorkspaces: [instance("a", "/a"), instance("b", "/b")],
      },
    getHostProfile: async (id) => ({ id, kind: "local", label: "Local" }),
    probe: async () => true,
    ...over,
  };
}

describe("resolveRestoreTarget", () => {
  it("returns the active instance when reachable", async () => {
    await expect(resolveRestoreTarget(deps())).resolves.toEqual({
      path: "/b",
      hostProfileId: "local-default",
    });
  });

  it("returns null when disabled", async () => {
    const probe = vi.fn(async () => true);
    await expect(resolveRestoreTarget(deps({ enabled: async () => false, probe }))).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns null when no workspace was active (user closed all)", async () => {
    await expect(
      resolveRestoreTarget(deps({}, { version: 1, activeWorkspaceId: null, openWorkspaces: [] })),
    ).resolves.toBeNull();
  });

  it("falls back when the path is missing or the probe throws", async () => {
    await expect(resolveRestoreTarget(deps({ probe: async () => false }))).resolves.toBeNull();
    await expect(
      resolveRestoreTarget(deps({ probe: async () => { throw new Error("wsl down"); } })),
    ).resolves.toBeNull();
  });

  it("falls back on probe timeout (unreachable host)", async () => {
    const t0 = Date.now();
    const result = await resolveRestoreTarget(
      deps({ probe: () => new Promise<boolean>(() => undefined), timeoutMs: 30 }),
    );
    expect(result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("falls back when the host profile was removed", async () => {
    await expect(resolveRestoreTarget(deps({ getHostProfile: async () => null }))).resolves.toBeNull();
  });
});
