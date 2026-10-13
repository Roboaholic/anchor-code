import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/shared/Icon";
import { useShellStore } from "@/features/shell/shellStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import {
  askLineLabel,
  askPasteChunks,
  buildAskPrompt,
  isAskSessionSelectable,
} from "./askPrompt";
import { useAskStore } from "./askStore";

const NEW_PREFIX = "new:";

function revealAgentRail() {
  const shell = useShellStore.getState();
  if (shell.leftMode !== "agent") shell.setAgentVisible(true);
}

/** Ask a one-off question about a selection; answer lives in the Agent workspace. */
export function AskDialog() {
  const context = useAskStore((s) => s.context);
  const close = useAskStore((s) => s.close);
  const tabs = useTerminalStore((s) => s.tabs);
  const activity = useTerminalStore((s) => s.agentActivity);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const tabGroup = useTerminalStore((s) => s.tabWorkgroupById);
  const activeAgent = useTerminalStore((s) => s.activeByMode.agent);
  const profiles = useTerminalStore((s) => s.agentProfiles);
  const defaultAgentId = useTerminalStore((s) => s.defaultAgentId);
  const loadAgentProfiles = useTerminalStore((s) => s.loadAgentProfiles);

  const [question, setQuestion] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [target, setTarget] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const enabledProfiles = useMemo(
    () => profiles.filter((p) => p.enabled !== false),
    [profiles],
  );
  const groupSessions = useMemo(
    () =>
      tabs.filter(
        (t) =>
          (t.kind ?? "shell") === "agent" &&
          (tabGroup[t.id] ?? activeGroupId) === activeGroupId,
      ),
    [tabs, tabGroup, activeGroupId],
  );

  useEffect(() => {
    if (!context) return;
    setQuestion("");
    setError(null);
    setSending(false);
    setReadOnly(true);
    void loadAgentProfiles();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [context, loadAgentProfiles]);

  // Default target: active idle session in this group, else new session with default CLI.
  useEffect(() => {
    if (!context) return;
    const st = useTerminalStore.getState();
    const active = groupSessions.find((t) => t.id === activeAgent);
    if (active && isAskSessionSelectable(active, st.agentActivity[active.id])) {
      setTarget(active.id);
      return;
    }
    const idle = groupSessions.find((t) =>
      isAskSessionSelectable(t, st.agentActivity[t.id]),
    );
    if (idle) {
      setTarget(idle.id);
      return;
    }
    const prof =
      enabledProfiles.find((p) => p.id === defaultAgentId) ?? enabledProfiles[0];
    setTarget(prof ? `${NEW_PREFIX}${prof.id}` : "");
    // Only when the dialog (re)opens or profiles first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, enabledProfiles.length]);

  if (!context) return null;

  const isNew = target.startsWith(NEW_PREFIX);
  const targetTab = isNew ? null : groupSessions.find((t) => t.id === target);
  const targetSelectable = targetTab
    ? isAskSessionSelectable(targetTab, activity[targetTab.id])
    : false;
  const canSend =
    !!question.trim() && !sending && (isNew ? !!target : targetSelectable);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const prompt = buildAskPrompt({ context, question, readOnly });
    try {
      const store = useTerminalStore.getState();
      if (isNew) {
        const profileId = target.slice(NEW_PREFIX.length);
        const profile = store.agentProfiles.find((p) => p.id === profileId);
        if (!profile) throw new Error(`Agent profile not found: ${profileId}`);
        const ok = await store.createAgentTab(profile, { prompt, readOnly });
        if (!ok) throw new Error(store.error ?? "Could not start agent session");
        const created = useTerminalStore.getState().activeByMode.agent;
        if (created) {
          const base = context.path.split(/[\\/]/).pop() || context.path;
          void store.renameTab(created, `Ask · ${base} ${askLineLabel(context)}`);
        }
      } else if (targetTab) {
        // Re-check at send time: session may have started working meanwhile.
        if (!isAskSessionSelectable(targetTab, store.agentActivity[targetTab.id])) {
          throw new Error("That session is busy. Pick an idle session or start a new one.");
        }
        const [paste, submit] = askPasteChunks(prompt);
        store.write(targetTab.id, paste);
        await new Promise((r) => window.setTimeout(r, 80));
        store.write(targetTab.id, submit);
        store.markAgentWorking(targetTab.id);
        store.focusAgentTab(targetTab.id);
      }
      revealAgentRail();
      close();
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal modal--ask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-agent-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="modal__header">
          <h2 id="ask-agent-title" className="modal__title">
            Ask agent
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>

        <div className="ask__context" aria-label="Selection context">
          <div className="ask__context-meta">
            <span className="ask__path" title={context.path}>
              {context.path}
            </span>
            <span className="ask__lines">{askLineLabel(context)}</span>
          </div>
          {context.diff ? (
            <div className="ask__context-meta ask__context-meta--diff">
              {context.diff.branch ? <span>branch {context.diff.branch}</span> : null}
              <span>base {context.diff.base}</span>
              <span>head {context.diff.head}</span>
            </div>
          ) : null}
          <pre className="ask__snippet">{context.snippet}</pre>
        </div>

        <textarea
          ref={inputRef}
          className="ask__question"
          placeholder="Ask a question about this selection…"
          value={question}
          rows={4}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error ? <p className="pane-hint pane-hint--error">{error}</p> : null}

        <div className="modal__footer">
          <select
            className="agent-new__select ask__target"
            aria-label="Agent session"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {groupSessions.length > 0 ? (
              <optgroup label="Sessions in this group">
                {groupSessions.map((t) => {
                  const ok = isAskSessionSelectable(t, activity[t.id]);
                  return (
                    <option key={t.id} value={t.id} disabled={!ok}>
                      {t.title}
                      {ok ? "" : t.status === "exited" ? " (exited)" : " (busy)"}
                    </option>
                  );
                })}
              </optgroup>
            ) : null}
            <optgroup label="+ New session">
              {enabledProfiles.map((p) => (
                <option key={p.id} value={`${NEW_PREFIX}${p.id}`}>
                  + New {p.name || p.id}
                </option>
              ))}
            </optgroup>
          </select>
          <label
            className="ask__readonly"
            title={
              isNew
                ? "Launch with the CLI's read-only / plan mode when supported"
                : "Existing session: adds a read-only instruction to the prompt"
            }
          >
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            Read-only
          </label>
          <div className="agent-new__footer-spacer" />
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSend}
            onClick={() => void send()}
          >
            {sending ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}
