import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentCliProfile, SkillInstallStatus } from "@/shared/anchor-api";
import { Dropdown } from "@/shared/Dropdown";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useShellStore } from "./shellStore";

function argsSummary(args: string[] | undefined): string {
  if (!args?.length) return "";
  return args.join(" ");
}

function profileCommandLine(p: AgentCliProfile): string {
  const args = argsSummary(p.args);
  return args ? `${p.command} ${args}` : p.command;
}

/**
 * Settings → Agent: default CLI, profile list, detect, and Anchor Review skill.
 */
export function SettingsAgentSection() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const agentProfiles = useTerminalStore((s) => s.agentProfiles);
  const defaultAgentId = useTerminalStore((s) => s.defaultAgentId);
  const loadAgentProfiles = useTerminalStore((s) => s.loadAgentProfiles);
  const detectAgents = useTerminalStore((s) => s.detectAgents);
  const addCustomAgent = useTerminalStore((s) => s.addCustomAgent);

  const [detectBusy, setDetectBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCommand, setAddCommand] = useState("");
  const [addArgs, setAddArgs] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const [skillStatus, setSkillStatus] = useState<SkillInstallStatus | null>(
    null,
  );
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillMessage, setSkillMessage] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<Record<string, true>>(
    {},
  );

  useEffect(() => {
    void loadAgentProfiles();
  }, [loadAgentProfiles]);

  const enabledProfiles = useMemo(
    () => agentProfiles.filter((p) => p.enabled !== false),
    [agentProfiles],
  );

  const defaultOptions = useMemo(
    () =>
      enabledProfiles.map((p) => ({
        value: p.id,
        label: p.name,
        textValue: p.name,
        hint: p.detected ? "Detected" : "Not found",
      })),
    [enabledProfiles],
  );

  const refreshSkillStatus = useCallback(async () => {
    if (!window.anchor?.skill?.status) return;
    try {
      const status = await window.anchor.skill.status({ workspaceRoot });
      setSkillStatus(status);
      const next: Record<string, true> = {};
      for (const t of status.targets) {
        if (!t.installed || !t.upToDate) next[t.id] = true;
      }
      if (Object.keys(next).length === 0) {
        for (const t of status.targets) next[t.id] = true;
      }
      setSelectedTargets(next);
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    setSkillMessage(null);
    setSkillError(null);
    void refreshSkillStatus();
  }, [refreshSkillStatus]);

  const runDetect = useCallback(async () => {
    setDetectBusy(true);
    setAgentError(null);
    try {
      await detectAgents();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetectBusy(false);
    }
  }, [detectAgents]);

  const setDefault = useCallback(async (id: string) => {
    setAgentError(null);
    try {
      await window.anchor.agent.setDefaultId(id);
      await useTerminalStore.getState().loadAgentProfiles();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleEnabled = useCallback(
    async (profile: AgentCliProfile, enabled: boolean) => {
      setAgentError(null);
      try {
        await window.anchor.agent.upsertProfile({ ...profile, enabled });
        await useTerminalStore.getState().loadAgentProfiles();
      } catch (err) {
        setAgentError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const beginEdit = useCallback((p: AgentCliProfile) => {
    setAdding(false);
    setEditingId(p.id);
    setEditName(p.name);
    setEditCommand(p.command);
    setEditArgs(argsSummary(p.args));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const existing = useTerminalStore
      .getState()
      .agentProfiles.find((p) => p.id === editingId);
    if (!existing) return;
    const command = editCommand.trim();
    if (!command) {
      setAgentError("Command is required.");
      return;
    }
    setEditBusy(true);
    setAgentError(null);
    try {
      const args = editArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await window.anchor.agent.upsertProfile({
        ...existing,
        name: editName.trim() || existing.name,
        command,
        args,
      });
      await useTerminalStore.getState().loadAgentProfiles();
      setEditingId(null);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }
  }, [editArgs, editCommand, editName, editingId]);

  const saveAdd = useCallback(async () => {
    const command = addCommand.trim();
    if (!command) {
      setAgentError("Command is required.");
      return;
    }
    setAddBusy(true);
    setAgentError(null);
    try {
      const args = addArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const created = await addCustomAgent({
        name: addName.trim() || command,
        command,
        args,
      });
      if (created) {
        setAdding(false);
        setAddName("");
        setAddCommand("");
        setAddArgs("");
      }
    } finally {
      setAddBusy(false);
    }
  }, [addArgs, addCommand, addCustomAgent, addName]);

  const runSkillInstall = useCallback(async () => {
    if (!window.anchor?.skill?.install) return;
    const targetIds = Object.keys(selectedTargets);
    if (targetIds.length === 0) {
      setSkillError("Select at least one install target.");
      return;
    }
    setSkillBusy(true);
    setSkillError(null);
    setSkillMessage(null);
    try {
      const result = await window.anchor.skill.install({
        workspaceRoot,
        targetIds,
      });
      if (!result.ok) {
        setSkillError(result.error ?? "Install failed");
      } else {
        const paths = result.installed.map((i) => i.skillPath).join(", ");
        setSkillMessage(
          `Installed ${result.installed.length} target(s): ${paths}`,
        );
        if (result.installed.some((i) => i.id === "workspace")) {
          useShellStore.getState().dismissSkillInstallPrompt();
        }
      }
      await refreshSkillStatus();
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillBusy(false);
    }
  }, [refreshSkillStatus, selectedTargets, workspaceRoot]);

  const defaultValue =
    defaultAgentId && enabledProfiles.some((p) => p.id === defaultAgentId)
      ? defaultAgentId
      : (enabledProfiles[0]?.id ?? "");

  return (
    <section className="settings-section" aria-label="Agent">
      <h3 className="settings-section__title">Default agent</h3>
      <p className="settings-section__desc muted">
        Used when starting a new agent session. Only enabled CLIs appear here.
      </p>
      <div className="settings-field-row">
        <Dropdown
          aria-label="Default agent"
          data-testid="settings-default-agent"
          value={defaultValue}
          disabled={!defaultOptions.length}
          placeholder="No enabled agents"
          options={defaultOptions}
          onChange={(id) => void setDefault(id)}
          className="settings-dropdown"
          minMenuWidth={240}
        />
      </div>

      <div className="settings-section__header-row settings-section__title--spaced">
        <h3 className="settings-section__title" style={{ margin: 0 }}>
          CLI profiles
        </h3>
        <button
          type="button"
          className="btn btn--small"
          data-testid="settings-detect-agents"
          disabled={detectBusy}
          onClick={() => void runDetect()}
        >
          {detectBusy ? "Detecting…" : "Detect"}
        </button>
      </div>
      <p className="settings-section__desc muted">
        Enable the coding CLIs you use. Detect probes the active host PATH.
      </p>

      <ul className="settings-agent-list" data-testid="settings-agent-list">
        {agentProfiles.map((p) => {
          const isDefault = p.id === defaultAgentId;
          const enabled = p.enabled !== false;
          const isEditing = editingId === p.id;
          return (
            <li
              key={p.id}
              className={`settings-agent-row${isDefault ? " is-default" : ""}${
                !enabled ? " is-disabled" : ""
              }`}
              data-testid={`settings-agent-row-${p.id}`}
            >
              <div className="settings-agent-row__main">
                <label className="settings-agent-row__enable">
                  <input
                    type="checkbox"
                    checked={enabled}
                    aria-label={`Enable ${p.name}`}
                    onChange={(e) =>
                      void toggleEnabled(p, e.target.checked)
                    }
                  />
                </label>
                <div className="settings-agent-row__meta">
                  <div className="settings-agent-row__title">
                    <span className="settings-agent-row__name">{p.name}</span>
                    {isDefault ? (
                      <span className="settings-agent-row__badge settings-agent-row__badge--default">
                        Default
                      </span>
                    ) : null}
                    <span
                      className={`settings-agent-row__badge${
                        p.detected
                          ? " settings-agent-row__badge--ok"
                          : " settings-agent-row__badge--muted"
                      }`}
                    >
                      {p.detected ? "Detected" : "Not found"}
                    </span>
                  </div>
                  <div className="settings-agent-row__cmd muted">
                    {profileCommandLine(p)}
                  </div>
                </div>
                <div className="settings-agent-row__actions">
                  {!isDefault && enabled ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void setDefault(p.id)}
                    >
                      Set default
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    aria-expanded={isEditing}
                    onClick={() =>
                      isEditing ? cancelEdit() : beginEdit(p)
                    }
                  >
                    {isEditing ? "Close" : "Edit"}
                  </button>
                </div>
              </div>

              {isEditing ? (
                <div className="settings-agent-edit">
                  <label className="settings-agent-edit__field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label className="settings-agent-edit__field">
                    <span>Command</span>
                    <input
                      type="text"
                      value={editCommand}
                      onChange={(e) => setEditCommand(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="settings-agent-edit__field">
                    <span>Args</span>
                    <input
                      type="text"
                      value={editArgs}
                      onChange={(e) => setEditArgs(e.target.value)}
                      placeholder="optional"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="settings-agent-edit__actions">
                    <button
                      type="button"
                      className="btn btn--accent btn--small"
                      disabled={editBusy}
                      onClick={() => void saveEdit()}
                    >
                      {editBusy ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={editBusy}
                      onClick={cancelEdit}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="settings-agent-edit settings-agent-edit--add">
          <label className="settings-agent-edit__field">
            <span>Name</span>
            <input
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="My agent"
              autoComplete="off"
            />
          </label>
          <label className="settings-agent-edit__field">
            <span>Command</span>
            <input
              type="text"
              value={addCommand}
              onChange={(e) => setAddCommand(e.target.value)}
              placeholder="my-cli"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="settings-agent-edit__field">
            <span>Args</span>
            <input
              type="text"
              value={addArgs}
              onChange={(e) => setAddArgs(e.target.value)}
              placeholder="optional"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="settings-agent-edit__actions">
            <button
              type="button"
              className="btn btn--accent btn--small"
              disabled={addBusy}
              onClick={() => void saveAdd()}
            >
              {addBusy ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={addBusy}
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--ghost btn--small settings-agent-add"
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        >
          Add custom CLI…
        </button>
      )}

      {agentError ? (
        <p className="settings-update-card__err" role="alert">
          {agentError}
        </p>
      ) : null}

      <h3 className="settings-section__title settings-section__title--spaced">
        Anchor Review skill
      </h3>
      <p className="settings-section__desc muted">
        Install the agent skill that teaches coding CLIs how to read{" "}
        <code>.anchor-code</code> session YAML, honor <code>need_modify</code>,
        and mark finished comments <code>closed</code>. Prefer workspace install
        so the skill travels with the repo; optional user homes install into
        detected agent skill directories on this host.
      </p>

      {!workspaceRoot ? (
        <p className="settings-update-card__hint">
          Open a workspace to enable workspace install. User-level targets still
          appear when agent homes exist on the host.
        </p>
      ) : null}

      {skillStatus?.targets?.length ? (
        <ul className="settings-skill-targets">
          {skillStatus.targets.map((t) => {
            const checked = Boolean(selectedTargets[t.id]);
            const statusLabel = t.installed
              ? t.upToDate
                ? "Installed · up to date"
                : "Installed · outdated"
              : "Not installed";
            return (
              <li key={t.id} className="settings-skill-target">
                <label className="settings-skill-target__label">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setSelectedTargets((prev) => {
                        const next = { ...prev };
                        if (next[t.id]) delete next[t.id];
                        else next[t.id] = true;
                        return next;
                      });
                    }}
                  />
                  <span className="settings-skill-target__meta">
                    <span className="settings-skill-target__name">
                      {t.label}
                    </span>
                    <span className="settings-skill-target__path muted">
                      {t.skillPath}
                    </span>
                    <span
                      className={`settings-skill-target__status${
                        t.installed && t.upToDate
                          ? " is-ok"
                          : t.installed
                            ? " is-stale"
                            : ""
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="settings-update-card__hint">
          No install targets found yet. Open a workspace, or ensure an agent
          skill home exists (for example <code>~/.codex</code> or{" "}
          <code>~/.claude</code>) on this host.
        </p>
      )}

      {skillMessage ? (
        <p className="settings-update-card__msg" role="status">
          {skillMessage}
        </p>
      ) : null}
      {skillError ? (
        <p className="settings-update-card__err" role="alert">
          {skillError}
        </p>
      ) : null}

      <div className="settings-update-card__actions">
        <button
          type="button"
          className="btn btn--accent btn--small"
          disabled={skillBusy || !skillStatus?.targets?.length}
          onClick={() => void runSkillInstall()}
        >
          {skillBusy ? "Installing…" : "Install selected"}
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={skillBusy}
          onClick={() => void refreshSkillStatus()}
        >
          Refresh status
        </button>
      </div>
    </section>
  );
}
