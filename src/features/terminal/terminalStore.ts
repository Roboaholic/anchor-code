import { create } from "zustand";
import type {
  AgentCliProfile,
  TerminalSessionKind,
  TerminalTabInfo,
} from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import {
  disposeXtermSession,
} from "./xtermSessionPool";
import {
  DEFAULT_WORKGROUP_ID,
  emptyWorkgroupsState,
  nextWorkgroupId,
  parseWorkgroupsState,
  reassignGroupIds,
  removeWorkgroup,
  renameWorkgroupInState,
  uniqueWorkgroupName,
  WORKSPACE_WORKGROUPS_KEY,
  type AgentWorkgroup,
  type WorkgroupsState,
} from "./workgroups";

export type RightTermMode = "terminal" | "agent";
export type AgentActivityState = "idle" | "working" | "completed-unread";

export function nextAgentActivity(
  current: AgentActivityState,
  event: "started" | "completed" | "viewed",
): AgentActivityState {
  if (event === "started") return "working";
  if (event === "completed") return current === "working" ? "completed-unread" : current;
  return current === "completed-unread" ? "idle" : current;
}

export function completeAgentActivity(
  current: AgentActivityState,
  viewed: boolean,
): AgentActivityState {
  const completed = nextAgentActivity(current, "completed");
  return viewed ? nextAgentActivity(completed, "viewed") : completed;
}

const agentCompletionTimers = new Map<string, number>();
const workspaceResetPromises = new Map<string, Promise<void>>();

function normalizedCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "");
}

function clearAgentCompletionTimer(id: string) {
  const timer = agentCompletionTimers.get(id);
  if (timer != null) window.clearTimeout(timer);
  agentCompletionTimers.delete(id);
}


const SESSION_LIST_KEY = "anchor.terminal.sessionListOpenByMode";
/** Legacy single-flag key (migrated once). */
const SESSION_LIST_KEY_LEGACY = "anchor.terminal.sessionListOpen";

const WORKSPACE_AGENTS_KEY = "anchor.workspace.agents.v1";

type PersistedAgent = {
  profileId: string;
  /** Empty when the CLI session id was never captured (not resumable). */
  sessionId: string;
  title: string;
  groupId?: string;
  /** Epoch ms of last focus / launch; newest first on restore. */
  lastActiveAt?: number;
  resumable?: boolean;
  /** User/caller-set title (e.g. "Ask · file L3"): re-pinned on resume. */
  titlePinned?: boolean;
  /** Ask / plan-mode sessions must resume with read-only CLI flags. */
  readOnly?: boolean;
};

export type ParkedAgent = {
  profileId: string;
  /** Provider session id; `unresumable:<key>` placeholder when not resumable. */
  sessionId: string;
  title: string;
  groupId: string;
  lastActiveAt?: number;
  titlePinned?: boolean;
  /** False → listed greyed, can't be resumed. */
  resumable?: boolean;
  /** Last resume failure (shown in the sidebar). */
  error?: string;
  /** Ask / plan-mode sessions must resume with read-only CLI flags. */
  readOnly?: boolean;
};

const UNRESUMABLE_PREFIX = "unresumable:";
/** A resumed CLI that exits this fast most likely failed to resume. */
export const RESUME_FAIL_WINDOW_MS = 5_000;
const agentLastActiveAt = new Map<string, number>();
const resumingSessions = new Set<string>();
const resumeWatch = new Map<string, { parked: ParkedAgent; at: number }>();
const agentReadOnlyByTabId = new Map<string, boolean>();

export function isAgentTabReadOnly(tabId: string): boolean {
  return agentReadOnlyByTabId.get(tabId) === true;
}

export function markAgentActive(tabId: string, at = Date.now()): void {
  agentLastActiveAt.set(tabId, at);
}

function byRecency<T extends { lastActiveAt?: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.lastActiveAt ?? 0) - (a.item.lastActiveAt ?? 0) || a.index - b.index)
    .map(({ item }) => item);
}
type TerminalWorkspaceView = {
  tabs: TerminalTabInfo[];
  activeByMode: Record<RightTermMode, string | null>;
  agentActivity: Record<string, AgentActivityState>;
  mode: RightTermMode;
  sessionListOpenByMode: Record<RightTermMode, boolean>;
  workgroups: AgentWorkgroup[];
  activeGroupId: string;
  tabWorkgroupById: Record<string, string>;
  sessionGroupById: Record<string, string>;
  parkedAgents: ParkedAgent[];
  exitCodeById: Record<string, number>;
  workspaceHostProfileId: string | null;
};
const terminalWorkspaceViews = new Map<string, TerminalWorkspaceView>();

function workspaceAgentKey(cwd: string, hostProfileId: string | null): string {
  return `${hostProfileId ?? "local-default"}::${normalizedCwd(cwd)}`;
}

function readPersistedAgents(): Record<string, PersistedAgent[]> {
  try {
    const raw = localStorage.getItem(WORKSPACE_AGENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, PersistedAgent[]>)
      : {};
  } catch {
    return {};
  }
}

function readPersistedWorkgroups(): Record<string, WorkgroupsState> {
  try {
    const raw = localStorage.getItem(WORKSPACE_WORKGROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        parseWorkgroupsState(value),
      ]),
    );
  } catch {
    return {};
  }
}

function persistWorkgroupsState(
  cwd: string | null,
  hostProfileId: string | null,
  state: WorkgroupsState,
): void {
  if (!cwd) return;
  try {
    const saved = readPersistedWorkgroups();
    saved[workspaceAgentKey(cwd, hostProfileId)] = state;
    localStorage.setItem(WORKSPACE_WORKGROUPS_KEY, JSON.stringify(saved));
  } catch {
    // Persistence must not interrupt workspace switching.
  }
}

function loadWorkgroupsState(
  cwd: string,
  hostProfileId: string | null,
): WorkgroupsState {
  return (
    readPersistedWorkgroups()[workspaceAgentKey(cwd, hostProfileId)] ??
    emptyWorkgroupsState()
  );
}

