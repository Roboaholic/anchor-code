import { useCallback, useEffect, useMemo, useState } from "react";
import { useSmoothScrollStore } from "./smoothScrollStore";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_UI_SCALE,
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_PRESETS,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
} from "@/core/theme/theme";
import { Icon } from "@/shared/Icon";
import { formatError } from "@/shared/formatError";
import { Switch } from "@/shared/Switch";
import { Dropdown } from "@/shared/Dropdown";
import type {
  AppUpdateState,
  SessionTabLayout,
} from "@/shared/anchor-api";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";
import { SettingsAgentSection } from "./SettingsAgentSection";
import { SettingsExperimentalSection } from "./SettingsExperimentalSection";
import { SettingsThemeSection } from "./SettingsThemeSection";

const LAYOUT_OPTIONS: Array<{
  id: SessionTabLayout;
  label: string;
  description: string;
}> = [
  {
    id: "side",
    label: "Side",
    description: "Session tabs as a vertical rail (default).",
  },
  {
    id: "top",
    label: "Top",
    description: "Session tabs as a horizontal strip above the terminal.",
  },
];

type SettingsSection =
  | "appearance"
  | "theme"
  | "agent"
  | "updates"
  | "experimental";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "theme", label: "Theme" },
  { id: "agent", label: "Agent" },
  { id: "updates", label: "Updates" },
  { id: "experimental", label: "Experimental" },
];

const FONT_CUSTOM = "__custom__";

/**
 * Floating settings dialog (modal). Controlled by themeStore.settingsOpen.
 */
