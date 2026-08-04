import { create } from "zustand";
import type {
  AgentCliProfile,
  TerminalSessionKind,
  TerminalTabInfo,
} from "@/shared/anchor-api";
import {
  disposeAllXtermSessions,
  disposeXtermSession,
} from "./xtermSessionPool";

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
  agentProfiles: AgentCliProfile[];
  defaultAgentId: string | null;
  agentMenuOpen: boolean;
  agentMenuIntent: AgentMenuIntent;

  resetForWorkspace: (cwd: string) => Promise<void>;
  setMode: (mode: RightTermMode) => void;
  toggleSessionList: (mode: RightTermMode) => void;
  setSessionListOpen: (mode: RightTermMode, open: boolean) => void;
  createShellTab: () => Promise<void>;
  createAgentTab: (
    profile: AgentCliProfile,
    launch?: AgentLaunchOptions,
  ) => Promise<void>;
  createAgentDefault: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
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
  agentProfiles: [],
  defaultAgentId: null,
  agentMenuOpen: false,
  agentMenuIntent: { kind: "new" },

  resetForWorkspace: (cwd) => {
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
        disposeAllXtermSessions();
        const existing = (await window.anchor.terminal.list()).filter(
          (tab) => normalizedCwd(tab.cwd) === key,
        );
        for (const id of [...agentCompletionTimers.keys()]) {
          clearAgentCompletionTimer(id);
        }
        if (existing.length > 0) {
          const shell = existing
            .filter((tab) => modeOf(tab) === "terminal")
            .at(-1);
          const agent = existing
            .filter((tab) => modeOf(tab) === "agent")
            .at(-1);
          set((s) => ({
            workspaceCwd: cwd,
            tabs: existing,
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
            tabs: [tab],
            activeByMode: { terminal: tab.id, agent: null },
            agentActivity: {},
            mode: "terminal",
            error: null,
            agentMenuOpen: s.agentMenuOpen,
            agentMenuIntent: s.agentMenuIntent,
          }));
        }
        void get().loadAgentProfiles();
        void get().detectAgents();
      } catch (err) {
        disposeAllXtermSessions();
        set((s) => ({
          workspaceCwd: cwd,
          tabs: [],
          activeByMode: { terminal: null, agent: null },
          mode: "terminal",
          error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createAgentTab: async (profile, launch) => {
    try {
      const taskTitle = launch?.title?.trim();
      const tab = await window.anchor.agent.createSession({
        profileId: profile.id,
        model: launch?.model,
        effort: launch?.effort,
        prompt: launch?.prompt?.trim() || taskTitle,
        cols: 80,
        rows: 24,
      });
      set((s) => ({
        tabs: s.tabs.some((item) => item.id === tab.id)
          ? s.tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...s.tabs, tab],
        mode: "agent",
        activeByMode: { ...s.activeByMode, agent: tab.id },
        error: null,
        agentMenuOpen: false,
        agentMenuIntent: { kind: "new" },
        defaultAgentId: profile.id,
      }));
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
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        agentMenuOpen: false,
        agentMenuIntent: { kind: "new" },
      });
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
      return {
        tabs,
        activeByMode,
        agentActivity: Object.fromEntries(
          Object.entries(s.agentActivity).filter(([tabId]) => tabId !== id),
        ),
        mode,
        agentMenuOpen: mode === "terminal" ? false : s.agentMenuOpen,
      };
    });
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
        error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
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
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.some((tab) => tab.id === info.id)
        ? state.tabs.map((tab) => (tab.id === info.id ? info : tab))
        : [...state.tabs, info],
      activeByMode: { ...state.activeByMode, [mode]: info.id },
      mode: mode === "agent" ? "agent" : state.mode,
      agentMenuOpen: mode === "agent" ? false : state.agentMenuOpen,
      error: null,
    }));
    if (mode === "agent") {
      void import("@/features/shell/shellStore").then(({ useShellStore }) => {
        useShellStore.getState().setAgentVisible(true);
      });
    }
  });
}

if (typeof window !== "undefined" && window.anchor?.terminal?.onUpdated) {
  window.anchor.terminal.onUpdated(({ info }) => {
    useTerminalStore.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === info.id ? info : tab)),
    }));
  });
}

if (typeof window !== "undefined" && window.anchor?.terminal?.onExit) {
  window.anchor.terminal.onExit(({ id }) => {
    clearAgentCompletionTimer(id);
    useTerminalStore.setState((state) => {
      const tab = state.tabs.find((item) => item.id === id);
      return {
        tabs: state.tabs.map((item) =>
          item.id === id ? { ...item, status: "exited" } : item,
        ),
        agentActivity:
          tab?.kind === "agent"
            ? {
                ...state.agentActivity,
                [id]: nextAgentActivity(
                  state.agentActivity[id] ?? "idle",
                  state.activeByMode.agent === id ? "viewed" : "completed",
                ),
              }
            : state.agentActivity,
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
