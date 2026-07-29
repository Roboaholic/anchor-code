import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCliProfile,
  AgentLaunchDiscovery,
} from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import {
  agentAuthorFromProfile,
  buildFeedbackPrompt,
  feedbackTabTitle,
  isAnchorReviewInstalled,
} from "@/features/annotations/feedbackPrompt";
import type { AgentLaunchOptions, AgentMenuIntent } from "./terminalStore";

const LAST_PROFILE_KEY = "anchor.agent.lastProfileId";

function launchKey(profileId: string) {
  return `anchor.agent.launch.${profileId}`;
}

function readLastLaunch(profileId: string): {
  model?: string | null;
  effort?: string | null;
} {
  try {
    const raw = localStorage.getItem(launchKey(profileId));
    if (!raw) return {};
    return JSON.parse(raw) as { model?: string | null; effort?: string | null };
  } catch {
    return {};
  }
}

export function NewAgentDialog({
  profiles,
  defaultAgentId,
  intent = { kind: "new" },
  onOpen,
  onDetect,
  onClose,
}: {
  profiles: AgentCliProfile[];
  defaultAgentId: string | null;
  intent?: AgentMenuIntent;
  onOpen: (profile: AgentCliProfile, launch: AgentLaunchOptions) => void;
  onDetect: () => void;
  onClose: () => void;
}) {
  const isFeedback = intent.kind === "feedback";
  const enabled = useMemo(
    () => profiles.filter((p) => p.enabled !== false),
    [profiles],
  );

  const initialProfileId = useMemo(() => {
    try {
      const last = localStorage.getItem(LAST_PROFILE_KEY);
      if (last && enabled.some((p) => p.id === last)) return last;
    } catch {
      // ignore
    }
    if (defaultAgentId && enabled.some((p) => p.id === defaultAgentId)) {
      return defaultAgentId;
    }
    return enabled[0]?.id ?? "";
  }, [enabled, defaultAgentId]);

  const [task, setTask] = useState("");
  const [notes, setNotes] = useState("");
  const [profileId, setProfileId] = useState(initialProfileId);
  const [discovery, setDiscovery] = useState<AgentLaunchDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [opening, setOpening] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillInstalling, setSkillInstalling] = useState(false);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const profile = enabled.find((p) => p.id === profileId) ?? null;

  const applyDiscovery = (p: AgentCliProfile, d: AgentLaunchDiscovery) => {
    setDiscovery(d);
    const last = readLastLaunch(p.id);
    const models = d.models ?? [];
    const preferredModel =
      (last.model && models.some((m) => m.id === last.model) && last.model) ||
      d.defaultModel ||
      models[0]?.id ||
      "";
    setModel(preferredModel);
    const mod = models.find((m) => m.id === preferredModel);
    const efforts = mod?.efforts ?? [];
    const preferredEffort =
      (last.effort && efforts.includes(last.effort) && last.effort) ||
      mod?.defaultEffort ||
      d.defaultEffort ||
      efforts[0] ||
      "";
    setEffort(preferredEffort);
  };

  const loadDiscovery = async (p: AgentCliProfile, force = false) => {
    if (!window.anchor?.agent?.discoverLaunch) {
      setDiscovery(null);
      return;
    }
    setLoading(true);
    try {
      const d = await window.anchor.agent.discoverLaunch({
        profileId: p.id,
        force,
      });
      applyDiscovery(p, d);
    } catch {
      setDiscovery(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isFeedback) notesRef.current?.focus();
    else taskRef.current?.focus();
  }, [isFeedback]);

  useEffect(() => {
    if (!profile) return;
    void loadDiscovery(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when profile id changes
  }, [profile?.id]);

  const effortOptions = useMemo(() => {
    if (!discovery) return [];
    const mod = discovery.models.find((m) => m.id === model);
    return mod?.efforts ?? [];
  }, [discovery, model]);

  const canOpen = !!profile && !opening && !skillInstalling;

  const submit = async () => {
    if (!profile || opening || skillInstalling) return;
    setOpening(true);
    setSkillError(null);

    if (intent.kind === "feedback") {
      try {
        if (window.anchor?.skill?.isWorkspaceInstalled) {
          const root =
            (await window.anchor.host.getInfo()).workspaceRoot ?? null;
          const installed = root
            ? await window.anchor.skill.isWorkspaceInstalled(root)
            : false;
          // Fall back to any installed target if workspace skill is missing.
          if (!installed && window.anchor.skill.status) {
            const status = await window.anchor.skill.status({
              workspaceRoot: root,
            });
            if (!isAnchorReviewInstalled(status)) {
              setOpening(false);
              setSkillError(
                "Install the Anchor Review skill first, then start feedback.",
              );
              return;
            }
          } else if (!installed) {
            setOpening(false);
            setSkillError(
              "Install the Anchor Review skill first, then start feedback.",
            );
            return;
          }
        }
        const prompt = buildFeedbackPrompt({
          yamlPath: intent.yamlPath,
          exportPath: intent.exportPath,
          additionalNotes: notes,
          agentAuthor: agentAuthorFromProfile(profile),
        });
        onOpen(profile, {
          model: model || undefined,
          effort: effort || undefined,
          title: feedbackTabTitle(intent.sessionTitle),
          prompt,
        });
      } catch (err) {
        setOpening(false);
        setSkillError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    onOpen(profile, {
      model: model || undefined,
      effort: effort || undefined,
      title: task.trim() || undefined,
    });
  };

  const installSkillFromDialog = async () => {
    if (!window.anchor?.skill?.installWorkspace || skillInstalling) return;
    setSkillInstalling(true);
    setSkillError(null);
    try {
      const root =
        (await window.anchor.host.getInfo()).workspaceRoot ?? undefined;
      if (!root) {
        setSkillError("Open a workspace first");
        return;
      }
      const result = await window.anchor.skill.installWorkspace(root);
      if (!result.ok) {
        setSkillError(result.error ?? "Install failed");
        return;
      }
      setSkillError(null);
      await submit();
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillInstalling(false);
    }
  };


  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal--agent-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-agent-title"
      >
        <div className="modal__header">
          <h2 id="new-agent-title" className="modal__title">
            {isFeedback ? "Feedback to agent" : "New agent session"}
          </h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>

        {isFeedback && intent.kind === "feedback" ? (
          <div className="agent-new__feedback-summary" aria-live="polite">
            <div className="agent-new__feedback-row">
              <span className="agent-new__label">Session</span>
              <span className="agent-new__feedback-value" title={intent.sessionTitle}>
                {intent.sessionTitle}
              </span>
            </div>
            <div className="agent-new__feedback-row">
              <span className="agent-new__label">Open comments</span>
              <span className="agent-new__feedback-value">
                {intent.openCount}
                {intent.needModifyCount > 0
                  ? ` · ${intent.needModifyCount} need modify`
                  : ""}
              </span>
            </div>
          </div>
        ) : (
          <label className="agent-new__field agent-new__task">
            <span className="agent-new__label">Task</span>
            <textarea
              ref={taskRef}
              className="agent-new__textarea"
              rows={3}
              placeholder="What should this session work on? (used as the session title)"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        )}

        {isFeedback ? (
          <label className="agent-new__field agent-new__task">
            <span className="agent-new__label">Additional notes (optional)</span>
            <textarea
              ref={notesRef}
              className="agent-new__textarea"
              rows={2}
              placeholder="Optional focus for the agent (shown only as an extra note)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        ) : null}

        <div className="agent-new__grid">
          <label className="agent-new__field">
            <span className="agent-new__label">Agent</span>
            <select
              className="agent-new__select"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              disabled={enabled.length === 0}
            >
              {enabled.length === 0 ? (
                <option value="">No agents detected</option>
              ) : (
                enabled.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.detected ? "" : " (?)"}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="agent-new__field">
            <span className="agent-new__label">Model</span>
            <select
              className="agent-new__select"
              value={model}
              disabled={loading || !discovery?.models.length}
              onChange={(e) => {
                const next = e.target.value;
                setModel(next);
                const mod = discovery?.models.find((m) => m.id === next);
                const efforts = mod?.efforts ?? [];
                if (!effort || !efforts.includes(effort)) {
                  setEffort(
                    mod?.defaultEffort ||
                      discovery?.defaultEffort ||
                      efforts[0] ||
                      "",
                  );
                }
              }}
            >
              {loading ? (
                <option value="">Loading…</option>
              ) : discovery?.models.length ? (
                discovery.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))
              ) : (
                <option value="">CLI default</option>
              )}
            </select>
          </label>

          <label className="agent-new__field">
            <span className="agent-new__label">Effort</span>
            <select
              className="agent-new__select"
              value={effort}
              disabled={loading || effortOptions.length === 0}
              onChange={(e) => setEffort(e.target.value)}
            >
              {effortOptions.length === 0 ? (
                <option value="">—</option>
              ) : (
                effortOptions.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>

        <div className="agent-new__meta muted">
          {loading
            ? "Reading model / effort from host…"
            : discovery
              ? `${discovery.cached ? "cached · " : ""}from ${discovery.source ?? "host"}${
                  discovery.defaultModel
                    ? ` · config ${discovery.defaultModel}`
                    : ""
                }${discovery.defaultEffort ? ` / ${discovery.defaultEffort}` : ""}`
              : "Select an agent"}
          {discovery?.error ? ` · ${discovery.error}` : ""}
        </div>

        {skillError ? (
          <div className="agent-new__skill-error" role="alert">
            <p className="modal__error">{skillError}</p>
            {isFeedback ? (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={skillInstalling}
                onClick={() => void installSkillFromDialog()}
              >
                {skillInstalling ? "Installing…" : "Install skill & start"}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="modal__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => profile && void loadDiscovery(profile, true)}
            disabled={!profile || loading}
          >
            Refresh
          </button>
          <button type="button" className="btn btn--ghost" onClick={onDetect}>
            Detect CLIs
          </button>
          <div className="agent-new__footer-spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canOpen}
            onClick={() => void submit()}
          >
            {isFeedback
              ? opening
                ? "Starting…"
                : "Start feedback"
              : opening
                ? "Opening…"
                : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