function workgroupsSnapshot(state: {
  workgroups: AgentWorkgroup[];
  activeGroupId: string;
  sessionGroupById: Record<string, string>;
  tabWorkgroupById: Record<string, string>;
  tabs: TerminalTabInfo[];
  parkedAgents?: ParkedAgent[];
}): WorkgroupsState {
  const sessionGroupById = { ...state.sessionGroupById };
  for (const tab of state.tabs) {
    if ((tab.kind ?? "shell") !== "agent") continue;
    const groupId = state.tabWorkgroupById[tab.id] ?? DEFAULT_WORKGROUP_ID;
    if (tab.agentSessionId) sessionGroupById[tab.agentSessionId] = groupId;
  }
  for (const parked of state.parkedAgents ?? []) {
    sessionGroupById[parked.sessionId] = parked.groupId;
  }
  return parseWorkgroupsState({
    groups: state.workgroups,
    activeGroupId: state.activeGroupId,
    sessionGroupById,
  });
}

function parkedFromPersisted(
  agents: PersistedAgent[] | undefined,
  workgroups: WorkgroupsState,
  liveSessionIds: Set<string>,
): ParkedAgent[] {
  if (!Array.isArray(agents)) return [];
  const groupIds = new Set(workgroups.groups.map((group) => group.id));
  return byRecency(agents.flatMap((saved, index): ParkedAgent[] => {
    if (!saved || typeof saved.profileId !== "string") return [];
    const resumable = saved.resumable !== false && Boolean(saved.sessionId?.trim());
    if (resumable && liveSessionIds.has(saved.sessionId)) return [];
    const sessionId = resumable
      ? saved.sessionId
      : saved.sessionId?.startsWith(UNRESUMABLE_PREFIX)
        ? saved.sessionId
        : `${UNRESUMABLE_PREFIX}${index}:${saved.title}`;
    const mapped = saved.groupId ?? workgroups.sessionGroupById[saved.sessionId];
    return [{
      profileId: saved.profileId,
      sessionId,
      title: saved.title,
      groupId: mapped && groupIds.has(mapped) ? mapped : DEFAULT_WORKGROUP_ID,
      ...(saved.lastActiveAt ? { lastActiveAt: saved.lastActiveAt } : {}),
      ...(saved.titlePinned ? { titlePinned: true } : {}),
      ...(resumable ? {} : { resumable: false }),
      ...(saved.readOnly ? { readOnly: true } : {}),
    }];
  }));
}

function persistCurrentWorkgroups(hostProfileId?: string | null): void {
  const state = useTerminalStore.getState();
  if (!state.workspaceCwd) return;
  persistWorkgroupsState(
    state.workspaceCwd,
    hostProfileId ?? state.workspaceHostProfileId,
    workgroupsSnapshot(state),
  );
}

function assignTabsToWorkgroups(
  tabs: TerminalTabInfo[],
  workgroups: WorkgroupsState,
  tabWorkgroupById: Record<string, string>,
): {
  tabWorkgroupById: Record<string, string>;
  sessionGroupById: Record<string, string>;
} {
  const groupIds = new Set(workgroups.groups.map((group) => group.id));
  const fallback = (id: string | undefined) =>
    id && groupIds.has(id) ? id : DEFAULT_WORKGROUP_ID;
  const nextTabs = { ...tabWorkgroupById };
  const nextSessions = { ...workgroups.sessionGroupById };
  for (const tab of tabs) {
    if ((tab.kind ?? "shell") !== "agent") continue;
    const groupId = fallback(
      nextTabs[tab.id] ??
        (tab.agentSessionId ? nextSessions[tab.agentSessionId] : undefined),
    );
    nextTabs[tab.id] = groupId;
    if (tab.agentSessionId) nextSessions[tab.agentSessionId] = groupId;
  }
  return { tabWorkgroupById: nextTabs, sessionGroupById: nextSessions };
}

function applyWorkgroupToTab(
  state: Pick<
    TerminalState,
    "tabWorkgroupById" | "sessionGroupById" | "workgroups"
  >,
  tab: TerminalTabInfo,
  groupId: string,
  profileId?: string,
): Pick<
  TerminalState,
  "tabWorkgroupById" | "sessionGroupById" | "workgroups"
> {
  const resolved =
    state.workgroups.some((group) => group.id === groupId)
      ? groupId
      : DEFAULT_WORKGROUP_ID;
  return {
    tabWorkgroupById: { ...state.tabWorkgroupById, [tab.id]: resolved },
    sessionGroupById: tab.agentSessionId
      ? { ...state.sessionGroupById, [tab.agentSessionId]: resolved }
      : state.sessionGroupById,
    workgroups: profileId
      ? state.workgroups.map((group) =>
          group.id === resolved ? { ...group, lastProfileId: profileId } : group,
        )
      : state.workgroups,
  };
}

export function captureWorkspaceTerminalView(
  cwd: string,
  hostProfileId: string | null,
): void {
  const key = workspaceAgentKey(cwd, hostProfileId);
  const state = useTerminalStore.getState();
  const tabs = state.tabs.filter((tab) => normalizedCwd(tab.cwd) === normalizedCwd(cwd));
  persistWorkgroupsState(cwd, hostProfileId, workgroupsSnapshot(state));
  terminalWorkspaceViews.set(key, {
    tabs,
    activeByMode: {
      terminal: state.activeByMode.terminal && tabs.some((tab) => tab.id === state.activeByMode.terminal)
        ? state.activeByMode.terminal
        : pickActive(tabs, "terminal", null),
      agent: state.activeByMode.agent && tabs.some((tab) => tab.id === state.activeByMode.agent)
        ? state.activeByMode.agent
        : pickActive(tabs, "agent", null),
    },
    agentActivity: Object.fromEntries(
      Object.entries(state.agentActivity).filter(([id]) => tabs.some((tab) => tab.id === id)),
    ),
    mode: state.mode,
    sessionListOpenByMode: state.sessionListOpenByMode,
    workgroups: state.workgroups,
    activeGroupId: state.activeGroupId,
    tabWorkgroupById: Object.fromEntries(
      Object.entries(state.tabWorkgroupById).filter(([id]) =>
        tabs.some((tab) => tab.id === id),
      ),
    ),
    sessionGroupById: state.sessionGroupById,
    parkedAgents: state.parkedAgents,
    exitCodeById: Object.fromEntries(
      Object.entries(state.exitCodeById).filter(([id]) =>
        tabs.some((tab) => tab.id === id),
      ),
    ),
    workspaceHostProfileId: hostProfileId,
  });
}

