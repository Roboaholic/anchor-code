import { create } from "zustand";

export type LeftMode = "files" | "comments" | "history";

export type PaletteMode = "quickOpen" | "openPath";

export interface ShellState {
  leftMode: LeftMode;
  /** Files / Comments / History sidebar. */
  leftVisible: boolean;
  /** Right rail — agent sessions. */
  agentVisible: boolean;
  /** Bottom panel — shell terminals. */
  terminalVisible: boolean;
  versionLabel: string | null;
  openWorkspaceDialog: boolean;
  /**
   * Prompt to install the Anchor Review agent skill into the opened workspace.
   * Set after Open Workspace when `.agents/skills/anchor-review` is missing.
   */
  skillInstallPromptRoot: string | null;
  /** Quick Open (Ctrl+P) or Open Path (Ctrl+O). */
  palette: PaletteMode | null;
  setLeftMode: (mode: LeftMode) => void;
  toggleLeft: () => void;
  setLeftVisible: (visible: boolean) => void;
  toggleAgent: () => void;
  setAgentVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setVersionLabel: (label: string | null) => void;
  setOpenWorkspaceDialog: (open: boolean) => void;
  setSkillInstallPromptRoot: (root: string | null) => void;
  dismissSkillInstallPrompt: () => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  leftMode: "files",
  leftVisible: true,
  /** Closed until a workspace is open (user can then toggle). */
  agentVisible: false,
  terminalVisible: false,
  versionLabel: null,
  openWorkspaceDialog: false,
  skillInstallPromptRoot: null,
  palette: null,
  setLeftMode: (mode) => set({ leftMode: mode }),
  toggleLeft: () => set((s) => ({ leftVisible: !s.leftVisible })),
  setLeftVisible: (visible) => set({ leftVisible: visible }),
  toggleAgent: () => set((s) => ({ agentVisible: !s.agentVisible })),
  setAgentVisible: (visible) => set({ agentVisible: visible }),
  toggleTerminal: () =>
    set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  setVersionLabel: (label) => set({ versionLabel: label }),
  setOpenWorkspaceDialog: (open) => set({ openWorkspaceDialog: open }),
  setSkillInstallPromptRoot: (root) => set({ skillInstallPromptRoot: root }),
  dismissSkillInstallPrompt: () => set({ skillInstallPromptRoot: null }),
  openPalette: (mode) => set({ palette: mode }),
  closePalette: () => set({ palette: null }),
}));
