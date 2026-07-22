import { create } from "zustand";

export type LeftMode = "files" | "comments" | "history";

export interface ShellState {
  leftMode: LeftMode;
  terminalVisible: boolean;
  versionLabel: string | null;
  openWorkspaceDialog: boolean;
  setLeftMode: (mode: LeftMode) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setVersionLabel: (label: string | null) => void;
  setOpenWorkspaceDialog: (open: boolean) => void;
}

export const useShellStore = create<ShellState>((set) => ({
  leftMode: "files",
  terminalVisible: true,
  versionLabel: null,
  openWorkspaceDialog: false,
  setLeftMode: (mode) => set({ leftMode: mode }),
  toggleTerminal: () =>
    set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  setVersionLabel: (label) => set({ versionLabel: label }),
  setOpenWorkspaceDialog: (open) => set({ openWorkspaceDialog: open }),
}));
