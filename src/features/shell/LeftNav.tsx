import { useEffect } from "react";
import { CommentsPane } from "@/features/annotations/CommentsPane";
import { FileTree } from "@/features/files/FileTree";
import { HistoryPane } from "@/features/history/HistoryPane";
import { AgentSidebar } from "@/features/terminal/AgentSidebar";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { Icon } from "@/shared/Icon";
import type { CodiconName } from "@/shared/Icon";
import type { LeftMode } from "./shellStore";
import { useShellStore } from "./shellStore";

const REVIEW_MODES: { id: Exclude<LeftMode, "agent">; label: string; icon: CodiconName }[] = [
  { id: "files", label: "FILES", icon: "files" },
  { id: "comments", label: "COMMENTS", icon: "comment-discussion" },
  { id: "history", label: "HISTORY", icon: "history" },
];

export function LeftNav() {
  const leftMode = useShellStore((s) => s.leftMode);
  const setLeftMode = useShellStore((s) => s.setLeftMode);
  const enterAgentWorkbench = useShellStore((s) => s.enterAgentWorkbench);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const hasWorkspace = Boolean(workspaceRoot);
  const agentActivity = useTerminalStore((s) => s.agentActivity);
  const agentBusy = Object.values(agentActivity).some(
    (state) => state === "working" || state === "completed-unread",
  );

  // Comments / History / Agent need a workspace; snap back to Files when closed.
  useEffect(() => {
    if (!hasWorkspace && leftMode !== "files") {
      setLeftMode("files");
    }
  }, [hasWorkspace, leftMode, setLeftMode]);

  return (
    <aside className={`left-nav${leftMode === "agent" ? " is-agent" : ""}`}>
      <nav className="left-nav__modes" aria-label="Sidebar mode">
        {REVIEW_MODES.map((m) => {
          const needsWorkspace = m.id === "comments" || m.id === "history";
          const disabled = needsWorkspace && !hasWorkspace;
          return (
            <button
              key={m.id}
              type="button"
              className={`mode-btn${leftMode === m.id ? " is-active" : ""}${
                disabled ? " is-disabled" : ""
              }`}
              disabled={disabled}
              title={
                disabled ? "Open a workspace first" : undefined
              }
              onClick={() => {
                if (disabled) return;
                setLeftMode(m.id);
              }}
            >
              <Icon name={m.icon} className="mode-btn__icon" />
              {m.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`mode-btn mode-btn--agent${leftMode === "agent" ? " is-active" : ""}${
            !hasWorkspace ? " is-disabled" : ""
          }`}
          disabled={!hasWorkspace}
          title={hasWorkspace ? "Agent workbench" : "Open a workspace first"}
          onClick={() => {
            if (!hasWorkspace) return;
            enterAgentWorkbench();
            const id = useTerminalStore.getState().activeByMode.agent;
            if (id) useTerminalStore.getState().focusAgentTab(id);
          }}
        >
          <Icon name="robot" className="mode-btn__icon" />
          AGENT
          {agentBusy ? (
            <span
              className={`mode-btn__dot${
                Object.values(agentActivity).includes("working")
                  ? " is-working"
                  : " is-unread"
              }`}
              aria-label="Agent activity"
            />
          ) : null}
        </button>
      </nav>

      <div className="left-nav__body">
        {leftMode === "files" && <FileTree />}
        {leftMode === "comments" && hasWorkspace ? <CommentsPane /> : null}
        {leftMode === "history" && hasWorkspace ? <HistoryPane /> : null}
        {leftMode === "agent" && hasWorkspace ? <AgentSidebar /> : null}
      </div>
    </aside>
  );
}
