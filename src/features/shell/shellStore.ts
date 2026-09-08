import { create } from "zustand";

export type LeftMode = "files" | "comments" | "history" | "agent";

export type PaletteMode = "quickOpen" | "openPath";

type WorkspaceShellView = {
  leftMode: LeftMode;
  reviewLeftMode: Exclude<LeftMode, "agent">;
  leftVisible: boolean;
  agentVisible: boolean;
  terminalVisible: boolean;
};
const workspaceShellViews = new Map<string, WorkspaceShellView>();

export function captureWorkspaceShellView(key: string): void {
  const state = useShellStore.getState();
  workspaceShellViews.set(key, {
    leftMode: state.leftMode,
    reviewLeftMode: state.reviewLeftMode,
    leftVisible: state.leftVisible,
    agentVisible: state.agentVisible,
    terminalVisible: state.terminalVisible,
  });
}

export function restoreWorkspaceShellView(key: string): boolean {
  const view = workspaceShellViews.get(key);
  if (!view) return false;
  useShellStore.setState(view);
  return true;
}

export interface ShellState {
  leftMode: LeftMode;
  /** Last Files / Comments / History mode, restored when leaving Agent. */
  reviewLeftMode: Exclude<LeftMode, "agent">;
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
  enterAgentWorkbench: () => void;
  leaveAgentWorkbench: () => void;
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
  reviewLeftMode: "files",
  leftVisible: true,
  /** Closed until a workspace is open (user can then toggle). */
  agentVisible: false,
  terminalVisible: false,
  versionLabel: null,
  openWorkspaceDialog: false,
  skillInstallPromptRoot: null,
  palette: null,
  setLeftMode: (mode) =>
    set((s) => ({
      leftMode: mode,
      reviewLeftMode: mode === "agent" ? s.reviewLeftMode : mode,
    })),
  enterAgentWorkbench: () =>
    set((s) => ({
      leftMode: "agent",
      reviewLeftMode: s.leftMode === "agent" ? s.reviewLeftMode : s.leftMode,
      leftVisible: true,
    })),
  leaveAgentWorkbench: () =>
    set((s) => ({
      leftMode: s.reviewLeftMode,
    })),
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