export function restoreWorkspaceTerminalView(
  cwd: string,
  hostProfileId: string | null,
): boolean {
  const view = terminalWorkspaceViews.get(workspaceAgentKey(cwd, hostProfileId));
  if (!view) return false;
  setTerminalWorkspaceView(view, cwd);
  return true;
}

function setTerminalWorkspaceView(view: TerminalWorkspaceView, cwd: string): void {
  const workgroups = parseWorkgroupsState({
    groups: view.workgroups,
    activeGroupId: view.activeGroupId,
    sessionGroupById: view.sessionGroupById,
  });
  const assigned = assignTabsToWorkgroups(
    view.tabs,
    workgroups,
    view.tabWorkgroupById,
  );
  useTerminalStore.setState({
    workspaceCwd: cwd,
    workspaceHostProfileId: view.workspaceHostProfileId,
    tabs: view.tabs,
    activeByMode: view.activeByMode,
    agentActivity: view.agentActivity,
    mode: view.mode,
    sessionListOpenByMode: view.sessionListOpenByMode,
    workgroups: workgroups.groups,
    activeGroupId: workgroups.activeGroupId,
    tabWorkgroupById: assigned.tabWorkgroupById,
    sessionGroupById: assigned.sessionGroupById,
    parkedAgents: view.parkedAgents ?? [],
    exitCodeById: view.exitCodeById ?? {},
    agentMenuOpen: false,
    error: null,
  });
}

export function saveWorkspaceAgents(
  cwd: string,
  hostProfileId: string | null,
): void {
  try {
    captureWorkspaceTerminalView(cwd, hostProfileId);
    persistCurrentWorkgroups(hostProfileId);
    const saved = readPersistedAgents();
    const state = useTerminalStore.getState();
    const now = Date.now();
    const live: PersistedAgent[] = state.tabs
      .filter(
        (tab): tab is TerminalTabInfo & { agentId: string } =>
          tab.kind === "agent" &&
          tab.status === "running" &&
          typeof tab.agentId === "string",
      )
      .map((tab) => {
        const sessionId = tab.agentSessionId?.trim() ?? "";
        return {
          profileId: tab.agentId,
          // No captured id: keep it listed (greyed) instead of silently dropping.
          sessionId: sessionId || `${UNRESUMABLE_PREFIX}${tab.id}`,
          title: tab.title,
          groupId: state.tabWorkgroupById[tab.id] ?? DEFAULT_WORKGROUP_ID,
          lastActiveAt:
            agentLastActiveAt.get(tab.id) ??
            (state.activeByMode.agent === tab.id ? now : undefined),
          ...(sessionId ? {} : { resumable: false }),
          ...(tab.titleSource === "user" ? { titlePinned: true } : {}),
          ...(agentReadOnlyByTabId.get(tab.id) ? { readOnly: true } : {}),
        };
      });
    const bySession = new Map<string, PersistedAgent>();
    for (const item of state.parkedAgents) {
      bySession.set(item.sessionId, {
        profileId: item.profileId,
        sessionId: item.sessionId,
        title: item.title,
        groupId: item.groupId,
        lastActiveAt: item.lastActiveAt,
        ...(item.resumable === false ? { resumable: false } : {}),
        ...(item.titlePinned ? { titlePinned: true } : {}),
        ...(item.readOnly ? { readOnly: true } : {}),
      });
    }
    for (const item of live) bySession.set(item.sessionId, item);
    saved[workspaceAgentKey(cwd, hostProfileId)] = byRecency([...bySession.values()]);
    localStorage.setItem(WORKSPACE_AGENTS_KEY, JSON.stringify(saved));
  } catch {
    // Persistence must not interrupt workspace switching.
  }
}

export function restoreParkedWorkspaceAgents(
  cwd: string,
  hostProfileId: string | null,
): void {
  const workgroups = loadWorkgroupsState(cwd, hostProfileId);
  const liveSessionIds = new Set(
    useTerminalStore
      .getState()
      .tabs.filter(
        (tab) =>
          tab.kind === "agent" &&
          typeof tab.agentSessionId === "string" &&
          tab.agentSessionId.trim().length > 0,
      )
      .map((tab) => tab.agentSessionId!),
  );
  useTerminalStore.setState((state) => ({
    parkedAgents: parkedFromPersisted(
      readPersistedAgents()[workspaceAgentKey(cwd, hostProfileId)],
      {
        groups: state.workgroups.length > 0 ? state.workgroups : workgroups.groups,
        activeGroupId: state.activeGroupId,
        sessionGroupById: {
          ...workgroups.sessionGroupById,
          ...state.sessionGroupById,
        },
      },
      liveSessionIds,
    ),
  }));
}

