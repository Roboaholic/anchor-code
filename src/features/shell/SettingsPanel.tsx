import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "@/core/theme/theme";
import { Icon } from "@/shared/Icon";
import type {
  AppUpdateState,
  SessionTabLayout,
  SkillInstallStatus,
  UiTheme,
} from "@/shared/anchor-api";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useShellStore } from "./shellStore";
import { useThemeStore } from "./themeStore";

const THEME_OPTIONS: Array<{
  id: UiTheme;
  label: string;
  description: string;
}> = [
  {
    id: "light",
    label: "Light",
    description: "Warm paper panels for daytime reading.",
  },
  {
    id: "light-modern",
    label: "Light Modern",
    description: "VS Code Light Modern workbench and blue accents.",
  },
  {
    id: "dark",
    label: "Dark",
    description: "Neutral charcoal shell with warm sand accents.",
  },
  {
    id: "dark-modern",
    label: "Dark Modern",
    description: "VS Code Dark Modern workbench and blue accents.",
  },
];

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

type SettingsSection = "appearance" | "agent-skill" | "updates";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "agent-skill", label: "Agent skill" },
  { id: "updates", label: "Updates" },
];

/**
 * Floating settings dialog (modal). Controlled by themeStore.settingsOpen.
 */
export function SettingsPanel() {
  const open = useThemeStore((s) => s.settingsOpen);
  const setSettingsOpen = useThemeStore((s) => s.setSettingsOpen);
  const settingsFocusSection = useThemeStore((s) => s.settingsFocusSection);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const sessionTabLayout = useThemeStore((s) => s.sessionTabLayout);
  const setSessionTabLayout = useThemeStore((s) => s.setSessionTabLayout);
  const fontSize = useThemeStore((s) => s.fontSize);
  const setFontSize = useThemeStore((s) => s.setFontSize);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [update, setUpdate] = useState<AppUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [skillStatus, setSkillStatus] = useState<SkillInstallStatus | null>(
    null,
  );
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillMessage, setSkillMessage] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<Record<string, true>>(
    {},
  );

  const onClose = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

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
      settingsFocusSection === "agent-skill" ||
      settingsFocusSection === "updates"
    ) {
      setSection(settingsFocusSection);
    }
  }, [open, settingsFocusSection]);

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

  const refreshSkillStatus = useCallback(async () => {
    if (!window.anchor?.skill?.status) return;
    try {
      const status = await window.anchor.skill.status({
        workspaceRoot,
      });
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
    if (!open) return;
    setSkillMessage(null);
    setSkillError(null);
    void refreshSkillStatus();
  }, [open, refreshSkillStatus]);

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
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  // Open Settings → Updates: always re-check so the Download button can appear.
  useEffect(() => {
    if (!open || section !== "updates") return;
    void runCheck();
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
              error: err instanceof Error ? err.message : String(err),
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
                  Color theme
                </h3>
                <p className="settings-section__desc muted">
                  Choose a workbench color theme. Applied immediately.
                </p>
                <div
                  className="settings-theme"
                  role="radiogroup"
                  aria-label="Theme"
                >
                  {THEME_OPTIONS.map((opt) => {
                    const active = theme === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`settings-theme__card${
                          active ? " is-active" : ""
                        }`}
                        onClick={() => void setTheme(opt.id)}
                      >
                        <span
                          className={`settings-theme__swatch settings-theme__swatch--${opt.id}`}
                          aria-hidden
                        />
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

            {section === "agent-skill" ? (
              <section className="settings-section" aria-label="Agent skill">
                <h3 className="settings-section__title">Anchor Review skill</h3>
                <p className="settings-section__desc muted">
                  Install the agent skill that teaches coding CLIs how to read{" "}
                  <code>.anchor-code</code> session YAML, honor{" "}
                  <code>need_modify</code>, and mark finished comments{" "}
                  <code>closed</code>. Prefer workspace install so the skill
                  travels with the repo; optional user homes install into
                  detected agent skill directories on this host.
                </p>

                {!workspaceRoot ? (
                  <p className="settings-update-card__hint">
                    Open a workspace to enable workspace install. User-level
                    targets still appear when agent homes exist on the host.
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
                    No install targets found yet. Open a workspace, or ensure an
                    agent skill home exists (for example{" "}
                    <code>~/.codex</code> or <code>~/.claude</code>) on this
                    host.
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
                    disabled={
                      skillBusy || !(skillStatus?.targets?.length)
                    }
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
            ) : null}

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
