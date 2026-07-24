import { useCallback, useEffect } from "react";
import { useShellStore } from "@/features/shell/shellStore";
import type { AgentCliProfile } from "@/shared/anchor-api";
import { NewAgentDialog } from "./NewAgentDialog";
import { useTerminalStore } from "./terminalStore";

function hasAgentSessions() {
  return useTerminalStore
    .getState()
    .tabs.some((t) => (t.kind ?? "shell") === "agent");
}

/**
 * Global host for the New Agent dialog.
 * Rendered outside the agent rail so the dialog can open without opening the side panel.
 * Side panel opens only after the user confirms and a session is created.
 */
export function NewAgentDialogHost() {
  const agentMenuOpen = useTerminalStore((s) => s.agentMenuOpen);
  const agentProfiles = useTerminalStore((s) => s.agentProfiles);
  const defaultAgentId = useTerminalStore((s) => s.defaultAgentId);
  const createAgentTab = useTerminalStore((s) => s.createAgentTab);
  const closeAgentMenu = useTerminalStore((s) => s.closeAgentMenu);
  const loadAgentProfiles = useTerminalStore((s) => s.loadAgentProfiles);
  const detectAgents = useTerminalStore((s) => s.detectAgents);

  useEffect(() => {
    if (!agentMenuOpen) return;
    void loadAgentProfiles();
  }, [agentMenuOpen, loadAgentProfiles]);

  const onOpen = useCallback(
    async (
      p: AgentCliProfile,
      launch: { model?: string; effort?: string; title?: string },
    ) => {
      await createAgentTab(p, launch);
      // Open the agent side rail only after a session actually exists.
      if (hasAgentSessions()) {
        useShellStore.getState().setAgentVisible(true);
      }
    },
    [createAgentTab],
  );

  const onClose = useCallback(() => {
    closeAgentMenu();
    // Dialog dismissed without creating — never leave an empty rail open.
    if (!hasAgentSessions()) {
      useShellStore.getState().setAgentVisible(false);
    }
  }, [closeAgentMenu]);

  if (!agentMenuOpen) return null;

  return (
    <NewAgentDialog
      profiles={agentProfiles}
      defaultAgentId={defaultAgentId}
      onOpen={(p, launch) => {
        void onOpen(p, launch);
      }}
      onDetect={() => void detectAgents()}
      onClose={onClose}
    />
  );
}