export async function resumeParkedAgent(sessionId: string): Promise<boolean> {
  const parked = useTerminalStore
    .getState()
    .parkedAgents.find((item) => item.sessionId === sessionId);
  if (!parked) return false;
  if (parked.resumable === false) {
    useTerminalStore.setState({
      error: "This conversation can't be resumed: its CLI session id was never captured.",
    });
    return false;
  }
  if (resumingSessions.has(sessionId)) return false;
  const live = useTerminalStore.getState().tabs.find(
    (tab) =>
      (tab.kind ?? "shell") === "agent" && tab.agentSessionId === sessionId,
  );
  if (live) {
    useTerminalStore.getState().focusAgentTab(live.id);
    useTerminalStore.setState((state) => ({
      parkedAgents: state.parkedAgents.filter((item) => item.sessionId !== sessionId),
    }));
    return true;
  }
  resumingSessions.add(sessionId);
  try {
    const profiles = await window.anchor.agent.listProfiles();
    const profile = profiles.find((item) => item.id === parked.profileId);
    if (!profile || profile.enabled === false) {
      setParkedError(sessionId, `Agent profile unavailable: ${parked.profileId}`);
      return false;
    }
    useTerminalStore.getState().setActiveWorkgroup(parked.groupId);
    const ok = await useTerminalStore.getState().createAgentTab(profile, {
      title: parked.title,
      resumeSessionId: parked.sessionId,
      readOnly: parked.readOnly,
    });
    if (!ok) {
      // createAgentTab keeps the parked entry on failure; record why.
      setParkedError(sessionId, useTerminalStore.getState().error ?? "Resume failed");
      return false;
    }
    const tab = useTerminalStore
      .getState()
      .tabs.find((item) => item.agentSessionId === sessionId);
    if (tab) {
      markAgentActive(tab.id);
      resumeWatch.set(tab.id, { parked, at: Date.now() });
      // Keep short caller titles (Ask / Feedback / renamed) over CLI-inferred ones.
      if (parked.titlePinned && tab.titleSource !== "user") {
        void useTerminalStore.getState().renameTab(tab.id, parked.title);
      }
    }
    return true;
  } finally {
    resumingSessions.delete(sessionId);
  }
}

function setParkedError(sessionId: string, error: string): void {
  useTerminalStore.setState((state) => ({
    error,
    parkedAgents: state.parkedAgents.map((item) =>
      item.sessionId === sessionId ? { ...item, error } : item,
    ),
  }));
}

/** Pick the most recent resumable parked conversation (current group first). */
export function mostRecentParkedAgent(
  parked: ParkedAgent[],
  activeGroupId: string,
): ParkedAgent | null {
  const candidates = byRecency(parked.filter((item) => item.resumable !== false));
  return (
    candidates.find((item) => item.groupId === activeGroupId) ??
    candidates[0] ??
    null
  );
}

/** Top-bar agent button with no live agents: lazily resume just one. */
export async function resumeMostRecentParkedAgent(): Promise<boolean> {
  const state = useTerminalStore.getState();
  const target = mostRecentParkedAgent(state.parkedAgents, state.activeGroupId);
  if (!target) return false;
  return resumeParkedAgent(target.sessionId);
}
function readSessionListOpenByMode(): Record<RightTermMode, boolean> {
  try {
    const raw = localStorage.getItem(SESSION_LIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<RightTermMode, boolean>>;
      return {
        terminal: parsed.terminal === true,
        agent: parsed.agent === true,
      };
    }
    // Migrate old shared flag → both modes get the same value once.
    const legacy = localStorage.getItem(SESSION_LIST_KEY_LEGACY);
    if (legacy === "1" || legacy === "0") {
      const open = legacy === "1";
      return { terminal: open, agent: open };
    }
  } catch {
    // ignore
  }
  return { terminal: false, agent: false };
}

