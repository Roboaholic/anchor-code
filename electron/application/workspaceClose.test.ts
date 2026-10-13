import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-ws-close-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { WorkspaceFacade } = await import("./workspaceFacade.js");
const state = await import("../services/workspaceState.js");
const { TerminalService } = await import("../services/terminalService.js");

function makeFacade(disposeUnder = vi.fn(), disposeSearchHelper = vi.fn()) {
  const host = {
    kind: "wsl" as const,
    profileId: "wsl-1",
    workspaceRoot: "/a" as string | null,
    disposeSearchHelper,
  };
  const hosts = { profileId: "wsl-1", session: host } as never;
  const terminal = { disposeAll: vi.fn(), disposeUnder } as never;
  return { facade: new WorkspaceFacade(hosts, terminal), host };
}

async function seed() {
  await state.recordActiveWorkspaceInstance({ root: "/b", name: "b", hostProfileId: "wsl-1", hostKind: "wsl" });
  await new Promise((r) => setTimeout(r, 5));
  await state.recordActiveWorkspaceInstance({ root: "/a", name: "a", hostProfileId: "wsl-1", hostKind: "wsl" });
}

describe("workspace close", () => {
  it("closing a background workspace keeps the active one and persists", async () => {
    await seed();
    const disposeUnder = vi.fn();
    const { facade, host } = makeFacade(disposeUnder);
    const bId = state.workspaceInstanceId("wsl-1", "/b", "wsl");
    const res = await facade.close(bId);
    expect(res).toMatchObject({ wasActive: false, nextActiveId: null });
    expect(host.workspaceRoot).toBe("/a");
    expect(disposeUnder).toHaveBeenCalledWith("/b");
    const persisted = await state.loadWorkspaceInstances();
    expect(persisted.openWorkspaces.map((w) => w.root)).toEqual(["/a"]);
  });

  it("closing the active workspace picks the next one, then empty state", async () => {
    await seed();
    const helper = vi.fn();
    const { facade, host } = makeFacade(vi.fn(), helper);
    const aId = state.workspaceInstanceId("wsl-1", "/a", "wsl");
    const bId = state.workspaceInstanceId("wsl-1", "/b", "wsl");
    const r1 = await facade.close(aId);
    expect(r1).toMatchObject({ wasActive: true, nextActiveId: bId });
    expect(host.workspaceRoot).toBeNull();
    expect(helper).not.toHaveBeenCalled();

    host.workspaceRoot = "/b";
    const r2 = await facade.close(bId);
    expect(r2).toMatchObject({ wasActive: true, nextActiveId: null });
    expect(helper).toHaveBeenCalledTimes(1);
    expect((await state.loadWorkspaceInstances()).openWorkspaces).toEqual([]);
  });

  it("rejects unknown ids", async () => {
    const { facade } = makeFacade();
    await expect(facade.close("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("TerminalService.disposeUnder", () => {
  it("kills only tabs inside the closed root", () => {
    const svc = new TerminalService(() => null, () => ({}) as never);
    const killed: string[] = [];
    const tabs = (svc as unknown as { tabs: Map<string, { info: { cwd: string } }> }).tabs;
    tabs.set("1", { info: { cwd: "/a" } });
    tabs.set("2", { info: { cwd: "/a/sub" } });
    tabs.set("3", { info: { cwd: "/ab" } });
    svc.kill = (id: string) => { killed.push(id); tabs.delete(id); };
    expect(svc.disposeUnder("/a/")).toBe(2);
    expect(killed.sort()).toEqual(["1", "2"]);
  });
});
