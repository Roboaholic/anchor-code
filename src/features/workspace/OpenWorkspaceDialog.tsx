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
  const [busy, setBusy] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPrivateKeyPath, setSshPrivateKeyPath] = useState("");
  const [sshProfileId, setSshProfileId] = useState<string | null>(null);
  const [sshPassword, setSshPassword] = useState("");
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
  const loadBrowse = useCallback(async (
    path: string,
    distro: string,
    browseKind: "wsl" | "ssh" = "wsl",
    profileId?: string,
  ) => {
    setBrowseLoading(true);
    setError(null);
    try {
      const entries = await window.anchor.host.browseListDir({
        path,
        kind: browseKind,
        distro: distro || undefined,
        ...(profileId ? { profileId } : {}),
      } as Parameters<typeof window.anchor.host.browseListDir>[0]);
      const onlyDirs = filterBrowseDirs(entries);
      setDirs(onlyDirs);
      setBrowsePath(path);
    } catch (err) {
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
    skipDistroEffect.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const list = (await window.anchor?.host?.listProfiles?.()) ?? [];
        if (cancelled) return;
        setProfiles(list);
        const ssh = list.find((p) => p.kind === "ssh");
        if (ssh?.ssh) {
          setSshProfileId(ssh.id);
          setSshHost(ssh.ssh.host);
          setSshPort(String(ssh.ssh.port ?? 22));
          setSshUsername(ssh.ssh.username);
          setSshPrivateKeyPath(ssh.ssh.privateKeyPath ?? "");
          setSshPassword(ssh.ssh.password ?? "");
        } else {
          setSshProfileId(null);
          setSshPassword("");
        }
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
    if (!open || kind !== "ssh" || !sshHost.trim() || !sshUsername.trim()) return;
    let cancelled = false;
    void (async () => {
      const profile: HostProfile = {
        id: sshProfileId ?? "ssh-workspace",
        kind: "ssh",
        label: `${sshUsername.trim()}@${sshHost.trim()}`,
        ssh: {
          host: sshHost.trim(),
          port: Number(sshPort) || 22,
          username: sshUsername.trim(),
          ...(!sshPassword && sshPrivateKeyPath.trim() ? { privateKeyPath: sshPrivateKeyPath.trim() } : {}),
          ...(sshPassword ? { password: sshPassword } : {}),
        },
      };
      try {
        await window.anchor.host.upsertProfile(profile);
        if (cancelled) return;
        setSshProfileId(profile.id);
        await loadBrowse("/", "", "ssh", profile.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, sshHost, sshPort, sshUsername, sshPrivateKeyPath, sshProfileId, loadBrowse]);

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
  async function chooseSsh() {
    const host = sshHost.trim();
    const username = sshUsername.trim();
    const path = browsePath.trim();
    const port = Number(sshPort);
    if (!host || !username) { setError("Enter an SSH host and username"); return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setError("Enter a valid SSH port"); return; }
    if (!path.startsWith("/")) { setError("Select a remote POSIX folder"); return; }
    setBusy(true); setError(null);
    try {
      const profile: HostProfile = {
        id: sshProfileId ?? `ssh-${host}-${username}`,
        kind: "ssh",
        label: `${username}@${host}`,
        ssh: { host, port, username, ...(sshPrivateKeyPath.trim() ? { privateKeyPath: sshPrivateKeyPath.trim() } : {}), ...(sshPassword ? { password: sshPassword } : {}) },
      };
      await window.anchor.host.upsertProfile(profile);
      await window.anchor.host.useProfile(profile.id);
      onOpen({ path, hostProfileId: profile.id, hostKind: "ssh" });
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
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
            <label className={`host-choice__card${kind === "wsl" ? " is-selected" : ""}`}>
              <input type="radio" name="host-kind" checked={kind === "wsl"} onChange={() => setKind("wsl")} />
              <span className="host-choice__title">WSL</span>
              <span className="host-choice__desc">Linux distro via wsl.exe — POSIX paths, shell inside WSL</span>
            </label>
          ) : null}
          <label className={`host-choice__card${kind === "ssh" ? " is-selected" : ""}`}>
            <input type="radio" name="host-kind" checked={kind === "ssh"} onChange={() => setKind("ssh")} />
            <span className="host-choice__title">SSH</span>
            <span className="host-choice__desc">Remote Linux host via SSH — POSIX paths</span>
          </label>
        </div>
        <div className={`modal__body${kind === "ssh" ? " modal__body--ssh" : ""}`}>

          {kind === "ssh" ? (
            <div className="modal__fields">
              <label className="field field--ssh-host">
                <span className="field__label">Host</span>
                <input className="field__input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
              </label>
              <label className="field field--ssh-port">
                <span className="field__label">Port</span>
                <input className="field__input" inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
              </label>
              <label className="field field--ssh-username">
                <span className="field__label">Username</span>
                <input className="field__input" value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
              </label>
              <label className="field field--ssh-key">
                <span className="field__label">Private key path (optional)</span>
                <input className="field__input" value={sshPrivateKeyPath} onChange={(e) => setSshPrivateKeyPath(e.target.value)} />
              </label>
              <label className="field field--ssh-password">
                <span className="field__label">Password (optional)</span>
                <input className="field__input" type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <div className="field field--grow">
                <span className="field__label">Remote POSIX folder</span>
                <div className="wsl-browser">
                  <div className="wsl-browser__toolbar">
                    <button type="button" className="btn btn--ghost btn--small" disabled={!canGoUp || browseLoading} onClick={() => { if (parent) void loadBrowse(parent, "", "ssh", sshProfileId ?? undefined); }}>Up</button>
                    <span className="wsl-browser__path">{browsePath}</span>
                  </div>
                  <div className={`wsl-browser__list${browseLoading ? " is-loading" : ""}`} role="listbox" aria-label="Remote folders">
                    {dirs.length === 0 && browseLoading ? <div className="wsl-browser__empty">Loading…</div> : dirs.length === 0 ? <div className="wsl-browser__empty">No subfolders</div> : dirs.map((d) => (
                      <button key={d.name} type="button" role="option" className="wsl-browser__row" disabled={browseLoading} onClick={() => void loadBrowse(joinPosix(browsePath, d.name), "", "ssh", sshProfileId ?? undefined)}>
                        <Icon name="folder" className="wsl-browser__icon" />
                        <span className="wsl-browser__name">{d.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : kind === "wsl" && win ? (
            <div className="modal__fields">
              {distros.length > 0 ? <label className="field"><span className="field__label">Distro</span><select className="field__input" value={selectedDistro} onChange={(e) => setSelectedDistro(e.target.value)}>{distros.map((d) => <option key={d} value={d}>{d}</option>)}</select></label> : <p className="modal__hint">No distros listed — default WSL distro will be used.</p>}
              <div className="field field--grow">
                <span className="field__label">Workspace folder</span>
                <div className="wsl-browser">
                  <div className="wsl-browser__toolbar"><button type="button" className="btn btn--ghost btn--small" disabled={!canGoUp || browseLoading} onClick={() => { if (parent) void loadBrowse(parent, selectedDistro); }}>Up</button><span className="wsl-browser__path">{browsePath}</span></div>
                  <div className="wsl-browser__list" role="listbox" aria-label="Folders">{browseLoading ? <div className="wsl-browser__empty">Loading…</div> : dirs.length === 0 ? <div className="wsl-browser__empty">No subfolders</div> : dirs.map((d) => <button key={d.name} type="button" role="option" className="wsl-browser__row" onClick={() => void loadBrowse(joinPosix(browsePath, d.name), selectedDistro)}><Icon name="folder" className="wsl-browser__icon" /><span className="wsl-browser__name">{d.name}</span></button>)}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="modal__body-local"><strong>Local workspace</strong><span>Use the system folder picker to choose a directory on this machine.</span></div>
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
              onClick={() => void (kind === "ssh" ? chooseSsh() : chooseWsl())}
            >
              {busy ? "Opening…" : "Open Workspace"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