function writeSessionListOpenByMode(state: Record<RightTermMode, boolean>) {
  try {
    localStorage.setItem(SESSION_LIST_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/** Why the New Agent dialog is open — plain create vs Comments Feedback. */
export type AgentMenuIntent =
  | { kind: "new" }
  | {
      kind: "feedback";
      sessionId: string;
      sessionTitle: string;
      yamlPath: string;
      exportPath?: string | null;
      openCount: number;
      needModifyCount: number;
    };

export type AgentLaunchOptions = {
  model?: string;
  effort?: string;
  /** Tab title (and default prompt when `prompt` omitted). */
  title?: string;
  /** Hidden CLI first-message; preferred over title for agent launch args. */
  prompt?: string;
  /** Ask: launch with read-only / plan CLI flags when supported. */
  readOnly?: boolean;
  resumeSessionId?: string;
};

export interface TerminalState {
  tabs: TerminalTabInfo[];
  /** Active tab per mode so switching modes keeps both sides alive. */
  activeByMode: Record<RightTermMode, string | null>;
  agentActivity: Record<string, AgentActivityState>;
  mode: RightTermMode;
  /** Session rail open state — independent for Terminal vs Agent. */
  sessionListOpenByMode: Record<RightTermMode, boolean>;
  error: string | null;
  workspaceCwd: string | null;
  workspaceHostProfileId: string | null;
  workgroups: AgentWorkgroup[];
  activeGroupId: string;
  /** Live PTY tab id → workgroup. */
  tabWorkgroupById: Record<string, string>;
  /** CLI session id → workgroup, kept after the tab closes. */
  sessionGroupById: Record<string, string>;
  /** Saved conversations shown in the workgroup list until clicked. */
  parkedAgents: ParkedAgent[];
  /** Exit code for tabs that have ended (banner). */
  exitCodeById: Record<string, number>;
  agentProfiles: AgentCliProfile[];
  defaultAgentId: string | null;
  agentMenuOpen: boolean;
  agentMenuIntent: AgentMenuIntent;

  resetForWorkspace: (cwd: string, hostProfileId?: string | null) => Promise<void>;
  setMode: (mode: RightTermMode) => void;
  toggleSessionList: (mode: RightTermMode) => void;
  setSessionListOpen: (mode: RightTermMode, open: boolean) => void;
  createShellTab: () => Promise<void>;
  createAgentTab: (
    profile: AgentCliProfile,
    launch?: AgentLaunchOptions,
  ) => Promise<boolean>;
  createAgentDefault: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  noteSessionExit: (id: string, exitCode: number) => void;
  /** Drop tab after process exit without kill (already dead). */
  removeTabLocal: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => Promise<void>;
  applyTitleFromTerm: (id: string, title: string) => void;
  applyAgentTopicFromLine: (id: string, line: string) => void;
  markAgentWorking: (id: string) => void;
  noteAgentOutput: (id: string) => void;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  loadAgentProfiles: () => Promise<void>;
  detectAgents: () => Promise<void>;
  setAgentMenuOpen: (open: boolean) => void;
  /** Open New Agent dialog, optionally as Comments → Feedback. */
  openAgentMenu: (intent?: AgentMenuIntent) => void;
  /** Dismiss New Agent dialog; return to Terminal when no agent sessions. */
  closeAgentMenu: () => void;
  addCustomAgent: (input: {
    name: string;
    command: string;
    args?: string[];
  }) => Promise<AgentCliProfile | null>;
  setActiveWorkgroup: (id: string) => void;
  createWorkgroup: (name?: string) => string;
  renameWorkgroup: (id: string, name: string) => void;
  deleteWorkgroup: (id: string) => void;
  focusAgentTab: (id: string) => void;
  resumeParkedAgent: (sessionId: string) => Promise<boolean>;
}

function modeOf(tab: TerminalTabInfo): RightTermMode {
  return tab.kind === "agent" ? "agent" : "terminal";
}

function pickActive(
  tabs: TerminalTabInfo[],
  mode: RightTermMode,
  preferred: string | null,
): string | null {
  const inMode = tabs.filter((t) => modeOf(t) === mode);
  if (preferred && inMode.some((t) => t.id === preferred)) return preferred;
  return inMode[inMode.length - 1]?.id ?? null;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeByMode: { terminal: null, agent: null },
  agentActivity: {},
  mode: "agent",
  sessionListOpenByMode: readSessionListOpenByMode(),
  error: null,
  workspaceCwd: null,
  workspaceHostProfileId: null,
  workgroups: emptyWorkgroupsState().groups,
  activeGroupId: DEFAULT_WORKGROUP_ID,
  tabWorkgroupById: {},
  sessionGroupById: {},
  parkedAgents: [],
  exitCodeById: {},
  agentProfiles: [],
  defaultAgentId: null,
  agentMenuOpen: false,
  agentMenuIntent: { kind: "new" },

  resetForWorkspace: (cwd, hostProfileId) => {
    const key = normalizedCwd(cwd);
    const current = get();
    if (
      current.workspaceCwd &&
      normalizedCwd(current.workspaceCwd) === key &&
      current.tabs.some((tab) => normalizedCwd(tab.cwd) === key)
    ) {
      return Promise.resolve();
    }
    const inflight = workspaceResetPromises.get(key);
    if (inflight) return inflight;

    const reset = (async () => {
      try {
        const existing = (await window.anchor.terminal.list()).filter(
          (tab) => normalizedCwd(tab.cwd) === key,
        );
        for (const id of [...agentCompletionTimers.keys()]) {
          clearAgentCompletionTimer(id);
        }
        const workgroups = loadWorkgroupsState(cwd, hostProfileId ?? null);
        const assigned = assignTabsToWorkgroups(existing, workgroups, {});
        if (existing.length > 0) {
          const shell = existing
            .filter((tab) => modeOf(tab) === "terminal")
            .at(-1);
          const agent = existing
            .filter((tab) => modeOf(tab) === "agent")
            .at(-1);
          set((s) => ({
            workspaceCwd: cwd,
            workspaceHostProfileId: hostProfileId ?? s.workspaceHostProfileId,
            tabs: existing,
            workgroups: workgroups.groups,
            activeGroupId: workgroups.activeGroupId,
            tabWorkgroupById: assigned.tabWorkgroupById,
            sessionGroupById: assigned.sessionGroupById,
            parkedAgents: [],
            activeByMode: {
              terminal: shell?.id ?? null,
              agent: agent?.id ?? null,
            },
            agentActivity: {},
            mode: shell ? "terminal" : agent ? "agent" : "terminal",
            error: null,
            agentMenuOpen: s.agentMenuOpen,
            agentMenuIntent: s.agentMenuIntent,
          }));
        } else {
          const tab = await window.anchor.terminal.create({
            cwd,
            cols: 80,
            rows: 24,
            kind: "shell",
          });
          set((s) => ({
            workspaceCwd: cwd,
            workspaceHostProfileId: hostProfileId ?? s.workspaceHostProfileId,
            tabs: [tab],
            workgroups: workgroups.groups,
            activeGroupId: workgroups.activeGroupId,
            tabWorkgroupById: assigned.tabWorkgroupById,
            sessionGroupById: assigned.sessionGroupById,
            parkedAgents: [],
            activeByMode: { terminal: tab.id, agent: null },
            agentActivity: {},
            mode: "terminal",
            error: null,
            agentMenuOpen: s.agentMenuOpen,
            agentMenuIntent: s.agentMenuIntent,
          }));
        }
        restoreParkedWorkspaceAgents(cwd, hostProfileId ?? null);
        persistCurrentWorkgroups(hostProfileId ?? null);
        void get().loadAgentProfiles();
        void get().detectAgents();
      } catch (err) {
        const workgroups = loadWorkgroupsState(cwd, hostProfileId ?? null);
        set((s) => ({
          workspaceCwd: cwd,
          workspaceHostProfileId: hostProfileId ?? s.workspaceHostProfileId,
          tabs: [],
          workgroups: workgroups.groups,
          activeGroupId: workgroups.activeGroupId,
          tabWorkgroupById: {},
          sessionGroupById: workgroups.sessionGroupById,
          parkedAgents: parkedFromPersisted(
            readPersistedAgents()[workspaceAgentKey(cwd, hostProfileId ?? null)],
            workgroups,
            new Set(),
          ),
          activeByMode: { terminal: null, agent: null },
          mode: "terminal",
          error: formatError(err),
          agentMenuOpen: s.agentMenuOpen,
          agentMenuIntent: s.agentMenuIntent,
        }));
      } finally {
        workspaceResetPromises.delete(key);
      }
    })();
    workspaceResetPromises.set(key, reset);
    return reset;
  },

  setMode: (mode) =>
    set((s) => {
      const agentSessions = s.tabs.filter((t) => modeOf(t) === "agent");
      // No agent yet: open create dialog without leaving Terminal.
      if (mode === "agent" && agentSessions.length === 0) {
        return {
          agentMenuOpen: true,
          agentMenuIntent: { kind: "new" },
          // Keep Terminal mode until an agent session is actually created.
          mode: "terminal",
        };
      }
      return {
        mode,
        agentMenuOpen: false,
        activeByMode: {
          ...s.activeByMode,
          [mode]: pickActive(s.tabs, mode, s.activeByMode[mode]),
        },
      };
    }),

  toggleSessionList: (mode) =>
    set((s) => {
      const sessionListOpenByMode = {
        ...s.sessionListOpenByMode,
        [mode]: !s.sessionListOpenByMode[mode],
      };
      writeSessionListOpenByMode(sessionListOpenByMode);
      return { sessionListOpenByMode };
    }),

  setSessionListOpen: (mode, open) => {
    set((s) => {
      const sessionListOpenByMode = {
        ...s.sessionListOpenByMode,
        [mode]: open,
      };
      writeSessionListOpenByMode(sessionListOpenByMode);
      return { sessionListOpenByMode };
    });
  },

  createShellTab: async () => {
    const cwd =
      get().workspaceCwd ??
      (await window.anchor.host.getInfo()).workspaceRoot ??
      undefined;
    try {
      const tab = await window.anchor.terminal.create({
        cwd: cwd ?? undefined,
        cols: 80,
        rows: 24,
        kind: "shell",
      });
      set((s) => ({
        tabs: s.tabs.some((item) => item.id === tab.id)
          ? s.tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...s.tabs, tab],
        mode: "terminal",
        activeByMode: { ...s.activeByMode, terminal: tab.id },
        error: null,
        agentMenuOpen: false,
      }));
      // Ensure bottom terminal rail is open so the new session is visible.
      try {
        const { useShellStore } = await import("@/features/shell/shellStore");
        useShellStore.getState().setTerminalVisible(true);
      } catch {
        // ignore
      }
    } catch (err) {
      set({
        error: formatError(err),
      });
    }
  },

  createAgentTab: async (profile, launch) => {
    try {
      const resumeSessionId = launch?.resumeSessionId?.trim();
      if (resumeSessionId) {
        const live = get().tabs.find(
          (tab) =>
            (tab.kind ?? "shell") === "agent" &&
            tab.agentSessionId === resumeSessionId,
        );
        if (live) {
          get().focusAgentTab(live.id);
          set((s) => ({
            parkedAgents: s.parkedAgents.filter(
              (item) => item.sessionId !== resumeSessionId,
            ),
            agentMenuOpen: false,
            agentMenuIntent: { kind: "new" },
            defaultAgentId: profile.id,
          }));
          return true;
        }
      }
      const taskTitle = launch?.title?.trim();
      const tab = await window.anchor.agent.createSession({
        profileId: profile.id,
        model: launch?.model,
        effort: launch?.effort,
        prompt: launch?.prompt?.trim() || taskTitle,
        readOnly: launch?.readOnly,
        resume: Boolean(launch?.resumeSessionId),
        sessionId: launch?.resumeSessionId,
        title: taskTitle || undefined,
        cols: 80,
        rows: 24,
      });
      if (launch?.readOnly) agentReadOnlyByTabId.set(tab.id, true);
      else agentReadOnlyByTabId.delete(tab.id);
      set((s) => {
        const existing = s.tabs.find((item) => item.id === tab.id);
        const groupId = existing
          ? s.tabWorkgroupById[tab.id] ?? s.activeGroupId
          : s.activeGroupId;
        const grouping = applyWorkgroupToTab(s, tab, groupId, profile.id);
        return {
          tabs: s.tabs.some((item) => item.id === tab.id)
            ? s.tabs.map((item) => (item.id === tab.id ? tab : item))
            : [...s.tabs, tab],
          ...grouping,
          mode: "agent",
          activeByMode: { ...s.activeByMode, agent: tab.id },
          error: null,
          agentMenuOpen: false,
          agentMenuIntent: { kind: "new" },
          parkedAgents: s.parkedAgents.filter(
            (item) =>
              !tab.agentSessionId || item.sessionId !== tab.agentSessionId,
          ),
          defaultAgentId: profile.id,
        };
      });
      persistCurrentWorkgroups();
      void window.anchor.agent.setDefaultId(profile.id);
      try {
        localStorage.setItem("anchor.agent.lastProfileId", profile.id);
        localStorage.setItem(
          `anchor.agent.launch.${profile.id}`,
          JSON.stringify({
            model: launch?.model ?? null,
            effort: launch?.effort ?? null,
          }),
        );
      } catch {
        // ignore
      }
      return true;
    } catch (err) {
      set({
        error: formatError(err),
        agentMenuOpen: false,
        agentMenuIntent: { kind: "new" },
      });
      return false;
    }
  },

  
  createAgentDefault: async () => {
    if (get().agentProfiles.length === 0) {
      await get().loadAgentProfiles();
    }
    const agentSessions = get().tabs.filter((t) => modeOf(t) === "agent");
    if (agentSessions.length === 0) {
      set({
        agentMenuOpen: true,
        agentMenuIntent: { kind: "new" },
        mode: "terminal",
      });
    } else {
      set({
        agentMenuOpen: true,
        agentMenuIntent: { kind: "new" },
        mode: "agent",
      });
    }
  },


  noteSessionExit: (id, exitCode) => {
    set((s) => ({
      exitCodeById: { ...s.exitCodeById, [id]: exitCode },
      tabs: s.tabs.map((tab) =>
        tab.id === id ? { ...tab, status: "exited" as const } : tab,
      ),
    }));
  },

  closeTab: async (id) => {
    try {
      await window.anchor.terminal.kill(id);
    } catch {
      // already dead
    }
    get().removeTabLocal(id);
  },

  removeTabLocal: (id) => {
    disposeXtermSession(id);
    clearAgentCompletionTimer(id);
    agentReadOnlyByTabId.delete(id);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const closed = s.tabs.find((t) => t.id === id);
      const closedMode = closed ? modeOf(closed) : s.mode;
      const activeByMode = { ...s.activeByMode };
      if (activeByMode[closedMode] === id) {
        activeByMode[closedMode] = pickActive(tabs, closedMode, null);
      }
      const hasAgent = tabs.some((t) => modeOf(t) === "agent");
      const mode =
        closedMode === "agent" && !hasAgent ? "terminal" : s.mode;
      const { [id]: _closedGroup, ...tabWorkgroupById } = s.tabWorkgroupById;
      const { [id]: _exit, ...exitCodeById } = s.exitCodeById;
      return {
        tabs,
        activeByMode,
        tabWorkgroupById,
        exitCodeById,
        agentActivity: Object.fromEntries(
          Object.entries(s.agentActivity).filter(([tabId]) => tabId !== id),
        ),
        mode,
        agentMenuOpen: mode === "terminal" ? false : s.agentMenuOpen,
      };
    });
    persistCurrentWorkgroups();
  },

  setActive: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return s;
      const m = modeOf(tab);
      return {
        mode: m,
        activeByMode: { ...s.activeByMode, [m]: id },
        agentActivity:
          m === "agent"
            ? {
                ...s.agentActivity,
                [id]: nextAgentActivity(s.agentActivity[id] ?? "idle", "viewed"),
              }
            : s.agentActivity,
      };
    }),

  renameTab: async (id, title) => {
    try {
      const info = await window.anchor.terminal.rename(id, title);
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? info : t)),
        error: null,
      }));
    } catch (err) {
      set({
        error: formatError(err),
      });
    }
  },

  applyTitleFromTerm: (id, title) => {
    void window.anchor.terminal.applyTitle(id, title).then((info) => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? info : t)),
      }));
    });
  },

  applyAgentTopicFromLine: (id, line) => {
    void window.anchor.terminal.applyAgentTopic(id, line).then((info) => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? info : t)),
      }));
    });
  },
  markAgentWorking: (id) => {
    clearAgentCompletionTimer(id);
    set((s) => ({
      agentActivity: {
        ...s.agentActivity,
        [id]: nextAgentActivity(s.agentActivity[id] ?? "idle", "started"),
      },
    }));
  },

  noteAgentOutput: (id) => {
    const state = get();
    if (state.agentActivity[id] !== "working") return;
    clearAgentCompletionTimer(id);
    agentCompletionTimers.set(
      id,
      window.setTimeout(() => {
        agentCompletionTimers.delete(id);
        set((s) => ({
          agentActivity: {
            ...s.agentActivity,
            [id]: completeAgentActivity(
              s.agentActivity[id] ?? "idle",
              s.activeByMode.agent === id,
            ),
          },
        }));
      }, 2_500),
    );
  },

  write: (id, data) => {
    void window.anchor.terminal.write(id, data);
  },

  resize: (id, cols, rows) => {
    void window.anchor.terminal.resize(id, cols, rows);
  },

  loadAgentProfiles: async () => {
    try {
      const [profiles, defaultId] = await Promise.all([
        window.anchor.agent.listProfiles(),
        window.anchor.agent.getDefaultId(),
      ]);
      set({
        agentProfiles: profiles,
        defaultAgentId: defaultId ?? null,
      });
    } catch {
      // optional surface
    }
  },

  detectAgents: async () => {
    try {
      const profiles = await window.anchor.agent.detect();
      const defaultId = await window.anchor.agent.getDefaultId();
      set({
        agentProfiles: profiles,
        defaultAgentId: defaultId ?? null,
      });
    } catch (err) {
      set({
        error: formatError(err),
      });
    }
  },

  setAgentMenuOpen: (open) =>
    set(
      open
        ? { agentMenuOpen: true, agentMenuIntent: { kind: "new" } }
        : { agentMenuOpen: false, agentMenuIntent: { kind: "new" } },
    ),

  openAgentMenu: (intent) =>
    set({
      agentMenuOpen: true,
      agentMenuIntent: intent ?? { kind: "new" },
    }),

  closeAgentMenu: () =>
    set((s) => {
      const hasAgent = s.tabs.some((t) => modeOf(t) === "agent");
      return {
        agentMenuOpen: false,
        agentMenuIntent: { kind: "new" },
        mode: hasAgent ? s.mode : "terminal",
      };
    }),

  addCustomAgent: async (input) => {
    const command = input.command.trim();
    if (!command) {
      set({ error: "Command is required" });
      return null;
    }
    const name = input.name.trim() || command;
    const id = `custom-${command
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .toLowerCase()}-${Date.now().toString(36)}`;
    try {
      const profiles = await window.anchor.agent.upsertProfile({
        id,
        name,
        command,
        args: input.args ?? [],
        enabled: true,
        detected: false,
      });
      set({ agentProfiles: profiles, error: null });
      return profiles.find((p) => p.id === id) ?? null;
    } catch (err) {
      set({
        error: formatError(err),
      });
      return null;
    }
  },

  setActiveWorkgroup: (id) =>
    set((s) => {
      if (!s.workgroups.some((group) => group.id === id)) return s;
      const groupTabs = agentTabsInWorkgroup(s.tabs, s.tabWorkgroupById, id);
      const keepCurrent =
        s.activeByMode.agent &&
        groupTabs.some((tab) => tab.id === s.activeByMode.agent);
      const nextActive = keepCurrent
        ? s.activeByMode.agent
        : groupTabs.at(-1)?.id ?? s.activeByMode.agent;
      const next = { ...s, activeGroupId: id };
      persistWorkgroupsState(
        s.workspaceCwd,
        s.workspaceHostProfileId,
        workgroupsSnapshot(next),
      );
      return {
        activeGroupId: id,
        activeByMode: { ...s.activeByMode, agent: nextActive },
      };
    }),

  createWorkgroup: (name) => {
    const id = nextWorkgroupId();
    set((s) => {
      const group = {
        id,
        name: uniqueWorkgroupName(s.workgroups, name?.trim() || "Workgroup"),
        createdAt: new Date().toISOString(),
      };
      const next = {
        ...s,
        workgroups: [...s.workgroups, group],
        activeGroupId: id,
      };
      persistWorkgroupsState(
        s.workspaceCwd,
        s.workspaceHostProfileId,
        workgroupsSnapshot(next),
      );
      return {
        workgroups: next.workgroups,
        activeGroupId: id,
      };
    });
    return id;
  },

  renameWorkgroup: (id, name) =>
    set((s) => {
      const next = renameWorkgroupInState(
        {
          groups: s.workgroups,
          activeGroupId: s.activeGroupId,
          sessionGroupById: s.sessionGroupById,
        },
        id,
        name,
      );
      persistWorkgroupsState(s.workspaceCwd, s.workspaceHostProfileId, next);
      return { workgroups: next.groups };
    }),

  deleteWorkgroup: (id) =>
    set((s) => {
      const next = removeWorkgroup(
        {
          groups: s.workgroups,
          activeGroupId: s.activeGroupId,
          sessionGroupById: s.sessionGroupById,
        },
        id,
      );
      if (next.groups === s.workgroups) return s;
      persistWorkgroupsState(s.workspaceCwd, s.workspaceHostProfileId, next);
      return {
        workgroups: next.groups,
        activeGroupId: next.activeGroupId,
        sessionGroupById: next.sessionGroupById,
        tabWorkgroupById: reassignGroupIds(
          s.tabWorkgroupById,
          id,
          DEFAULT_WORKGROUP_ID,
        ),
        parkedAgents: s.parkedAgents.map((item) =>
          item.groupId === id
            ? { ...item, groupId: DEFAULT_WORKGROUP_ID }
            : item,
        ),
      };
    }),

  focusAgentTab: (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab || (tab.kind ?? "shell") !== "agent") return;
    set((s) => ({
      activeGroupId: s.tabWorkgroupById[id] ?? s.activeGroupId,
      activeByMode: { ...s.activeByMode, agent: id },
      mode: "agent",
      agentActivity: {
        ...s.agentActivity,
        [id]: nextAgentActivity(s.agentActivity[id] ?? "idle", "viewed"),
      },
    }));
    persistCurrentWorkgroups();
  },
  resumeParkedAgent: (sessionId) => resumeParkedAgent(sessionId),
}));

