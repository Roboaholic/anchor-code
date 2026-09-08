import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCliProfile,
  AgentSessionSummary,
  TerminalTabInfo,
} from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import {
  agentTabsInWorkgroup,
  useTerminalStore,
  type AgentActivityState,
} from "./terminalStore";
import {
  DEFAULT_WORKGROUP_ID,
  uniqueWorkgroupName,
  type AgentWorkgroup,
} from "./workgroups";

type HistoryItem = AgentSessionSummary & { profileId: string; profileName: string };

const HISTORY_OPEN_KEY = "anchor.agent.historyOpen";

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function readHistoryOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function groupActivity(
  tabs: TerminalTabInfo[],
  agentActivity: Record<string, AgentActivityState>,
): { working: boolean; unread: boolean } {
  let working = false;
  let unread = false;
  for (const tab of tabs) {
    const state = agentActivity[tab.id];
    if (state === "working") working = true;
    if (state === "completed-unread") unread = true;
  }
  return { working, unread };
}

export function AgentSidebar() {
  const workgroups = useTerminalStore((s) => s.workgroups);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const tabs = useTerminalStore((s) => s.tabs);
  const tabWorkgroupById = useTerminalStore((s) => s.tabWorkgroupById);
  const parkedAgents = useTerminalStore((s) => s.parkedAgents);
  const activeTabId = useTerminalStore((s) => s.activeByMode.agent);
  const agentActivity = useTerminalStore((s) => s.agentActivity);
  const agentProfiles = useTerminalStore((s) => s.agentProfiles);
  const setActiveWorkgroup = useTerminalStore((s) => s.setActiveWorkgroup);
  const createWorkgroup = useTerminalStore((s) => s.createWorkgroup);
  const renameWorkgroup = useTerminalStore((s) => s.renameWorkgroup);
  const deleteWorkgroup = useTerminalStore((s) => s.deleteWorkgroup);
  const focusAgentTab = useTerminalStore((s) => s.focusAgentTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const createAgentTab = useTerminalStore((s) => s.createAgentTab);
  const resumeParkedAgent = useTerminalStore((s) => s.resumeParkedAgent);
  const loadAgentProfiles = useTerminalStore((s) => s.loadAgentProfiles);

  const liveSessionIds = useMemo(
    () =>
      new Set(
        tabs
          .filter(
            (tab) =>
              (tab.kind ?? "shell") === "agent" &&
              typeof tab.agentSessionId === "string" &&
              tab.agentSessionId.trim().length > 0,
          )
          .map((tab) => tab.agentSessionId!),
      ),
    [tabs],
  );

  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState("");
  const [creatingWorkgroup, setCreatingWorkgroup] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const createPopoverRef = useRef<HTMLDivElement>(null);
  const [pickingAgentGroupId, setPickingAgentGroupId] = useState<string | null>(null);
  const [openingProfileId, setOpeningProfileId] = useState<string | null>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpen);
  const [resumingId, setResumingId] = useState<string | null>(null);

  useEffect(() => {
    void loadAgentProfiles();
  }, [loadAgentProfiles]);

  useEffect(() => {
    if (!creatingWorkgroup) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        createPopoverRef.current &&
        !createPopoverRef.current.contains(event.target as Node)
      ) {
        setCreatingWorkgroup(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreatingWorkgroup(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [creatingWorkgroup]);

  useEffect(() => {
    if (!pickingAgentGroupId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        agentPickerRef.current &&
        !agentPickerRef.current.contains(event.target as Node)
      ) {
        setPickingAgentGroupId(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickingAgentGroupId(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickingAgentGroupId]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, historyOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [historyOpen]);

  const enabledProfiles = useMemo(
    () => agentProfiles.filter((profile) => profile.enabled !== false),
    [agentProfiles],
  );

  useEffect(() => {
    if (!historyOpen || !window.anchor?.agent?.listSessions) {
      if (!historyOpen) return;
      setHistory([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    void (async () => {
      const profiles =
        enabledProfiles.length > 0
          ? enabledProfiles
          : await window.anchor.agent.listProfiles();
      const usable = profiles.filter((profile) => profile.enabled !== false);
      const batches = await Promise.allSettled(
        usable.map(async (profile) => {
          const items = await window.anchor.agent.listSessions({
            profileId: profile.id,
            limit: 30,
          });
          return items.map((item) => ({
            ...item,
            profileId: profile.id,
            profileName: profile.name,
          }));
        }),
      );
      if (cancelled) return;
      const merged = batches.flatMap((batch) =>
        batch.status === "fulfilled" ? batch.value : [],
      );
      const unique = new Map<string, HistoryItem>();
      for (const item of merged) {
        unique.set(`${item.profileId}:${item.id}`, item);
      }
      setHistory(
        [...unique.values()].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      );
      const failed = batches.find((batch) => batch.status === "rejected");
      setHistoryError(
        unique.size === 0 && failed?.status === "rejected"
          ? failed.reason instanceof Error
            ? failed.reason.message
            : String(failed.reason)
          : null,
      );
      setHistoryLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabledProfiles, historyOpen]);

  const filteredHistory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return history.filter((item) => {
      if (liveSessionIds.has(item.id)) return false;
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.profileName.toLowerCase().includes(needle)
      );
    });
  }, [history, liveSessionIds, query]);

  const startRenameGroup = (group: AgentWorkgroup) => {
    setRenamingGroupId(group.id);
    setGroupDraft(group.name);
  };

  const openCreateWorkgroup = () => {
    setCreateDraft(uniqueWorkgroupName(workgroups));
    setCreatingWorkgroup(true);
  };

  const commitCreateWorkgroup = () => {
    const name = createDraft.trim();
    if (!name) return;
    createWorkgroup(name);
    setCreatingWorkgroup(false);
  };

  const commitRenameGroup = () => {
    if (renamingGroupId && groupDraft.trim()) {
      renameWorkgroup(renamingGroupId, groupDraft);
    }
    setRenamingGroupId(null);
  };

  const openNewConversation = (groupId: string) => {
    setActiveWorkgroup(groupId);
    setCreatingWorkgroup(false);
    setPickingAgentGroupId((current) => (current === groupId ? null : groupId));
    if (agentProfiles.length === 0) void loadAgentProfiles();
  };

  const startConversation = async (groupId: string, profile: AgentCliProfile) => {
    setActiveWorkgroup(groupId);
    setOpeningProfileId(profile.id);
    try {
      await createAgentTab(profile);
      setPickingAgentGroupId(null);
    } finally {
      setOpeningProfileId(null);
    }
  };

  const startRenameTab = (tab: TerminalTabInfo) => {
    setEditingTabId(tab.id);
    setTabDraft(tab.title);
  };

  const commitRenameTab = () => {
    if (editingTabId && tabDraft.trim()) {
      void renameTab(editingTabId, tabDraft.trim());
    }
    setEditingTabId(null);
  };

  const resumeHistory = useCallback(
    async (item: HistoryItem) => {
      const live = useTerminalStore
        .getState()
        .tabs.find(
          (tab) =>
            (tab.kind ?? "shell") === "agent" && tab.agentSessionId === item.id,
        );
      if (live) {
        focusAgentTab(live.id);
        return;
      }
      const profile =
        enabledProfiles.find((entry) => entry.id === item.profileId) ?? null;
      if (!profile) return;
      setResumingId(item.id);
      try {
        await createAgentTab(profile, {
          title: item.title,
          resumeSessionId: item.id,
        });
      } finally {
        setResumingId(null);
      }
    },
    [createAgentTab, enabledProfiles, focusAgentTab],
  );

  return (
    <div className="agent-sidebar">
      <div className="agent-sidebar__toolbar">
        <span className="agent-sidebar__label">Workgroups</span>
        <div className="agent-sidebar__create" ref={createPopoverRef}>
          <button
            type="button"
            className="agent-sidebar__create-btn"
            aria-label="New workgroup"
            title="New workgroup"
            aria-expanded={creatingWorkgroup}
            onClick={() => {
              if (creatingWorkgroup) setCreatingWorkgroup(false);
              else openCreateWorkgroup();
            }}
          >
            New
          </button>
          {creatingWorkgroup ? (
            <div className="agent-sidebar__create-pop" role="dialog" aria-label="Name workgroup">
              <label className="agent-sidebar__create-label" htmlFor="agent-workgroup-name">
                Name
              </label>
              <input
                id="agent-workgroup-name"
                className="agent-sidebar__create-input"
                value={createDraft}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setCreateDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitCreateWorkgroup();
                  }
                }}
              />
              <div className="agent-sidebar__create-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => setCreatingWorkgroup(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  disabled={!createDraft.trim()}
                  onClick={commitCreateWorkgroup}
                >
                  Create
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="agent-sidebar__groups">
        {workgroups.map((group) => {
          const groupTabs = agentTabsInWorkgroup(tabs, tabWorkgroupById, group.id);
          const parked = parkedAgents.filter((item) => item.groupId === group.id);
          const activity = groupActivity(groupTabs, agentActivity);
          const isCurrent = group.id === activeGroupId;
          return (
            <section
              key={group.id}
              className={`agent-workgroup${isCurrent ? " is-current" : ""}`}
            >
              <div className="agent-workgroup__head">
                {renamingGroupId === group.id ? (
                  <input
                    className="agent-sidebar__group-rename"
                    value={groupDraft}
                    autoFocus
                    aria-label="Workgroup name"
                    onChange={(event) => setGroupDraft(event.target.value)}
                    onBlur={commitRenameGroup}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRenameGroup();
                      } else if (event.key === "Escape") {
                        setRenamingGroupId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="agent-workgroup__title"
                    onClick={() => setActiveWorkgroup(group.id)}
                    onDoubleClick={() => startRenameGroup(group)}
                    title="Double-click to rename"
                  >
                    {activity.working || activity.unread ? (
                      <span
                        className={`terminal-session-rail__dot is-${
                          activity.working ? "working" : "completed-unread"
                        }`}
                      />
                    ) : null}
                    <span className="agent-workgroup__name">{group.name}</span>
                    <span className="agent-workgroup__count">
                      {groupTabs.length + parked.length}
                    </span>
                  </button>
                )}
                <div
                  className="agent-workgroup__picker"
                  ref={pickingAgentGroupId === group.id ? agentPickerRef : undefined}
                >
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`New conversation in ${group.name}`}
                    title="New conversation"
                    aria-expanded={pickingAgentGroupId === group.id}
                    onClick={() => openNewConversation(group.id)}
                  >
                    <Icon name="add" />
                  </button>
                  {pickingAgentGroupId === group.id ? (
                    <div
                      className="agent-workgroup__picker-pop"
                      role="listbox"
                      aria-label="Choose agent"
                    >
                      {enabledProfiles.length === 0 ? (
                        <p className="agent-workgroup__picker-empty muted">
                          No agents detected
                        </p>
                      ) : (
                        enabledProfiles.map((profile) => (
                          <button
                            key={profile.id}
                            type="button"
                            role="option"
                            className="agent-workgroup__picker-item"
                            disabled={openingProfileId !== null}
                            onClick={() => void startConversation(group.id, profile)}
                          >
                            {profile.name}
                            {openingProfileId === profile.id ? "…" : ""}
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
                {group.id !== DEFAULT_WORKGROUP_ID ? (
                  <button
                    type="button"
                    className="icon-btn agent-workgroup__delete"
                    aria-label={`Delete ${group.name}`}
                    title="Delete workgroup"
                    onClick={() => deleteWorkgroup(group.id)}
                  >
                    <Icon name="trash" />
                  </button>
                ) : null}
              </div>
              {groupTabs.length === 0 && parked.length === 0 ? (
                <p className="agent-sidebar__empty muted">No conversations</p>
              ) : (
                <ul className="agent-sidebar__list agent-workgroup__sessions">
                  {parked.map((item) => (
                    <li key={`parked:${item.sessionId}`} className="agent-sidebar__item">
                      <button
                        type="button"
                        className="agent-sidebar__row agent-sidebar__row--parked"
                        disabled={resumingId === item.sessionId}
                        onClick={() => {
                          setResumingId(item.sessionId);
                          void resumeParkedAgent(item.sessionId).finally(() => {
                            setResumingId((current) =>
                              current === item.sessionId ? null : current,
                            );
                          });
                        }}
                        title="Click title to resume"
                      >
                        <span className="agent-sidebar__row-title">{item.title}</span>
                        <span className="muted">
                          {resumingId === item.sessionId ? "resuming" : "saved"}
                        </span>
                      </button>
                    </li>
                  ))}
                  {groupTabs.map((tab) => (
                    <li key={tab.id} className="agent-sidebar__item">
                      {editingTabId === tab.id ? (
                        <input
                          className="agent-sidebar__rename"
                          value={tabDraft}
                          autoFocus
                          aria-label="Conversation title"
                          onChange={(event) => setTabDraft(event.target.value)}
                          onBlur={commitRenameTab}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRenameTab();
                            } else if (event.key === "Escape") {
                              setEditingTabId(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className={`agent-sidebar__row${
                            tab.id === activeTabId ? " is-active" : ""
                          }`}
                          onClick={() => focusAgentTab(tab.id)}
                          onDoubleClick={() => startRenameTab(tab)}
                          title="Double-click to rename"
                        >
                          {agentActivity[tab.id] &&
                          agentActivity[tab.id] !== "idle" ? (
                            <span
                              className={`terminal-session-rail__dot is-${agentActivity[tab.id]}`}
                            />
                          ) : null}
                          <span className="agent-sidebar__row-title">
                            {tab.title}
                          </span>
                          {tab.status === "exited" ? (
                            <span className="muted">exited</span>
                          ) : null}
                        </button>
                      )}
                      <button
                        type="button"
                        className="agent-sidebar__close"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => void closeTab(tab.id)}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <section
        className={`agent-sidebar__section agent-sidebar__section--history${
          historyOpen ? " is-open" : ""
        }`}
        aria-label="Session history"
      >
        <button
          type="button"
          className="agent-sidebar__history-toggle"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <Icon name={historyOpen ? "chevron-down" : "chevron-right"} />
          <span className="agent-sidebar__label">History</span>
        </button>
        {historyOpen ? (
          <>
            <div className="files-search agent-sidebar__search">
              <Icon name="search" className="files-search__icon" />
              <input
                className="files-search__input"
                value={query}
                placeholder="Search sessions"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {historyLoading ? (
              <p className="agent-sidebar__empty muted">Loading…</p>
            ) : filteredHistory.length === 0 ? (
              <p className="agent-sidebar__empty muted">
                {historyError ||
                  (query.trim() ? "No matching sessions" : "No resumable sessions")}
              </p>
            ) : (
              <ul className="agent-sidebar__list">
                {filteredHistory.map((item) => (
                  <li key={`${item.profileId}:${item.id}`}>
                    <button
                      type="button"
                      className="agent-sidebar__history"
                      disabled={resumingId === item.id}
                      onClick={() => void resumeHistory(item)}
                    >
                      <span className="agent-sidebar__row-title">{item.title}</span>
                      <span className="agent-sidebar__history-meta">
                        {item.profileName}
                        {item.updatedAt ? ` · ${formatSessionTime(item.updatedAt)}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
