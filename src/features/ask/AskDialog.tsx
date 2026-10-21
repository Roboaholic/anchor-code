import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dropdown, isInsideDropdownMenu } from "@/shared/Dropdown";
import { Icon } from "@/shared/Icon";
import { useShellStore } from "@/features/shell/shellStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import {
  askDraftKey,
  askLineLabel,
  askPasteChunks,
  askPopoverPosition,
  askSessionLabel,
  buildAskPrompt,
  isAskSessionSelectable,
} from "./askPrompt";
import { useAskStore } from "./askStore";

const NEW_PREFIX = "new:";

function revealAgentRail() {
  const shell = useShellStore.getState();
  if (shell.leftMode !== "agent") shell.setAgentVisible(true);
}

const POPOVER_WIDTH = 420;
const MAX_TEXTAREA_PX = 200;

/**
 * Anchored popover (no backdrop) for a one-off question about a selection.
 * The answer lives in the Agent workspace. Drafts are kept per selection.
 */
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

  const drafts = useAskStore((s) => s.drafts);
  const setDraft = useAskStore((s) => s.setDraft);
  const clearDraft = useAskStore((s) => s.clearDraft);
  const draftKey = context ? askDraftKey(context) : "";
  const question = drafts[draftKey] ?? "";
  const setQuestion = (text: string) => setDraft(draftKey, text);
  const popRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: string } | null>(null);
  const [readOnly, setReadOnly] = useState(true);
  const [target, setTarget] = useState("");
  const dismissRef = useRef<() => void>(() => {});
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
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(null);
    setSending(false);
    setReadOnly(true);
    void loadAgentProfiles();
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [context, loadAgentProfiles]);

  const dismiss = () => {
    close();
    const prev = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (prev && document.contains(prev)) prev.focus();
  };

  // Auto-grow the textarea (2 rows min, capped).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [question, context]);

  // Position below the anchor line, flip above when needed; re-measure on growth.
  useLayoutEffect(() => {
    if (!context) return;
    const el = popRef.current;
    if (!el) return;
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const anchor = context.anchor ?? {
      top: vp.height / 3,
      bottom: vp.height / 3,
      left: (vp.width - POPOVER_WIDTH) / 2,
    };
    const next = askPopoverPosition(
      anchor,
      { width: el.offsetWidth || POPOVER_WIDTH, height: el.offsetHeight },
      vp,
    );
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.placement === next.placement
        ? prev
        : next,
    );
  }, [context, question, error]);

  // Click outside, wheel-scrolling the content underneath, or resizing closes
  // (draft kept). Deliberately NOT generic `scroll` events: Monaco fires them on
  // its hidden textarea / scrollables during normal rendering (e.g. right as the
  // selection toolbar unmounts), which closed the popover the instant it opened.
  useEffect(() => {
    if (!context) return;
    const inside = (t: EventTarget | null) =>
      (t instanceof Node && !!popRef.current?.contains(t)) || isInsideDropdownMenu(t);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) dismissRef.current();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) dismissRef.current();
    };
    const onResize = () => dismissRef.current();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("wheel", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [context]);

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

  dismissRef.current = dismiss;

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
        const base = context.path.split(/[\\/]/).pop() || context.path;
        const ok = await store.createAgentTab(profile, {
          prompt,
          readOnly,
          title: `Ask · ${base} ${askLineLabel(context)}`,
        });
        if (!ok) throw new Error(store.error ?? "Could not start agent session");
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
      clearDraft(askDraftKey(context));
      revealAgentRail();
      dismiss();
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const fileName = context.path.split(/[\\/]/).pop() || context.path;
  const profileName = (id?: string) =>
    profiles.find((p) => p.id === id)?.name || id;

  return (
    <div
      ref={popRef}
      className={`ask-pop ask-pop--${pos?.placement ?? "below"}`}
      role="dialog"
      aria-modal="false"
      aria-label={`Ask agent about ${fileName} ${askLineLabel(context)}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="ask-pop__head">
        <span
          className="ask-pop__loc"
          title={
            context.diff
              ? `${context.path}\nbase ${context.diff.base} → head ${context.diff.head}`
              : context.path
          }
        >
          <span className="ask-pop__file">{fileName}</span>{" "}
          <span className="ask-pop__lines">{askLineLabel(context)}</span>
          {context.diff ? <span className="ask-pop__diff"> · diff</span> : null}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          onClick={dismiss}
        >
          <Icon name="close" />
        </button>
      </div>

      <textarea
        ref={inputRef}
        className="ask-pop__question"
        aria-label="Question about the selection"
        placeholder="Ask about this selection… (Ctrl/⌘+Enter to send)"
        value={question}
        rows={2}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error ? (
        <p className="pane-hint pane-hint--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ask-pop__footer">
        <Dropdown
          className="ask-pop__target"
          menuClassName="ask-pop__target-menu"
          size="sm"
          aria-label="Agent session"
          value={target}
          onChange={setTarget}
          placeholder="No agents"
          minMenuWidth={200}
          groups={[
            ...(groupSessions.length > 0
              ? [
                  {
                    label: "Sessions in this group",
                    options: groupSessions.map((t, i) => ({
                      value: t.id,
                      label: askSessionLabel(t, i, activity[t.id], profileName(t.agentId)),
                      disabled: !isAskSessionSelectable(t, activity[t.id]),
                      title: t.title,
                    })),
                  },
                ]
              : []),
            {
              label: "New session",
              options: enabledProfiles.map((p) => ({
                value: `${NEW_PREFIX}${p.id}`,
                label: `+ New ${p.name || p.id}`,
              })),
            },
          ]}
        />
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
            className="anchor-checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read-only
        </label>
        <div className="agent-new__footer-spacer" />
        <button type="button" className="btn btn--ghost" onClick={dismiss}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSend}
          title="Ctrl/⌘+Enter"
          onClick={() => void send()}
        >
          {sending ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
