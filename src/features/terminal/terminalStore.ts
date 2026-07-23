import { create } from "zustand";
import type {
  AgentCliProfile,
  TerminalSessionKind,
  TerminalTabInfo,
} from "@/shared/anchor-api";

export type RightTermMode = "terminal" | "agent";

const SESSION_LIST_KEY = "anchor.terminal.sessionListOpen";

function readSessionListOpen(): boolean {
  try {
    return localStorage.getItem(SESSION_LIST_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionListOpen(open: boolean) {
  try {
    localStorage.setItem(SESSION_LIST_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

export interface TerminalState {
  tabs: TerminalTabInfo[];
  /** Active tab per mode so switching modes keeps both sides alive. */
  activeByMode: Record<RightTermMode, string | null>;
  mode: RightTermMode;
  sessionListOpen: boolean;
  error: string | null;
  workspaceCwd: string | null;
  agentProfiles: AgentCliProfile[];
  defaultAgentId: string | null;
  agentMenuOpen: boolean;

  resetForWorkspace: (cwd: string) => Promise<void>;
  setMode: (mode: RightTermMode) => void;
  toggleSessionList: () => void;
  setSessionListOpen: (open: boolean) => void;
  createShellTab: () => Promise<void>;
  createAgentTab: (
    profile: AgentCliProfile,
    launch?: { model?: string; effort?: string; title?: string },
  ) => Promise<void>;
  createAgentDefault: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** Drop tab after process exit without kill (already dead). */
  removeTabLocal: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => Promise<void>;
  applyTitleFromTerm: (id: string, title: string) => void;
  applyAgentTopicFromLine: (id: string, line: string) => void;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  loadAgentProfiles: () => Promise<void>;
  detectAgents: () => Promise<void>;
  setAgentMenuOpen: (open: boolean) => void;
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
  mode: "agent",
  sessionListOpen: readSessionListOpen(),
  error: null,
  workspaceCwd: null,
  agentProfiles: [],
  defaultAgentId: null,
  agentMenuOpen: false,

  resetForWorkspace: async (cwd) => {
    try {
      await window.anchor.terminal.disposeAll();
      const tab = await window.anchor.terminal.create({
        cwd,
        cols: 80,
        rows: 24,
        kind: "shell",
      });
      set({
        workspaceCwd: cwd,
        tabs: [tab],
        activeByMode: { terminal: tab.id, agent: null },
        // Terminal is home; Agent is entered only after a session is created.
        mode: "terminal",
        error: null,
        agentMenuOpen: false,
      });
      void get().loadAgentProfiles();
      void get().detectAgents();
    } catch (err) {
      set({
        workspaceCwd: cwd,
        tabs: [],
        activeByMode: { terminal: null, agent: null },
        mode: "terminal",
        error: err instanceof Error ? err.message : String(err),
        agentMenuOpen: false,
      });
    }
  },

  setMode: (mode) =>
    set((s) => {
      const agentSessions = s.tabs.filter((t) => modeOf(t) === "agent");
      // No agent yet: open create dialog without leaving Terminal.
      if (mode === "agent" && agentSessions.length === 0) {
        return {
          agentMenuOpen: true,
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

  toggleSessionList: () =>
    set((s) => {
      const sessionListOpen = !s.sessionListOpen;
      writeSessionListOpen(sessionListOpen);
      return { sessionListOpen };
    }),

  setSessionListOpen: (open) => {
    writeSessionListOpen(open);
    set({ sessionListOpen: open });
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
        tabs: [...s.tabs, tab],
        mode: "terminal",
        activeByMode: { ...s.activeByMode, terminal: tab.id },
        error: null,
        agentMenuOpen: false,
      }));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createAgentTab: async (profile, launch) => {
    const cwd =
      get().workspaceCwd ??
      (await window.anchor.host.getInfo()).workspaceRoot ??
      undefined;
    try {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const taskTitle = launch?.title?.trim();
      const baseName = profile.name.trim() || profile.id;
      const fallbackTitle = [baseName, launch?.model, launch?.effort, `${hh}:${mm}`]
        .filter(Boolean)
        .join(" · ");
      const title = taskTitle || fallbackTitle;

      const extra =
        (await window.anchor.agent.buildLaunchArgs({
          profileId: profile.id,
          model: launch?.model,
          effort: launch?.effort,
          prompt: taskTitle,
        })) ?? [];

      let tab = await window.anchor.terminal.create({
        cwd: cwd ?? undefined,
        cols: 80,
        rows: 24,
        kind: "agent",
        command: profile.command,
        args: [...(profile.args ?? []), ...extra],
        title,
        agentId: profile.id,
      });
      if (taskTitle) {
        try {
          tab = await window.anchor.terminal.rename(tab.id, taskTitle);
        } catch {
          tab = { ...tab, title: taskTitle, titleSource: "user" };
        }
      }

      set((s) => ({
        tabs: [...s.tabs, tab],
        mode: "agent",
        activeByMode: { ...s.activeByMode, agent: tab.id },
        error: null,
        agentMenuOpen: false,
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
      });
    }
  },

  
  createAgentDefault: async () => {
    if (get().agentProfiles.length === 0) {
      await get().loadAgentProfiles();
    }
    const agentSessions = get().tabs.filter((t) => modeOf(t) === "agent");
    if (agentSessions.length === 0) {
      set({ agentMenuOpen: true, mode: "terminal" });
    } else {
      set({ agentMenuOpen: true, mode: "agent" });
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
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const closed = s.tabs.find((t) => t.id === id);
      const closedMode = closed ? modeOf(closed) : s.mode;
      const activeByMode = { ...s.activeByMode };
      if (activeByMode[closedMode] === id) {
        activeByMode[closedMode] = pickActive(tabs, closedMode, null);
      }
      const hasAgent = tabs.some((t) => modeOf(t) === "agent");
      // Closing last agent → back to Terminal home.
      const mode =
        closedMode === "agent" && !hasAgent ? "terminal" : s.mode;
      return {
        tabs,
        activeByMode,
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

  setAgentMenuOpen: (open) => set({ agentMenuOpen: open }),

  closeAgentMenu: () =>
    set((s) => {
      const hasAgent = s.tabs.some((t) => modeOf(t) === "agent");
      return {
        agentMenuOpen: false,
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

export function sessionsForMode(
  tabs: TerminalTabInfo[],
  mode: RightTermMode,
): TerminalTabInfo[] {
  const kind: TerminalSessionKind = mode === "agent" ? "agent" : "shell";
  return tabs.filter((t) => (t.kind ?? "shell") === kind);
}
