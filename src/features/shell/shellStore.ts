import { create } from "zustand";

export type LeftMode = "files" | "comments" | "history";

export type PaletteMode = "quickOpen" | "openPath";

export interface ShellState {
  leftMode: LeftMode;
  terminalVisible: boolean;
  versionLabel: string | null;
  openWorkspaceDialog: boolean;
  /** Quick Open (Ctrl+P) or Open Path (Ctrl+O). */
  palette: PaletteMode | null;
  setLeftMode: (mode: LeftMode) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setVersionLabel: (label: string | null) => void;
  setOpenWorkspaceDialog: (open: boolean) => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  leftMode: "files",
  terminalVisible: true,
  versionLabel: null,
  openWorkspaceDialog: false,
  palette: null,
  setLeftMode: (mode) => set({ leftMode: mode }),
  toggleTerminal: () =>
    set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  setVersionLabel: (label) => set({ versionLabel: label }),
  setOpenWorkspaceDialog: (open) => set({ openWorkspaceDialog: open }),
  openPalette: (mode) => set({ palette: mode }),
  closePalette: () => set({ palette: null }),
}));
