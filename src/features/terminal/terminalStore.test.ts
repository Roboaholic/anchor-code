import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTabInfo } from "@/shared/anchor-api";
import {
  restoreParkedWorkspaceAgents,
  saveWorkspaceAgents,
  useTerminalStore,
} from "./terminalStore";
import { DEFAULT_WORKGROUP_ID } from "./workgroups";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("terminal workspace initialization", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [],
      parkedAgents: [],
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
  it("parks saved agents until a title is clicked", async () => {
    const storage = new Map<string, string>();
    const createSession = vi.fn(async () => ({
      id: "a1",
      title: "Auth",
      cwd: "/workspace",
      status: "running" as const,
      kind: "agent" as const,
      agentId: "codex",
      agentSessionId: "codex-session",
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
          ]),
          createSession,
          setDefaultId: vi.fn(),
        },
        terminal: { rename: vi.fn(async (_id: string, title: string) => ({
          id: "a1",
          title,
          cwd: "/workspace",
          status: "running" as const,
          kind: "agent" as const,
          agentId: "codex",
          agentSessionId: "codex-session",
        })) },
      },
    });
    useTerminalStore.setState({
      workspaceCwd: "/workspace",
      workspaceHostProfileId: "local-default",
      tabWorkgroupById: { "old-1": "default" },
      parkedAgents: [],
      tabs: [
        { id: "old-1", title: "Auth", cwd: "/workspace", status: "running", kind: "agent", agentId: "codex", agentSessionId: "codex-session" },
      ],
    });
    saveWorkspaceAgents("/workspace", "local-default");
    useTerminalStore.setState({ tabs: [], parkedAgents: [] });

    restoreParkedWorkspaceAgents("/workspace", "local-default");
    expect(createSession).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().parkedAgents).toEqual([
      { profileId: "codex", sessionId: "codex-session", title: "Auth", groupId: "default" },
    ]);

    await useTerminalStore.getState().resumeParkedAgent("codex-session");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "codex",
      resume: true,
      sessionId: "codex-session",
    }));
    expect(useTerminalStore.getState().parkedAgents).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("does not resume parked agents while resetting a workspace", async () => {
    const storage = new Map<string, string>([
      [
        "anchor.workspace.agents.v1",
        JSON.stringify({
          "local-default::/workspace": [
            {
              profileId: "codex",
              sessionId: "codex-session",
              title: "Auth",
              groupId: "default",
            },
          ],
        }),
      ],
    ]);
    const createSession = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", {
      anchor: {
        terminal: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({
            id: "shell-1",
            title: "workspace",
            cwd: "/workspace",
            status: "running" as const,
            kind: "shell" as const,
          })),
        },
        agent: {
          listProfiles: vi.fn(async () => []),
          getDefaultId: vi.fn(async () => null),
          detect: vi.fn(async () => []),
          createSession,
        },
      },
    });
    useTerminalStore.setState({
      workspaceCwd: "/other",
      parkedAgents: [
        {
          profileId: "omp",
          sessionId: "other-session",
          title: "Other",
          groupId: "default",
        },
      ],
      tabs: [],
    });

    await useTerminalStore.getState().resetForWorkspace("/workspace", "local-default");

    expect(createSession).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().parkedAgents).toEqual([
      {
        profileId: "codex",
        sessionId: "codex-session",
        title: "Auth",
        groupId: "default",
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("moves parked conversations to Default when a workgroup is deleted", () => {
    useTerminalStore.setState({
      workspaceCwd: "/workspace",
      workgroups: [
        { id: DEFAULT_WORKGROUP_ID, name: "Default", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: "wg-1",
      parkedAgents: [
        {
          profileId: "codex",
          sessionId: "parked-1",
          title: "Auth",
          groupId: "wg-1",
        },
      ],
      tabs: [],
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });

    useTerminalStore.getState().deleteWorkgroup("wg-1");

    expect(useTerminalStore.getState().parkedAgents).toEqual([
      {
        profileId: "codex",
        sessionId: "parked-1",
        title: "Auth",
        groupId: DEFAULT_WORKGROUP_ID,
      },
    ]);
    vi.unstubAllGlobals();
  });
});

describe("createAgentTab resume", () => {
  it("passes the selected session id to the agent launcher", async () => {
    const createSession = vi.fn(async () => ({
      id: "resumed",
      title: "Previous task",
      cwd: "/workspace",
      status: "running" as const,
      kind: "agent" as const,
      agentId: "omp",
      agentSessionId: "session-123",
    }));
    vi.stubGlobal("window", {
      anchor: {
        agent: { createSession, setDefaultId: vi.fn() },
      },
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });
    useTerminalStore.setState({ tabs: [], agentMenuOpen: true });

    const created = await useTerminalStore.getState().createAgentTab(
      { id: "omp", name: "OMP", command: "omp" },
      { title: "Previous task", resumeSessionId: "session-123" },
    );

    expect(created).toBe(true);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "omp",
      resume: true,
      sessionId: "session-123",
      prompt: "Previous task",
    }));
    expect(useTerminalStore.getState().tabWorkgroupById.resumed).toBe(
      DEFAULT_WORKGROUP_ID,
    );
  });

  it("focuses a live session instead of launching a second PTY", async () => {
    const createSession = vi.fn();
    vi.stubGlobal("window", {
      anchor: { agent: { createSession, setDefaultId: vi.fn() } },
    });
    useTerminalStore.setState({
      tabs: [
        {
          id: "live",
          title: "Auth",
          cwd: "/workspace",
          status: "running",
          kind: "agent",
          agentId: "omp",
          agentSessionId: "session-123",
        },
      ],
      tabWorkgroupById: { live: "wg-1" },
      workgroups: [
        { id: DEFAULT_WORKGROUP_ID, name: "Default", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: DEFAULT_WORKGROUP_ID,
      activeByMode: { terminal: null, agent: null },
      agentMenuOpen: true,
    });

    const created = await useTerminalStore.getState().createAgentTab(
      { id: "omp", name: "OMP", command: "omp" },
      { resumeSessionId: "session-123" },
    );

    expect(created).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().activeByMode.agent).toBe("live");
    expect(useTerminalStore.getState().activeGroupId).toBe("wg-1");
    vi.unstubAllGlobals();
  });

  it("assigns new conversations to the active workgroup", async () => {
    const createSession = vi.fn(async () => ({
      id: "new-1",
      title: "New task",
      cwd: "/workspace",
      status: "running" as const,
      kind: "agent" as const,
      agentId: "omp",
      agentSessionId: "sess-new",
    }));
    vi.stubGlobal("window", {
      anchor: { agent: { createSession, setDefaultId: vi.fn() } },
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });
    useTerminalStore.setState({
      tabs: [],
      workspaceCwd: "/workspace",
      workgroups: [
        { id: DEFAULT_WORKGROUP_ID, name: "Default", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: "wg-1",
      tabWorkgroupById: {},
      sessionGroupById: {},
    });

    await useTerminalStore.getState().createAgentTab(
      { id: "omp", name: "OMP", command: "omp" },
      { title: "New task" },
    );

    expect(useTerminalStore.getState().tabWorkgroupById["new-1"]).toBe("wg-1");
    expect(useTerminalStore.getState().sessionGroupById["sess-new"]).toBe("wg-1");
    vi.unstubAllGlobals();
  });

  it("selects a conversation from the workgroup being focused", () => {
    useTerminalStore.setState({
      workspaceCwd: "/workspace",
      workgroups: [
        { id: DEFAULT_WORKGROUP_ID, name: "Default", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: DEFAULT_WORKGROUP_ID,
      tabWorkgroupById: { a: DEFAULT_WORKGROUP_ID, b: "wg-1" },
      activeByMode: { terminal: null, agent: "a" },
      tabs: [
        {
          id: "a",
          title: "Default task",
          cwd: "/workspace",
          status: "running",
          kind: "agent",
          agentId: "omp",
          agentSessionId: "sess-a",
        },
        {
          id: "b",
          title: "Login task",
          cwd: "/workspace",
          status: "running",
          kind: "agent",
          agentId: "omp",
          agentSessionId: "sess-b",
        },
      ],
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });

    useTerminalStore.getState().setActiveWorkgroup("wg-1");

    expect(useTerminalStore.getState().activeGroupId).toBe("wg-1");
    expect(useTerminalStore.getState().activeByMode.agent).toBe("b");
    vi.unstubAllGlobals();
  });

  it("moves live conversations to Default when a workgroup is deleted", () => {
    useTerminalStore.setState({
      workspaceCwd: "/workspace",
      workgroups: [
        { id: DEFAULT_WORKGROUP_ID, name: "Default", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: "wg-1",
      tabWorkgroupById: { live: "wg-1" },
      sessionGroupById: { "sess-1": "wg-1" },
      tabs: [
        {
          id: "live",
          title: "Auth",
          cwd: "/workspace",
          status: "running",
          kind: "agent",
          agentId: "omp",
          agentSessionId: "sess-1",
        },
      ],
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });

    useTerminalStore.getState().deleteWorkgroup("wg-1");

    expect(useTerminalStore.getState().workgroups.map((group) => group.id)).toEqual([
      DEFAULT_WORKGROUP_ID,
    ]);
    expect(useTerminalStore.getState().activeGroupId).toBe(DEFAULT_WORKGROUP_ID);
    expect(useTerminalStore.getState().tabWorkgroupById.live).toBe(DEFAULT_WORKGROUP_ID);
    expect(useTerminalStore.getState().sessionGroupById["sess-1"]).toBe(
      DEFAULT_WORKGROUP_ID,
    );
    vi.unstubAllGlobals();
  });
});

describe("terminal error isolation", () => {
  it("keeps live terminal tabs when agent creation fails", async () => {
    const shell: TerminalTabInfo = {
      id: "shell-live",
      title: "workspace",
      cwd: "/workspace",
      status: "running",
      kind: "shell",
    };
    vi.stubGlobal("window", {
      anchor: {
        agent: {
          createSession: vi.fn(async () => {
            throw new Error("agent preflight failed");
          }),
        },
      },
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
    });
    useTerminalStore.setState({
      tabs: [shell],
      activeByMode: { terminal: shell.id, agent: null },
      error: null,
      agentMenuOpen: true,
    });

    const created = await useTerminalStore.getState().createAgentTab({
      id: "omp",
      name: "OMP",
      command: "omp",
    });

    expect(created).toBe(false);
    expect(useTerminalStore.getState().tabs).toEqual([shell]);
    expect(useTerminalStore.getState().activeByMode.terminal).toBe(shell.id);
    expect(useTerminalStore.getState().error).toBe("agent preflight failed");
    vi.unstubAllGlobals();
  });
});