// Push title updates from main (agent TUI topic scrape via PTY output).
if (typeof window !== "undefined" && window.anchor?.terminal?.onTitle) {
  window.anchor.terminal.onTitle(({ id, info }) => {
    useTerminalStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? info : t)),
    }));
  });
}

// TerminalService is the source of truth for both the Electron UI and remote
// mobile clients. Lifecycle pushes keep sessions created or removed by either
// surface visible on the other without polling or maintaining a second list.
if (typeof window !== "undefined" && window.anchor?.terminal?.onCreated) {
  window.anchor.terminal.onCreated(({ info }) => {
    const mode = modeOf(info);
    useTerminalStore.setState((state) => {
      const already = state.tabs.some((tab) => tab.id === info.id);
      const grouping =
        mode === "agent"
          ? applyWorkgroupToTab(
              state,
              info,
              already
                ? state.tabWorkgroupById[info.id] ?? state.activeGroupId
                : state.activeGroupId,
              info.agentId,
            )
          : null;
      return {
        tabs: already
          ? state.tabs.map((tab) => (tab.id === info.id ? info : tab))
          : [...state.tabs, info],
        ...(grouping ?? {}),
        activeByMode: { ...state.activeByMode, [mode]: info.id },
        mode: mode === "agent" ? "agent" : state.mode,
        agentMenuOpen: mode === "agent" ? false : state.agentMenuOpen,
        error: null,
      };
    });
    if (mode === "agent") persistCurrentWorkgroups();
  });
}

