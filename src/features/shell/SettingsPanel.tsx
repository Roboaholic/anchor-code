import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/shared/Icon";
import type {
  AppUpdateState,
  SessionTabLayout,
  UiTheme,
} from "@/shared/anchor-api";
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

type SettingsSection = "appearance" | "updates";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
];

/**
 * Floating settings dialog (modal). Controlled by themeStore.settingsOpen.
 */
export function SettingsPanel() {
  const open = useThemeStore((s) => s.settingsOpen);
  const setSettingsOpen = useThemeStore((s) => s.setSettingsOpen);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const sessionTabLayout = useThemeStore((s) => s.sessionTabLayout);
  const setSessionTabLayout = useThemeStore((s) => s.setSessionTabLayout);
  const versionLabel = useShellStore((s) => s.versionLabel);
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [update, setUpdate] = useState<AppUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

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
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

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
                <h3 className="settings-section__title">Color theme</h3>
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
