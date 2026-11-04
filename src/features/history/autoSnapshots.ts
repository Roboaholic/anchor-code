import type { AgentActivityState, TerminalState } from "@/features/terminal/terminalStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useSnapshotStore } from "./snapshotStore";

type ActivitySlice = Pick<TerminalState, "agentActivity" | "tabs" | "agentProfiles">;

export interface TurnEvent {
  tabId: string;
  phase: "start" | "end";
}

/** Pure: agent turn transitions between two terminal store states. */
export function agentTurnEvents(prev: ActivitySlice, next: ActivitySlice): TurnEvent[] {
  const events: TurnEvent[] = [];
  const ids = new Set([...Object.keys(prev.agentActivity), ...Object.keys(next.agentActivity)]);
  for (const id of ids) {
    const was: AgentActivityState = prev.agentActivity[id] ?? "idle";
    const tab = next.tabs.find((t) => t.id === id);
    const exited = !tab || tab.status === "exited";
    const now: AgentActivityState = exited ? "idle" : (next.agentActivity[id] ?? "idle");
    if (was !== "working" && now === "working") events.push({ tabId: id, phase: "start" });
    else if (was === "working" && now !== "working") events.push({ tabId: id, phase: "end" });
  }
  return events;
}

export function agentLabel(state: ActivitySlice, tabId: string): string {
  const tab = state.tabs.find((t) => t.id === tabId);
  const profile = tab?.agentId ? state.agentProfiles.find((p) => p.id === tab.agentId) : undefined;
  return profile?.name ?? tab?.title ?? "agent";
}

let installed = false;

/** Wire agent turn start/end → auto snapshots, and reload the list per workspace. */
export function installAutoSnapshots(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const snap = useSnapshotStore.getState();
  void snap.loadAuto();
  let workspace = useWorkspaceStore.getState().workspaceRoot;
  const unWs = useWorkspaceStore.subscribe((s) => {
    if (s.workspaceRoot === workspace) return;
    workspace = s.workspaceRoot;
    useSnapshotStore.getState().reset();
    if (workspace) void useSnapshotStore.getState().load();
  });
  let lastWorkspace = workspace;
  const unTerm = useTerminalStore.subscribe((next, prev) => {
    // Terminal views swap on workspace switch; those are not agent turns.
    if (lastWorkspace !== workspace) {
      lastWorkspace = workspace;
      return;
    }
    if (!workspace) return;
    for (const ev of agentTurnEvents(prev, next)) {
      const label = agentLabel(ev.phase === "end" ? prev : next, ev.tabId);
      const store = useSnapshotStore.getState();
      if (ev.phase === "start") void store.agentTurnStarted(ev.tabId, label);
      else void store.agentTurnEnded(ev.tabId, label);
    }
  });
  return () => {
    unWs();
    unTerm();
    installed = false;
  };
}
