import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCliProfile,
  AgentLaunchDiscovery,
} from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";

const LAST_PROFILE_KEY = "anchor.agent.lastProfileId";

function launchKey(profileId: string) {
  return `anchor.agent.launch.${profileId}`;
}

function readLastLaunch(profileId: string): {
  model?: string | null;
  effort?: string | null;
} {
  try {
    return JSON.parse(localStorage.getItem(launchKey(profileId)) || "{}") as {
      model?: string | null;
      effort?: string | null;
    };
  } catch {
    return {};
  }
}

export function NewAgentDialog({
  profiles,
  defaultAgentId,
  onOpen,
  onDetect,
  onClose,
}: {
  profiles: AgentCliProfile[];
  defaultAgentId: string | null;
  onOpen: (
    profile: AgentCliProfile,
    launch: { model?: string; effort?: string; title?: string },
  ) => void;
  onDetect: () => void;
  onClose: () => void;
}) {
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
    return enabled.find((p) => p.detected)?.id ?? enabled[0]?.id ?? "";
  }, [enabled, defaultAgentId]);

  const [task, setTask] = useState("");
  const [profileId, setProfileId] = useState(initialProfileId);
  const [discovery, setDiscovery] = useState<AgentLaunchDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [opening, setOpening] = useState(false);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  const profile = enabled.find((p) => p.id === profileId) ?? null;

  const applyDiscovery = (p: AgentCliProfile, d: AgentLaunchDiscovery) => {
    setDiscovery(d);
    const last = readLastLaunch(p.id);
    const modelIds = d.models.map((m) => m.id);
    const pickModel =
      (last.model && modelIds.includes(last.model) && last.model) ||
      (d.defaultModel && modelIds.includes(d.defaultModel)
        ? d.defaultModel
        : undefined) ||
      d.defaultModel ||
      d.models[0]?.id ||
      "";
    setModel(pickModel);
    const mod = d.models.find((m) => m.id === pickModel);
    const efforts = mod?.efforts ?? [];
    const pickEffort =
      (last.effort && efforts.includes(last.effort) && last.effort) ||
      (mod?.defaultEffort &&
        efforts.includes(mod.defaultEffort) &&
        mod.defaultEffort) ||
      (d.defaultEffort &&
        efforts.includes(d.defaultEffort) &&
        d.defaultEffort) ||
      efforts[0] ||
      "";
    setEffort(pickEffort);
  };

  const loadDiscovery = async (p: AgentCliProfile, force = false) => {
    // Disk/memory cache is the normal path — don't flash "Loading…" every open.
    // Only Refresh (force) shows the loading state.
    if (force) setLoading(true);
    try {
      const d = await window.anchor.agent.discoverLaunch({
        profileId: p.id,
        force,
      });
      applyDiscovery(p, d);
    } catch (err) {
      setDiscovery({
        profileId: p.id,
        supportsModel: false,
        supportsEffort: false,
        models: [],
        error: err instanceof Error ? err.message : String(err),
        source: "error",
      });
      setModel("");
      setEffort("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!profile) return;
    void loadDiscovery(profile, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when profile changes
  }, [profile?.id]);

  const effortOptions = useMemo(() => {
    if (!discovery) return [] as string[];
    const mod = discovery.models.find((m) => m.id === model);
    return mod?.efforts ?? [];
  }, [discovery, model]);

  const canOpen = !!profile && !opening;

  const submit = () => {
    if (!profile || opening) return;
    setOpening(true);
    onOpen(profile, {
      model: model || undefined,
      effort: effort || undefined,
      title: task.trim() || undefined,
    });
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
            New agent session
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
            onClick={submit}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
