import { create } from "zustand";
import type { TerminalTabInfo } from "@/shared/anchor-api";

export interface TerminalState {
  tabs: TerminalTabInfo[];
  activeTabId: string | null;
  error: string | null;
  workspaceCwd: string | null;

  resetForWorkspace: (cwd: string) => Promise<void>;
  createTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  error: null,
  workspaceCwd: null,

  resetForWorkspace: async (cwd) => {
    try {
      await window.anchor.terminal.disposeAll();
      const tab = await window.anchor.terminal.create({ cwd, cols: 80, rows: 24 });
      set({
        workspaceCwd: cwd,
        tabs: [tab],
        activeTabId: tab.id,
        error: null,
      });
    } catch (err) {
      set({
        workspaceCwd: cwd,
        tabs: [],
        activeTabId: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createTab: async () => {
    const cwd =
      get().workspaceCwd ??
      (await window.anchor.host.getInfo()).workspaceRoot ??
      undefined;
    try {
      const tab = await window.anchor.terminal.create({
        cwd: cwd ?? undefined,
        cols: 80,
        rows: 24,
      });
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        error: null,
      }));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  closeTab: async (id) => {
    await window.anchor.terminal.kill(id);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = tabs[tabs.length - 1]?.id ?? null;
      }
      return { tabs, activeTabId };
    });
  },

  setActive: (id) => set({ activeTabId: id }),

  write: (id, data) => {
    void window.anchor.terminal.write(id, data);
  },

  resize: (id, cols, rows) => {
    void window.anchor.terminal.resize(id, cols, rows);
  },
}));
