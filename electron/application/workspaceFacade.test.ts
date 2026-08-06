import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { HostManager } from "../host/hostManager.js";
import type { TerminalService } from "../services/terminalService.js";
import { WorkspaceFacade } from "./workspaceFacade.js";

describe("WorkspaceFacade", () => {
  it("publishes workspace changes with the caller source", async () => {
    const workspacePath = path.resolve("/workspace");
    const host = {
      kind: "local" as const,
      profileId: "local-default",
      workspaceRoot: null as string | null,
      async exists() { return true; },
      async stat() { return { isDir: true, isFile: false, size: 0, mtimeMs: 0 }; },
    };
    const hosts = {
      profileId: "local-default",
      session: host,
    } as unknown as HostManager;
    const terminal = { disposeAll: vi.fn() } as unknown as TerminalService;
    const onChanged = vi.fn();
    const facade = new WorkspaceFacade(hosts, terminal, onChanged, {
      async load() {
        return {
          recentWorkspaces: [],
          hostProfiles: [{ id: "local-default", kind: "local" as const, label: "Local" }],
        };
      },
      async getHostProfile() { return null; },
      async pushRecent() { return []; },
    });

    await facade.open({ path: "/workspace", hostProfileId: "local-default" });
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: workspacePath }),
      "desktop",
    );

    await facade.open(
      { path: "/workspace", hostProfileId: "local-default" },
      { source: "remote" },
    );
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: workspacePath }),
      "remote",
    );
  });

  it("rejects remote selection of a workspace not approved on the PC", async () => {
    const host = {
      kind: "local" as const,
      profileId: "local-default",
      workspaceRoot: "/approved" as string | null,
      async exists() { return true; },
      async stat() { return { isDir: true, isFile: false, size: 0, mtimeMs: 0 }; },
    };
    const hosts = {
      profileId: "local-default",
      session: host,
    } as unknown as HostManager;
    const facade = new WorkspaceFacade(
      hosts,
      { disposeAll: vi.fn() } as unknown as TerminalService,
      undefined,
      {
        async load() {
          return {
            recentWorkspaces: [{ path: "/approved", hostProfileId: "local-default", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
            hostProfiles: [{ id: "local-default", kind: "local" as const, label: "Local" }],
          };
        },
        async getHostProfile() { return null; },
        async pushRecent() { return []; },
      },
    );

    await expect(facade.open(
      { path: "/not-approved", hostProfileId: "local-default" },
      { requireApproved: true, source: "remote" },
    )).rejects.toMatchObject({ code: "permission" });
  });
});