if (typeof window !== "undefined" && window.anchor?.terminal?.onUpdated) {
  window.anchor.terminal.onUpdated(({ info }) => {
    useTerminalStore.setState((state) => {
      const grouping =
        info.kind === "agent" && info.agentSessionId
          ? applyWorkgroupToTab(
              state,
              info,
              state.tabWorkgroupById[info.id] ?? state.activeGroupId,
              info.agentId,
            )
          : null;
      return {
        tabs: state.tabs.map((tab) => (tab.id === info.id ? info : tab)),
        ...(grouping ?? {}),
      };
    });
  });
}

if (typeof window !== "undefined" && window.anchor?.terminal?.onExit) {
  window.anchor.terminal.onExit(({ id, exitCode }) => {
    clearAgentCompletionTimer(id);
    const watched = resumeWatch.get(id);
    resumeWatch.delete(id);
    if (watched && Date.now() - watched.at < RESUME_FAIL_WINDOW_MS) {
      const error = "The CLI exited right after resuming; the session may no longer exist.";
      useTerminalStore.setState((state) => ({
        error,
        parkedAgents: state.parkedAgents.some((p) => p.sessionId === watched.parked.sessionId)
          ? state.parkedAgents
          : [{ ...watched.parked, error }, ...state.parkedAgents],
      }));
    }
    useTerminalStore.getState().noteSessionExit(id, exitCode);
    useTerminalStore.setState((state) => {
      const tab = state.tabs.find((item) => item.id === id);
      if (tab?.kind !== "agent") return state;
      return {
        agentActivity: {
          ...state.agentActivity,
          [id]: nextAgentActivity(
            state.agentActivity[id] ?? "idle",
            state.activeByMode.agent === id ? "viewed" : "completed",
          ),
        },
      };
    });
  });
}

if (typeof window !== "undefined" && window.anchor?.terminal?.onRemoved) {
  window.anchor.terminal.onRemoved(({ id }) => {
    useTerminalStore.getState().removeTabLocal(id);
  });
}

export function sessionsForMode(
  tabs: TerminalTabInfo[],
  mode: RightTermMode,
): TerminalTabInfo[] {
  const kind: TerminalSessionKind = mode === "agent" ? "agent" : "shell";
  return tabs.filter((tab) => (tab.kind ?? "shell") === kind);
}

export function agentTabsInWorkgroup(
  tabs: TerminalTabInfo[],
  tabWorkgroupById: Record<string, string>,
  groupId: string,
): TerminalTabInfo[] {
  return tabs.filter(
    (tab) =>
      (tab.kind ?? "shell") === "agent" &&
      (tabWorkgroupById[tab.id] ?? DEFAULT_WORKGROUP_ID) === groupId,
  );
}

// Recency for "most recent conversation": whichever agent tab gets focus.
useTerminalStore.subscribe((state, prev) => {
  const id = state.activeByMode.agent;
  if (id && id !== prev.activeByMode.agent) markAgentActive(id);
});