export function SettingsPanel() {
  const open = useThemeStore((s) => s.settingsOpen);
  const setSettingsOpen = useThemeStore((s) => s.setSettingsOpen);
  const settingsFocusSection = useThemeStore((s) => s.settingsFocusSection);
  const sessionTabLayout = useThemeStore((s) => s.sessionTabLayout);
  const setSessionTabLayout = useThemeStore((s) => s.setSessionTabLayout);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const editorFontFamily = useThemeStore((s) => s.editorFontFamily);
  const setEditorFontFamily = useThemeStore((s) => s.setEditorFontFamily);
  const lineHeight = useThemeStore((s) => s.lineHeight);
  const setLineHeight = useThemeStore((s) => s.setLineHeight);
  const uiScale = useThemeStore((s) => s.uiScale);
  const setUiScale = useThemeStore((s) => s.setUiScale);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [update, setUpdate] = useState<AppUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [customFontDraft, setCustomFontDraft] = useState(editorFontFamily);
  const [forceCustomFont, setForceCustomFont] = useState(false);
  const onClose = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);
  const [restoreLastWorkspace, setRestoreLastWorkspaceState] = useState(true);
  const smoothScrollEnabled = useSmoothScrollStore((s) => s.enabled);
  const reducedMotion = useSmoothScrollStore((s) => s.reducedMotion);
  const setSmoothScrollEnabled = useSmoothScrollStore((s) => s.setEnabled);

  useEffect(() => {
    if (!open || !window.anchor?.settings?.getRestoreLastWorkspace) return;
    let cancelled = false;
    void window.anchor.settings
      .getRestoreLastWorkspace()
      .then((value) => {
        if (!cancelled) setRestoreLastWorkspaceState(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    if (
      settingsFocusSection === "appearance" ||
      settingsFocusSection === "theme" ||
      settingsFocusSection === "updates" ||
      settingsFocusSection === "experimental"
    ) {
      setSection(settingsFocusSection);
    } else if (
      settingsFocusSection === "agent" ||
      settingsFocusSection === "agent-skill"
    ) {
      setSection("agent");
    }
  }, [open, settingsFocusSection]);

  useEffect(() => {
    setCustomFontDraft(editorFontFamily);
    if (EDITOR_FONT_PRESETS.some((p) => p.value === editorFontFamily)) {
      setForceCustomFont(false);
    }
  }, [editorFontFamily]);

  const matchedFontPresetId = useMemo(() => {
    const match = EDITOR_FONT_PRESETS.find((p) => p.value === editorFontFamily);
    return match?.id ?? null;
  }, [editorFontFamily]);

  const fontPresetValue =
    forceCustomFont || !matchedFontPresetId ? FONT_CUSTOM : matchedFontPresetId;

  const fontOptions = useMemo(
    () => [
      ...EDITOR_FONT_PRESETS.map((p) => ({
        value: p.id,
        label: p.label,
        textValue: p.label,
        hint: p.id === "default" ? "SF Mono / JetBrains" : undefined,
      })),
      { value: FONT_CUSTOM, label: "Custom…", textValue: "Custom" },
    ],
    [],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.anchor?.updates?.getState?.().then((s) => {
      if (!cancelled) setUpdate(s);
    });
    const off = window.anchor?.updates?.onState?.((s) => setUpdate(s));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [open]);

  const runCheck = useCallback(async () => {
    if (!window.anchor?.updates?.check) return;
    setUpdateBusy(true);
    try {
      setUpdate(await window.anchor.updates.check());
    } catch (err) {
      setUpdate((prev) => ({
        status: "error",
        currentVersion: prev?.currentVersion ?? "?",
        latestVersion: prev?.latestVersion ?? null,
        releaseUrl: prev?.releaseUrl ?? null,
        canInstall: false,
        packaged: prev?.packaged ?? false,
        progress: null,
        message: null,
        error: formatError(err),
      }));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  // Open Settings → Updates: reuse main-process state when an update is already
  // known (badge / background poll). Only auto-check when we don't have an
  // actionable status yet — avoids forcing another "Check for updates" cycle
  // that hides Download and can fail when the prior "available" came from the
  // GitHub API fallback without electron-updater metadata.
  useEffect(() => {
    if (!open || section !== "updates") return;
    let cancelled = false;
    void (async () => {
      const s = await window.anchor?.updates?.getState?.().catch(() => null);
      if (cancelled) return;
      if (s) setUpdate(s);
      if (
        s &&
        (s.status === "available" ||
          s.status === "downloaded" ||
          s.status === "downloading" ||
          s.status === "checking")
      ) {
        return;
      }
      await runCheck();
    })();
    return () => {
      cancelled = true;
    };
  }, [open, section, runCheck]);

  const runDownload = useCallback(async () => {
    if (!window.anchor?.updates?.download) return;
    setUpdateBusy(true);
    try {
      setUpdate(await window.anchor.updates.download());
    } catch (err) {
      setUpdate((prev) =>
        prev
          ? {
              ...prev,
              status: "error",
              error: formatError(err),
            }
          : prev,
      );
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const runInstall = useCallback(async () => {
    if (!window.anchor?.updates?.install) return;
    setUpdateBusy(true);
    try {
      const r = await window.anchor.updates.install();
      if (!r.ok) {
        setUpdate((prev) =>
          prev
            ? { ...prev, status: "error", error: r.error ?? "Install failed" }
            : prev,
        );
      }
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  if (!open) return null;

  const currentVer =
    update?.currentVersion ??
    versionLabel?.replace(/^v/, "").split(" ·")[0] ??
    "—";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id="settings-title" className="modal__title">
            Settings
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-modal__layout">
          <nav className="settings-modal__nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-modal__nav-item${
                  section === s.id ? " is-active" : ""
                }`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-modal__main">
            {section === "appearance" ? (
              <section className="settings-section" aria-label="Appearance">
                <h3 className="settings-section__title">Startup</h3>
                <label className="settings-checkbox">
                  <Switch
                    checked={restoreLastWorkspace}
                    disabled={!window.anchor?.settings?.setRestoreLastWorkspace}
                    aria-label="Reopen last workspace on launch"
                    onChange={(next) => {
                      setRestoreLastWorkspaceState(next);
                      void window.anchor.settings
                        .setRestoreLastWorkspace(next)
                        .then(setRestoreLastWorkspaceState)
                        .catch(() => setRestoreLastWorkspaceState(!next));
                    }}
                  />
                  <span>Reopen last workspace on launch</span>
                </label>
                <p className="settings-section__desc muted">
                  Falls back to the Welcome page if the folder, WSL distro, or
                  SSH host is unavailable.
                </p>
                <h3 className="settings-section__title">Scrolling</h3>
                <label className="settings-checkbox">
                  <Switch
                    data-testid="smooth-scrolling-toggle"
                    checked={smoothScrollEnabled && !reducedMotion}
                    disabled={reducedMotion}
                    aria-label="Smooth scrolling"
                    onChange={setSmoothScrollEnabled}
                  />
                  <span>Smooth scrolling</span>
                </label>
                <p className="settings-section__desc muted">
                  {reducedMotion
                    ? "Off because the system asks for reduced motion."
                    : "Animates scrolling in editors, diffs, the terminal (wheel only) and sidebars."}
                </p>
                <h3 className="settings-section__title">Font size</h3>
                <p className="settings-section__desc muted">
                  Editor, Markdown, and terminal reading size. Default{" "}
                  {DEFAULT_FONT_SIZE}px.
                </p>
                <div
                  className="settings-font-size"
                  role="group"
                  aria-label="Font size"
                >
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Smaller"
                    aria-label="Decrease font size"
                    disabled={fontSize <= MIN_FONT_SIZE}
                    onClick={() => void setFontSize(fontSize - 1)}
                  >
                    <Icon name="remove" />
                  </button>
                  <input
                    className="settings-font-size__range"
                    type="range"
                    min={MIN_FONT_SIZE}
                    max={MAX_FONT_SIZE}
                    step={1}
                    value={fontSize}
                    onChange={(e) =>
                      void setFontSize(Number.parseInt(e.target.value, 10))
                    }
                    aria-valuemin={MIN_FONT_SIZE}
                    aria-valuemax={MAX_FONT_SIZE}
                    aria-valuenow={fontSize}
                    aria-label="Font size in pixels"
                  />
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Larger"
                    aria-label="Increase font size"
                    disabled={fontSize >= MAX_FONT_SIZE}
                    onClick={() => void setFontSize(fontSize + 1)}
                  >
                    <Icon name="add" />
                  </button>
                  <span className="settings-font-size__value" aria-live="polite">
                    {fontSize}px
                  </span>
                  {fontSize !== DEFAULT_FONT_SIZE ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void setFontSize(DEFAULT_FONT_SIZE)}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>

                <h3 className="settings-section__title settings-section__title--spaced">
                  Font family
                </h3>
                <p className="settings-section__desc muted">
                  Monospace stack for the editor, diffs, and terminal.
                </p>
                <div className="settings-field-row">
                  <Dropdown
                    aria-label="Font family"
                    data-testid="settings-font-family"
                    value={fontPresetValue}
                    options={fontOptions}
                    onChange={(id) => {
                      if (id === FONT_CUSTOM) {
                        setForceCustomFont(true);
                        setCustomFontDraft(editorFontFamily);
                        return;
                      }
                      setForceCustomFont(false);
                      const preset = EDITOR_FONT_PRESETS.find((p) => p.id === id);
                      if (preset) void setEditorFontFamily(preset.value);
                    }}
                    className="settings-dropdown"
                    minMenuWidth={260}
                  />
                  {editorFontFamily !== EDITOR_FONT_FAMILY ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => {
                        setForceCustomFont(false);
                        void setEditorFontFamily(EDITOR_FONT_FAMILY);
                      }}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
                {fontPresetValue === FONT_CUSTOM ? (
                  <div className="settings-field-row settings-field-row--stack">
                    <input
                      className="settings-text-input"
                      type="text"
                      value={customFontDraft}
                      spellCheck={false}
                      aria-label="Custom font family"
                      data-testid="settings-font-family-custom"
                      onChange={(e) => setCustomFontDraft(e.target.value)}
                      onBlur={() => {
                        const next = customFontDraft.trim();
                        if (next) void setEditorFontFamily(next);
                        else setCustomFontDraft(editorFontFamily);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  </div>
                ) : null}

                <h3 className="settings-section__title settings-section__title--spaced">
                  Line height
                </h3>
                <p className="settings-section__desc muted">
                  Editor and diff line spacing. Default {DEFAULT_LINE_HEIGHT}.
                </p>
                <div
                  className="settings-font-size"
                  role="group"
                  aria-label="Line height"
                >
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Tighter"
                    aria-label="Decrease line height"
                    disabled={lineHeight <= MIN_LINE_HEIGHT}
                    onClick={() =>
                      void setLineHeight(Math.round((lineHeight - 0.1) * 10) / 10)
                    }
                  >
                    <Icon name="remove" />
                  </button>
                  <input
                    className="settings-font-size__range"
                    type="range"
                    min={MIN_LINE_HEIGHT}
                    max={MAX_LINE_HEIGHT}
                    step={0.1}
                    value={lineHeight}
                    onChange={(e) =>
                      void setLineHeight(Number.parseFloat(e.target.value))
                    }
                    aria-valuemin={MIN_LINE_HEIGHT}
                    aria-valuemax={MAX_LINE_HEIGHT}
                    aria-valuenow={lineHeight}
                    aria-label="Line height multiplier"
                    data-testid="settings-line-height"
                  />
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Looser"
                    aria-label="Increase line height"
                    disabled={lineHeight >= MAX_LINE_HEIGHT}
                    onClick={() =>
                      void setLineHeight(Math.round((lineHeight + 0.1) * 10) / 10)
                    }
                  >
                    <Icon name="add" />
                  </button>
                  <span className="settings-font-size__value" aria-live="polite">
                    {lineHeight.toFixed(1)}
                  </span>
                  {lineHeight !== DEFAULT_LINE_HEIGHT ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void setLineHeight(DEFAULT_LINE_HEIGHT)}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>

                <h3 className="settings-section__title settings-section__title--spaced">
                  UI scale
                </h3>
                <p className="settings-section__desc muted">
                  Scale the whole workbench. Default {DEFAULT_UI_SCALE}%.
                </p>
                <div
                  className="settings-font-size"
                  role="group"
                  aria-label="UI scale"
                >
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Smaller"
                    aria-label="Decrease UI scale"
                    disabled={uiScale <= MIN_UI_SCALE}
                    onClick={() => void setUiScale(uiScale - 5)}
                  >
                    <Icon name="remove" />
                  </button>
                  <input
                    className="settings-font-size__range"
                    type="range"
                    min={MIN_UI_SCALE}
                    max={MAX_UI_SCALE}
                    step={5}
                    value={uiScale}
                    onChange={(e) =>
                      void setUiScale(Number.parseInt(e.target.value, 10))
                    }
                    aria-valuemin={MIN_UI_SCALE}
                    aria-valuemax={MAX_UI_SCALE}
                    aria-valuenow={uiScale}
                    aria-label="UI scale percentage"
                  />
                  <button
                    type="button"
                    className="icon-btn settings-font-size__btn"
                    title="Larger"
                    aria-label="Increase UI scale"
                    disabled={uiScale >= MAX_UI_SCALE}
                    onClick={() => void setUiScale(uiScale + 5)}
                  >
                    <Icon name="add" />
                  </button>
                  <span className="settings-font-size__value" aria-live="polite">
                    {uiScale}%
                  </span>
                  {uiScale !== DEFAULT_UI_SCALE ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => void setUiScale(DEFAULT_UI_SCALE)}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>

                <h3 className="settings-section__title settings-section__title--spaced">
                  Layout
                </h3>
                <p className="settings-section__desc muted">
                  Where Terminal and Agent session tabs appear. Default is side.
                </p>
                <div
                  className="settings-layout"
                  role="radiogroup"
                  aria-label="Session tab layout"
                >
                  {LAYOUT_OPTIONS.map((opt) => {
                    const active = sessionTabLayout === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`settings-layout__card${
                          active ? " is-active" : ""
                        }`}
                        onClick={() => void setSessionTabLayout(opt.id)}
                      >
                        <span
                          className={`settings-layout__preview settings-layout__preview--${opt.id}`}
                          aria-hidden
                        >
                          <span className="settings-layout__preview-chrome" />
                          <span className="settings-layout__preview-body">
                            <span className="settings-layout__preview-tabs" />
                            <span className="settings-layout__preview-term" />
                          </span>
                        </span>
                        <span className="settings-theme__meta">
                          <span className="settings-theme__label">
                            {opt.label}
                          </span>
                          <span className="settings-theme__hint">
                            {opt.description}
                          </span>
                        </span>
                        {active ? (
                          <span className="settings-theme__check" aria-hidden>
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

              </section>
            ) : null}


            {section === "theme" ? <SettingsThemeSection /> : null}

            {section === "agent" ? <SettingsAgentSection /> : null}

            {section === "experimental" ? <SettingsExperimentalSection /> : null}

            {section === "updates" ? (
              <section className="settings-section" aria-label="Updates">
                <h3 className="settings-section__title">Updates</h3>
                <p className="settings-section__desc muted">
                  Check GitHub Releases for a newer build and install it on this
                  machine.
                </p>

                <div className="settings-update-card">
                  <div className="settings-update-card__row">
                    <span>Current version</span>
                    <strong>v{currentVer}</strong>
                  </div>
                  {update?.latestVersion ? (
                    <div className="settings-update-card__row">
                      <span>Latest release</span>
                      <strong>v{update.latestVersion}</strong>
                    </div>
                  ) : null}
                  {update?.packaged != null ? (
                    <div className="settings-update-card__row">
                      <span>Build</span>
                      <strong>
                        {update.packaged
                          ? "Packaged installer"
                          : "Development"}
                      </strong>
                    </div>
                  ) : null}

                  {update?.message ? (
                    <p className="settings-update-card__msg" role="status">
                      {update.message}
                    </p>
                  ) : null}
                  {update?.error ? (
                    <p className="settings-update-card__err" role="alert">
                      {update.error}
                    </p>
                  ) : null}

                  {update?.status === "downloading" &&
                  update.progress != null ? (
                    <div
                      className="settings-update-card__progress"
                      role="progressbar"
                      aria-valuenow={update.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="settings-update-card__progress-bar"
                        style={{ width: `${update.progress}%` }}
                      />
                    </div>
                  ) : null}

                  <div className="settings-update-card__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={
                        updateBusy ||
                        update?.status === "checking" ||
                        update?.status === "downloading"
                      }
                      onClick={() => void runCheck()}
                    >
                      {update?.status === "checking"
                        ? "Checking…"
                        : "Check for updates"}
                    </button>

                    {update?.status === "available" && update.packaged ? (
                      <button
                        type="button"
                        className="btn btn--accent btn--small"
                        disabled={updateBusy}
                        onClick={() => void runDownload()}
                      >
                        Download update
                      </button>
                    ) : null}

                    {update?.status === "downloaded" && update.canInstall ? (
                      <button
                        type="button"
                        className="btn btn--accent btn--small"
                        disabled={updateBusy}
                        onClick={() => void runInstall()}
                      >
                        Restart &amp; install
                      </button>
                    ) : null}

                    {update?.status === "available" && !update.packaged ? (
                      <button
                        type="button"
                        className="btn btn--accent btn--small"
                        disabled={updateBusy}
                        onClick={() =>
                          void window.anchor?.updates?.openReleasePage?.()
                        }
                      >
                        Open release page
                      </button>
                    ) : null}

                    {update?.releaseUrl ? (
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() =>
                          void window.anchor?.updates?.openReleasePage?.()
                        }
                      >
                        View on GitHub
                      </button>
                    ) : null}
                  </div>

                  {!update?.packaged ? (
                    <p className="settings-update-card__hint">
                      Dev builds can only open the GitHub release. Packaged
                      installers download and install in-app.
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
