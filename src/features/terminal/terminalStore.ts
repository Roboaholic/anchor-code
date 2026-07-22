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
  createAgentTab: (profile: AgentCliProfile) => Promise<void>;
  createAgentDefault: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  loadAgentProfiles: () => Promise<void>;
  detectAgents: () => Promise<void>;
  setAgentMenuOpen: (open: boolean) => void;
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
  mode: "terminal",
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
        mode: "terminal",
        error: null,
        agentMenuOpen: false,
      });
      void get().loadAgentProfiles();
      // Detect once per workspace open so "found" badges stay fresh.
      void get().detectAgents();
    } catch (err) {
      set({
        workspaceCwd: cwd,
        tabs: [],
        activeByMode: { terminal: null, agent: null },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setMode: (mode) =>
    set((s) => ({
      mode,
      agentMenuOpen: false,
      activeByMode: {
        ...s.activeByMode,
        [mode]: pickActive(s.tabs, mode, s.activeByMode[mode]),
      },
    })),

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

  createAgentTab: async (profile) => {
    const cwd =
      get().workspaceCwd ??
      (await window.anchor.host.getInfo()).workspaceRoot ??
      undefined;
    try {
      const tab = await window.anchor.terminal.create({
        cwd: cwd ?? undefined,
        cols: 80,
        rows: 24,
        kind: "agent",
        command: profile.command,
        args: profile.args ?? [],
        title: profile.name,
        agentId: profile.id,
      });
      set((s) => ({
        tabs: [...s.tabs, tab],
        mode: "agent",
        activeByMode: { ...s.activeByMode, agent: tab.id },
        error: null,
        agentMenuOpen: false,
        defaultAgentId: profile.id,
      }));
      void window.anchor.agent.setDefaultId(profile.id);
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
    // Always show picker so user can open another session of any agent.
    set({ agentMenuOpen: true });
  },

  closeTab: async (id) => {
    await window.anchor.terminal.kill(id);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const closed = s.tabs.find((t) => t.id === id);
      const closedMode = closed ? modeOf(closed) : s.mode;
      const activeByMode = { ...s.activeByMode };
      if (activeByMode[closedMode] === id) {
        activeByMode[closedMode] = pickActive(tabs, closedMode, null);
      }
      return { tabs, activeByMode };
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

export function sessionsForMode(
  tabs: TerminalTabInfo[],
  mode: RightTermMode,
): TerminalTabInfo[] {
  const kind: TerminalSessionKind = mode === "agent" ? "agent" : "shell";
  return tabs.filter((t) => (t.kind ?? "shell") === kind);
}
