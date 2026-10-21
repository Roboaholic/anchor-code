// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliProfile, AgentSessionSummary } from "@/shared/anchor-api";
import { AgentSidebar } from "./AgentSidebar";
import { useTerminalStore } from "./terminalStore";

const profiles = (): AgentCliProfile[] => [
  { id: "codex", name: "Codex", command: "codex", args: [], enabled: true, detected: true },
  { id: "omp", name: "OMP", command: "omp", args: [], enabled: true, detected: true },
] as AgentCliProfile[];

const initial = useTerminalStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("AgentSidebar history", () => {
  let listSessions: ReturnType<typeof vi.fn>;
  let loadingRenders: number;

  beforeEach(() => {
    localStorage.setItem("anchor.agent.historyOpen", "1");
    listSessions = vi.fn(async ({ profileId }: { profileId: string }): Promise<AgentSessionSummary[]> => [
      { id: `${profileId}-1`, title: `${profileId} session`, updatedAt: "2026-10-21T07:00:00.000Z" },
    ]);
    // Every call returns a fresh array, like the real IPC does.
    (window as unknown as { anchor: unknown }).anchor = {
      agent: {
        listProfiles: vi.fn(async () => profiles()),
        getDefaultId: vi.fn(async () => "codex"),
        detect: vi.fn(async () => profiles()),
        listSessions,
      },
    };
    useTerminalStore.setState({
      ...initial,
      workspaceCwd: "/repo",
      workspaceHostProfileId: "local",
      agentProfiles: [],
    }, true);
    loadingRenders = 0;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      if (screen.queryByText("Loading…")) loadingRenders += 1;
    }
  }

  it("fetches history once when a workspace opens (profiles load + detect)", async () => {
    render(<StrictMode><AgentSidebar /></StrictMode>);
    // openWorkspace kicks off loadAgentProfiles() and detectAgents() too.
    await act(async () => {
      void useTerminalStore.getState().loadAgentProfiles();
      void useTerminalStore.getState().detectAgents();
    });
    await settle();
    // One listSessions per enabled profile, one round only.
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(screen.getByText("codex session")).toBeTruthy();
    expect(screen.getByText("omp session")).toBeTruthy();
  });

  it("does not refetch or flash Loading… when profile loads land one by one", async () => {
    const detect = deferred<AgentCliProfile[]>();
    (window as unknown as { anchor: { agent: { detect: unknown } } }).anchor.agent.detect =
      vi.fn(() => detect.promise);
    render(<StrictMode><AgentSidebar /></StrictMode>);
    // Workspace open: loadAgentProfiles() resolves quickly, detectAgents() later.
    await act(async () => {
      void useTerminalStore.getState().loadAgentProfiles();
      void useTerminalStore.getState().detectAgents();
    });
    await settle();
    expect(screen.getByText("codex session")).toBeTruthy();
    const loadingBefore = loadingRenders;
    await act(async () => { detect.resolve(profiles()); });
    await settle();
    await act(async () => { await useTerminalStore.getState().loadAgentProfiles(); });
    await settle();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(loadingRenders).toBe(loadingBefore);
    expect(screen.getByText("codex session")).toBeTruthy();
  });

  it("keeps the current list on refresh instead of flashing Loading…", async () => {
    render(<StrictMode><AgentSidebar /></StrictMode>);
    await settle();
    expect(screen.getByText("codex session")).toBeTruthy();
    const pending = deferred<AgentSessionSummary[]>();
    listSessions.mockImplementation(() => pending.promise);
    // Profiles changed for real (OMP disabled) → refetch.
    await act(async () => {
      useTerminalStore.setState({
        agentProfiles: profiles().map((p) => (p.id === "omp" ? { ...p, enabled: false } : p)),
      });
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("codex session")).toBeTruthy();
    await act(async () => {
      pending.resolve([{ id: "codex-2", title: "fresh", updatedAt: "2026-10-21T08:00:00.000Z" }]);
    });
    await settle();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("refetches when the workspace changes", async () => {
    render(<StrictMode><AgentSidebar /></StrictMode>);
    await settle();
    const before = listSessions.mock.calls.length;
    await act(async () => { useTerminalStore.setState({ workspaceCwd: "/other" }); });
    await settle();
    expect(listSessions.mock.calls.length).toBe(before + 2);
  });
});
