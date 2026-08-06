import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTabInfo } from "@/shared/anchor-api";
import {
  resumeWorkspaceAgents,
  saveWorkspaceAgents,
  useTerminalStore,
} from "./terminalStore";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("terminal workspace initialization", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [],
      activeByMode: { terminal: null, agent: null },
      agentActivity: {},
      workspaceCwd: null,
      error: null,
    });
  });

  it("shares concurrent resets for the same workspace", async () => {
    const listed = deferred<TerminalTabInfo[]>();
    const tab: TerminalTabInfo = {
      id: "shell-1",
      title: "workspace",
      cwd: "/workspace",
      status: "running",
      kind: "shell",
    };
    const create = vi.fn(async () => tab);
    vi.stubGlobal("window", {
      anchor: {
        terminal: {
          list: vi.fn(() => listed.promise),
          create,
        },
        agent: {
          listProfiles: vi.fn(async () => []),
          getDefaultId: vi.fn(async () => null),
          detect: vi.fn(async () => []),
        },
      },
    });

    const first = useTerminalStore.getState().resetForWorkspace("/workspace");
    const second = useTerminalStore.getState().resetForWorkspace("/workspace/");
    listed.resolve([]);
    await Promise.all([first, second]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().tabs).toEqual([tab]);
    expect(useTerminalStore.getState().activeByMode.terminal).toBe(tab.id);

    await useTerminalStore.getState().resetForWorkspace("/workspace");
    expect(window.anchor.terminal.list).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
describe("workspace agent persistence", () => {
  it("starts all saved agent resumes concurrently", async () => {
    const storage = new Map<string, string>();
    const first = deferred<TerminalTabInfo>();
    const second = deferred<TerminalTabInfo>();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const rename = vi.fn(async (id: string, title: string) => ({
      id,
      title,
      cwd: "/workspace",
      status: "running" as const,
      kind: "agent" as const,
      agentId: id === "a1" ? "codex" : "omp",
      agentSessionId: id === "a1" ? "codex-session" : "omp-session",
    }));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", {
      anchor: {
        agent: {
          listProfiles: vi.fn(async () => [
            { id: "codex", name: "Codex", command: "codex" },
            { id: "omp", name: "OMP", command: "omp" },
          ]),
          createSession,
        },
        terminal: { rename },
      },
    });
    useTerminalStore.setState({
      tabs: [
        { id: "old-1", title: "Auth", cwd: "/workspace", status: "running", kind: "agent", agentId: "codex", agentSessionId: "codex-session" },
        { id: "old-2", title: "Tests", cwd: "/workspace", status: "running", kind: "agent", agentId: "omp", agentSessionId: "omp-session" },
      ],
    });
    saveWorkspaceAgents("/workspace", "local-default");
    useTerminalStore.setState({ tabs: [] });

    const restoring = resumeWorkspaceAgents("/workspace", "local-default");
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    expect(createSession.mock.calls.map(([input]) => input)).toEqual([
      { profileId: "codex", resume: true, sessionId: "codex-session", cols: 80, rows: 24 },
      { profileId: "omp", resume: true, sessionId: "omp-session", cols: 80, rows: 24 },
    ]);
    first.resolve({ id: "a1", title: "Codex", cwd: "/workspace", status: "running", kind: "agent", agentId: "codex", agentSessionId: "codex-session" });
    second.resolve({ id: "a2", title: "OMP", cwd: "/workspace", status: "running", kind: "agent", agentId: "omp", agentSessionId: "omp-session" });
    await restoring;

    expect(useTerminalStore.getState().tabs.map((tab) => tab.title)).toEqual(["Auth", "Tests"]);
    vi.unstubAllGlobals();
  });
});
