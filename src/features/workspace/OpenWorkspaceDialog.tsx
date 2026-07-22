import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry, HostKind, HostProfile } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import {
  filterBrowseDirs,
  isWindowsClient,
  joinPosix,
  parentPosix,
} from "./openWorkspacePaths";

export type OpenWorkspaceResult = {
  path: string;
  hostProfileId: string;
  hostKind: HostKind;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onOpen: (result: OpenWorkspaceResult) => void;
};

export function OpenWorkspaceDialog({ open, onClose, onOpen }: Props) {
  const win = isWindowsClient();
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [distros, setDistros] = useState<string[]>([]);
  const [kind, setKind] = useState<HostKind>(win ? "wsl" : "local");
  const [selectedDistro, setSelectedDistro] = useState<string>("");
  const [browsePath, setBrowsePath] = useState<string>("/");
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Skip distro-change effect on first open (init effect already loads). */
  const skipDistroEffect = useRef(true);

  const localProfile = useMemo(
    () =>
      profiles.find((p) => p.kind === "local") ?? {
        id: "local-default",
        kind: "local" as const,
      },
    [profiles],
  );
  const wslProfile = useMemo(
    () =>
      profiles.find((p) => p.kind === "wsl") ?? {
        id: "wsl-default",
        kind: "wsl" as const,
      },
    [profiles],
  );

  const loadBrowse = useCallback(async (path: string, distro: string) => {
    setBrowseLoading(true);
    setError(null);
    try {
      const entries = await window.anchor.host.browseListDir({
        path,
        kind: "wsl",
        distro: distro || undefined,
      });
      const onlyDirs = filterBrowseDirs(entries);
      setDirs(onlyDirs);
      setBrowsePath(path);
    } catch (err) {
      setDirs([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setDirs([]);
    setBrowsePath("/");
    setHomePath(null);
    skipDistroEffect.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const list = (await window.anchor?.host?.listProfiles?.()) ?? [];
        if (cancelled) return;
        setProfiles(list);
        if (win) {
          const d = (await window.anchor?.host?.listWslDistros?.()) ?? [];
          if (cancelled) return;
          setDistros(d);
          const distro = d[0] ?? "";
          if (d[0]) setSelectedDistro(d[0]);
          const home =
            (await window.anchor?.host?.wslHome?.({
              distro: distro || undefined,
            })) ?? "/home";
          if (cancelled) return;
          setHomePath(home);
          await loadBrowse(home, distro);
        }
        const last = list.find((p) =>
          win ? p.kind === "wsl" : p.kind === "local",
        );
        if (last) setKind(last.kind);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, win, loadBrowse]);

  useEffect(() => {
    if (!open || kind !== "wsl" || !win || !selectedDistro) return;
    if (skipDistroEffect.current) {
      skipDistroEffect.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const home =
          (await window.anchor.host.wslHome({ distro: selectedDistro })) ??
          "/home";
        if (cancelled) return;
        setHomePath(home);
        await loadBrowse(home, selectedDistro);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDistro, open, kind, win, loadBrowse]);

  if (!open) return null;

  async function chooseLocal() {
    setBusy(true);
    setError(null);
    try {
      await window.anchor.host.useProfile(localProfile.id);
      const picked = await window.anchor.workspace.pickFolder();
      if (!picked) {
        setBusy(false);
        return;
      }
      onOpen({
        path: picked,
        hostProfileId: localProfile.id,
        hostKind: "local",
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function chooseWsl() {
    const path = browsePath.trim();
    if (!path.startsWith("/")) {
      setError("Select a folder under WSL");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let profileId = wslProfile.id;
      if (selectedDistro) {
        const next: HostProfile = {
          id: wslProfile.id,
          kind: "wsl",
          label: `WSL (${selectedDistro})`,
          wsl: { distro: selectedDistro || undefined },
        };
        await window.anchor.host.upsertProfile(next);
        profileId = next.id;
      }
      await window.anchor.host.useProfile(profileId);
      onOpen({
        path,
        hostProfileId: profileId,
        hostKind: "wsl",
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const parent = parentPosix(browsePath);
  const canGoUp = parent !== null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-ws-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id="open-ws-title" className="modal__title">
            Open Workspace
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

        <p className="modal__hint">
          Choose where the workspace lives. Terminal, git, and comments all run
          on that host.
        </p>

        <div className="host-choice" role="radiogroup" aria-label="Host">
          <label
            className={`host-choice__card${kind === "local" ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="host-kind"
              checked={kind === "local"}
              onChange={() => setKind("local")}
            />
            <span className="host-choice__title">Local</span>
            <span className="host-choice__desc">
              Folder on this machine (native path)
            </span>
          </label>

          {win ? (
            <label
              className={`host-choice__card${kind === "wsl" ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="host-kind"
                checked={kind === "wsl"}
                onChange={() => setKind("wsl")}
              />
              <span className="host-choice__title">WSL</span>
              <span className="host-choice__desc">
                Linux distro via wsl.exe — POSIX paths, shell inside WSL
              </span>
            </label>
          ) : null}
        </div>

        <div className="modal__body">
          {kind === "wsl" && win ? (
            <div className="modal__fields">
              {distros.length > 0 ? (
                <label className="field">
                  <span className="field__label">Distro</span>
                  <select
                    className="field__input"
                    value={selectedDistro}
                    onChange={(e) => setSelectedDistro(e.target.value)}
                  >
                    {distros.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="modal__hint">
                  No distros listed — default WSL distro will be used.
                </p>
              )}

              <div className="field field--grow">
                <span className="field__label">Workspace folder</span>
                <div className="wsl-browser">
                  <div className="wsl-browser__toolbar">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      disabled={!canGoUp || browseLoading}
                      onClick={() => {
                        if (parent) void loadBrowse(parent, selectedDistro);
                      }}
                      title="Go up"
                    >
                      <Icon
                        name="chevron-right"
                        className="btn__icon wsl-browser__up-icon"
                      />
                      Up
                    </button>
                    {homePath ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={browseLoading || browsePath === homePath}
                        onClick={() =>
                          void loadBrowse(homePath, selectedDistro)
                        }
                        title={homePath}
                      >
                        <Icon name="home" className="btn__icon" />
                        Home
                      </button>
                    ) : null}
                    <span className="wsl-browser__path" title={browsePath}>
                      {browsePath}
                    </span>
                  </div>

                  <div
                    className="wsl-browser__list"
                    role="listbox"
                    aria-label="Folders"
                  >
                    {browseLoading ? (
                      <div className="wsl-browser__empty">Loading…</div>
                    ) : dirs.length === 0 ? (
                      <div className="wsl-browser__empty">No subfolders</div>
                    ) : (
                      dirs.map((d) => (
                        <button
                          key={d.name}
                          type="button"
                          role="option"
                          className="wsl-browser__row"
                          onClick={() =>
                            void loadBrowse(
                              joinPosix(browsePath, d.name),
                              selectedDistro,
                            )
                          }
                        >
                          <Icon name="folder" className="wsl-browser__icon" />
                          <span className="wsl-browser__name">{d.name}</span>
                          <Icon
                            name="chevron-right"
                            className="wsl-browser__chevron"
                          />
                        </button>
                      ))
                    )}
                  </div>

                  <p className="wsl-browser__hint">
                    Selected:{" "}
                    <code className="wsl-browser__code">{browsePath}</code>
                    {" — "}
                    click a folder to enter, then Open Workspace.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="modal__body-local">
              <strong>Local workspace</strong>
              <span>
                Use the system folder picker to choose a directory on this
                machine. Paths stay native Windows/macOS/Linux.
              </span>
            </div>
          )}
        </div>

        {error ? <p className="modal__error">{error}</p> : null}

        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          {kind === "local" ? (
            <button
              type="button"
              className="btn btn--accent"
              disabled={busy}
              onClick={() => void chooseLocal()}
            >
              {busy ? "Opening…" : "Choose folder…"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--accent"
              disabled={busy || !browsePath.startsWith("/") || browseLoading}
              onClick={() => void chooseWsl()}
            >
              {busy ? "Opening…" : "Open Workspace"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
