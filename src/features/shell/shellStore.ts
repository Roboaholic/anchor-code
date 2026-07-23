import { create } from "zustand";

export type LeftMode = "files" | "comments" | "history";

export type PaletteMode = "quickOpen" | "openPath";

export interface ShellState {
  leftMode: LeftMode;
  /** Files / Comments / History sidebar. */
  leftVisible: boolean;
  /** Right rail (terminal + agent). */
  terminalVisible: boolean;
  versionLabel: string | null;
  openWorkspaceDialog: boolean;
  /** Quick Open (Ctrl+P) or Open Path (Ctrl+O). */
  palette: PaletteMode | null;
  setLeftMode: (mode: LeftMode) => void;
  toggleLeft: () => void;
  setLeftVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setVersionLabel: (label: string | null) => void;
  setOpenWorkspaceDialog: (open: boolean) => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  leftMode: "files",
  leftVisible: true,
  /** Closed until a workspace is open (user can then toggle). */
  terminalVisible: false,
  versionLabel: null,
  openWorkspaceDialog: false,
  palette: null,
  setLeftMode: (mode) => set({ leftMode: mode }),
  toggleLeft: () => set((s) => ({ leftVisible: !s.leftVisible })),
  setLeftVisible: (visible) => set({ leftVisible: visible }),
  toggleTerminal: () =>
    set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  setVersionLabel: (label) => set({ versionLabel: label }),
  setOpenWorkspaceDialog: (open) => set({ openWorkspaceDialog: open }),
  openPalette: (mode) => set({ palette: mode }),
  closePalette: () => set({ palette: null }),
}));
