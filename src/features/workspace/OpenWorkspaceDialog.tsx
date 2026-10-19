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
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const committingWorkspace = useRef(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPrivateKeyPath, setSshPrivateKeyPath] = useState("");
  const [sshProfileId, setSshProfileId] = useState<string | null>(null);
  const [sshPassword, setSshPassword] = useState("");
  const [sshPolicy, setSshPolicy] = useState<"strict" | "accept-new">("strict");
  const [sshMode, setSshMode] = useState<"config" | "manual">("config");
  const [configHosts, setConfigHosts] = useState<{ alias: string; source: string }[]>([]);
  const [configWarning, setConfigWarning] = useState("");
  const [configAlias, setConfigAlias] = useState("");
  const [connectedSshProfileId, setConnectedSshProfileId] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const interactionVersion = useRef(0);

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
    const version = ++requestVersion.current;
    setBrowseLoading(true);
    setError(null);
    try {
      const entries = await window.anchor.host.browseListDir({
        path,
        kind: browseKind,
        distro: distro || undefined,
        ...(profileId ? { profileId } : {}),
      } as Parameters<typeof window.anchor.host.browseListDir>[0]);
      if (version !== requestVersion.current) return false;
      const onlyDirs = filterBrowseDirs(entries);
      setDirs(onlyDirs);
      setBrowsePath(path);
      return true;
    } catch (err) {
      if (version === requestVersion.current) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (version === requestVersion.current) setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setDirs([]);
    setBrowsePath("/");
    setBrowseLoading(false);
    setConnectedSshProfileId(null);
    const interaction = interactionVersion.current;
    let cancelled = false;
    void (async () => {
      try {
        const list = (await window.anchor?.host?.listProfiles?.()) ?? [];
        if (cancelled) return;
        if (interaction === interactionVersion.current) {
          setProfiles(list);
          const ssh = list.find((p) => p.kind === "ssh" && !p.ssh?.configHost);
          if (ssh?.ssh) {
            setSshProfileId(ssh.id);
            setSshHost(ssh.ssh.host ?? "");
            setSshPort(String(ssh.ssh.port ?? 22));
            setSshUsername(ssh.ssh.username ?? "");
            setSshPrivateKeyPath(ssh.ssh.privateKeyPath ?? "");
            setSshPassword(ssh.ssh.password ?? "");
            setSshPolicy(ssh.ssh.knownHostsPolicy === "accept-new" ? "accept-new" : "strict");
          } else {
            setSshProfileId(null);
            setSshPassword("");
            setSshHost("");
            setSshUsername("");
            setSshPort("22");
            setSshPrivateKeyPath("");
            setSshPolicy("strict");
          }
        }
        try {
          const discovered = await window.anchor.host.listSshConfigHosts();
          if (cancelled) return;
          const savedAliases = list.flatMap((p) => p.ssh?.configHost ? [{ alias: p.ssh.configHost, source: "Saved SSH config host" }] : []);
          const hosts = [...discovered.hosts, ...savedAliases.filter((p) => !discovered.hosts.some((d) => d.alias === p.alias))];
          setConfigHosts(hosts);
          if (interaction === interactionVersion.current) {
            setConfigAlias(hosts[0]?.alias ?? "");
            setSshMode(hosts.length ? "config" : "manual");
          }
          setConfigWarning(discovered.warnings.join(" "));
        } catch (err) {
          if (cancelled) return;
          setConfigHosts([]);
          if (interaction === interactionVersion.current) setSshMode("manual");
          setConfigWarning(`SSH config discovery unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (win) {
          const d = (await window.anchor?.host?.listWslDistros?.()) ?? [];
          if (cancelled) return;
          setDistros(d);
          if (d[0] && interaction === interactionVersion.current) setSelectedDistro(d[0]);
        }
      } catch (err) {
        if (!cancelled && interaction === interactionVersion.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      requestVersion.current += 1;
    };
  }, [open, win, loadBrowse]);

  useEffect(() => {
    if (!open || kind !== "wsl" || !win) return;
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
  function invalidateSsh() {
    interactionVersion.current += 1;
    requestVersion.current += 1;
    setConnectedSshProfileId(null);
    setDirs([]);
    setBrowsePath("/");
    setBrowseLoading(false);
    setError(null);
  }

  function closeDialog() {
    if (committingWorkspace.current) return;
    requestVersion.current += 1;
    onClose();
  }

  function changeKind(next: HostKind) {
    invalidateSsh();
    setKind(next);
  }

  function selectManualProfile(id: string) {
    invalidateSsh();
    const saved = profiles.find((p) => p.id === id);
    setSshProfileId(saved?.id ?? null);
    setSshHost(saved?.ssh?.host ?? "");
    setSshPort(String(saved?.ssh?.port ?? 22));
    setSshUsername(saved?.ssh?.username ?? "");
    setSshPrivateKeyPath(saved?.ssh?.privateKeyPath ?? "");
    setSshPassword(saved?.ssh?.password ?? "");
    setSshPolicy(saved?.ssh?.knownHostsPolicy === "accept-new" ? "accept-new" : "strict");
  }

  async function connectSsh() {
    if (busy) return;
    const version = ++requestVersion.current;
    const host = sshHost.trim();
    const username = sshUsername.trim();
    const alias = configAlias.trim();
    const port = Number(sshPort);
    if (sshMode === "config" && !/^[a-zA-Z0-9:][a-zA-Z0-9._:@%+-]*$/.test(alias)) {
      setError("Enter an SSH config alias or hostname (without spaces or options)"); return;
    }
    if (sshMode === "manual" && (!host || !username)) { setError("Enter an SSH host and username"); return; }
    if (sshMode === "manual" && (!Number.isInteger(port) || port < 1 || port > 65535)) { setError("Enter a valid SSH port"); return; }
    const profile: HostProfile = sshMode === "config" ? {
      id: profiles.find((p) => p.ssh?.configHost === alias)?.id ?? `ssh-config-${encodeURIComponent(alias)}`,
      kind: "ssh", label: alias, ssh: { configHost: alias },
    } : {
      id: sshProfileId ?? `ssh-manual-${crypto.randomUUID()}`,
      kind: "ssh", label: `${username}@${host}`,
      ssh: { host, port, username, knownHostsPolicy: sshPolicy,
        ...(sshPrivateKeyPath.trim() ? { privateKeyPath: sshPrivateKeyPath.trim() } : {}),
        ...(sshPassword ? { password: sshPassword } : {}) },
    };
    setBusy(true); setError(null); setConnectedSshProfileId(null); setDirs([]);
    try {
      const next = await window.anchor.host.upsertProfile(profile);
      if (version !== requestVersion.current) return;
      setProfiles(next);
      if (sshMode === "manual") setSshProfileId(profile.id);
      const connected = await loadBrowse("/", "", "ssh", profile.id);
      // loadBrowse advances the request version once. A later edit/close cancels this result.
      if (connected && requestVersion.current === version + 1) setConnectedSshProfileId(profile.id);
    } catch (err) {
      if (version === requestVersion.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestVersion.current === version || requestVersion.current === version + 1) setBusy(false);
    }
  }

  async function chooseSsh() {
    if (!connectedSshProfileId || busy) return;
    const path = browsePath.trim();
    if (!path.startsWith("/")) { setError("Select a remote POSIX folder"); return; }
    const version = requestVersion.current;
    committingWorkspace.current = true;
    setOpeningWorkspace(true);
    setBusy(true); setError(null);
    try {
      await window.anchor.host.useProfile(connectedSshProfileId);
      if (version !== requestVersion.current) return;
      onOpen({ path, hostProfileId: connectedSshProfileId, hostKind: "ssh" });
      onClose();
    } catch (err) { if (version === requestVersion.current) setError(err instanceof Error ? err.message : String(err)); }
    finally {
      committingWorkspace.current = false;
      setOpeningWorkspace(false);
      if (version === requestVersion.current) setBusy(false);
    }
  }

  const parent = parentPosix(browsePath);
  const canGoUp = parent !== null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={closeDialog}>
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
            disabled={openingWorkspace}
            onClick={closeDialog}
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
              disabled={busy} onChange={() => changeKind("local")}
            />
            <span className="host-choice__title">Local</span>
            <span className="host-choice__desc">
              Folder on this machine (native path)
            </span>
          </label>

          {win ? (
            <label className={`host-choice__card${kind === "wsl" ? " is-selected" : ""}`}>
              <input type="radio" name="host-kind" checked={kind === "wsl"} disabled={busy} onChange={() => changeKind("wsl")} />
              <span className="host-choice__title">WSL</span>
              <span className="host-choice__desc">Linux distro via wsl.exe — POSIX paths, shell inside WSL</span>
            </label>
          ) : null}
          <label className={`host-choice__card${kind === "ssh" ? " is-selected" : ""}`}>
            <input type="radio" name="host-kind" checked={kind === "ssh"} disabled={busy} onChange={() => changeKind("ssh")} />
            <span className="host-choice__title">SSH</span>
            <span className="host-choice__desc">Remote Linux host via SSH — POSIX paths</span>
          </label>
        </div>
        <div className={`modal__body${kind === "ssh" ? " modal__body--ssh" : ""}`}>

          {kind === "ssh" ? (
            <div className="modal__fields">
              <div className="field field--ssh-full">
                <div className="wsl-browser__toolbar">
                  <button type="button" className="btn btn--ghost btn--small" disabled={busy} aria-pressed={sshMode === "config"} onClick={() => { invalidateSsh(); setSshMode("config"); }}>Use SSH config</button>
                  <button type="button" className="btn btn--ghost btn--small" disabled={busy} aria-pressed={sshMode === "manual"} onClick={() => { invalidateSsh(); setSshMode("manual"); }}>Add / manual connection</button>
                </div>
                {configWarning ? <p className="modal__hint">{configWarning}</p> : null}
              </div>
              {sshMode === "config" ? <>
                <label className="field field--ssh-full">
                  <span className="field__label">SSH config host</span>
                  <input className="field__input" list="ssh-config-hosts" value={configAlias} disabled={busy} onChange={(e) => { invalidateSsh(); setConfigAlias(e.target.value); }} placeholder="Select or type a host alias" />
                </label>
                <datalist id="ssh-config-hosts">{configHosts.map((h) => <option key={h.alias} value={h.alias}>{h.source}</option>)}</datalist>
                <p className="modal__hint">Uses this computer’s OpenSSH config, including jump hosts, keys and agent. Connect only to aliases you trust: SSH config may run local commands. Unknown keys must be verified in a terminal first. Key/agent authentication is required; load encrypted keys into ssh-agent. For password authentication, use a manual connection.</p>
                {configHosts.length === 0 ? <p className="modal__hint">No named hosts found. Type an alias or add a manual connection.</p> : null}
              </> : <>
                <label className="field field--ssh-full">
                  <span className="field__label">Saved manual connection</span>
                  <select className="field__input" value={sshProfileId ?? ""} disabled={busy} onChange={(e) => selectManualProfile(e.target.value)}>
                    <option value="">New connection</option>
                    {profiles.filter((p) => p.kind === "ssh" && !p.ssh?.configHost).map((p) => <option key={p.id} value={p.id}>{p.label ?? p.ssh?.host ?? p.id}</option>)}
                  </select>
                </label>
                <label className="field field--ssh-host">
                  <span className="field__label">Host</span>
                  <input className="field__input" value={sshHost} disabled={busy} onChange={(e) => { invalidateSsh(); setSshHost(e.target.value); }} />
                </label>
                <label className="field field--ssh-port">
                  <span className="field__label">Port</span>
                  <input className="field__input" inputMode="numeric" value={sshPort} disabled={busy} onChange={(e) => { invalidateSsh(); setSshPort(e.target.value); }} />
                </label>
                <label className="field field--ssh-username">
                  <span className="field__label">Username</span>
                  <input className="field__input" value={sshUsername} disabled={busy} onChange={(e) => { invalidateSsh(); setSshUsername(e.target.value); }} />
                </label>
                <label className="field field--ssh-key">
                  <span className="field__label">Private key path (optional)</span>
                  <input className="field__input" value={sshPrivateKeyPath} disabled={busy} onChange={(e) => { invalidateSsh(); setSshPrivateKeyPath(e.target.value); }} />
                </label>
                <label className="field field--ssh-password">
                  <span className="field__label">Password (this session only)</span>
                  <input className="field__input" type="password" value={sshPassword} disabled={busy} onChange={(e) => { invalidateSsh(); setSshPassword(e.target.value); }} autoComplete="new-password" />
                </label>
                <label className="field field--ssh-full">
                  <span className="field__label">Host key verification</span>
                  <select className="field__input" value={sshPolicy} disabled={busy} onChange={(e) => { invalidateSsh(); setSshPolicy(e.target.value as "strict" | "accept-new"); }}>
                    <option value="strict">Strict: require a known host key</option>
                    <option value="accept-new">Trust first key automatically; reject changed keys</option>
                  </select>
                </label>
              </>}
              <div className="field field--ssh-full"><button type="button" className="btn btn--accent" disabled={busy || browseLoading} onClick={() => void connectSsh()}>{busy ? "Connecting…" : connectedSshProfileId ? "Reconnect" : "Connect"}</button></div>
              <div className="field field--grow">
                <span className="field__label">Remote POSIX folder</span>
                <div className="wsl-browser">
                  <div className="wsl-browser__toolbar">
                    <button type="button" className="btn btn--ghost btn--small" disabled={!connectedSshProfileId || !canGoUp || browseLoading || busy} onClick={() => { if (parent && connectedSshProfileId) void loadBrowse(parent, "", "ssh", connectedSshProfileId); }}>Up</button>
                    <span className="wsl-browser__path">{browsePath}</span>
                  </div>
                  <div className={`wsl-browser__list${browseLoading ? " is-loading" : ""}`} role="listbox" aria-label="Remote folders">
                    {dirs.length === 0 && browseLoading ? <div className="wsl-browser__empty">Loading…</div> : dirs.length === 0 ? <div className="wsl-browser__empty">{connectedSshProfileId ? "No subfolders" : "Connect to browse remote folders"}</div> : dirs.map((d) => (
                      <button key={d.name} type="button" role="option" className="wsl-browser__row" disabled={browseLoading || busy || !connectedSshProfileId} onClick={() => { if (connectedSshProfileId) void loadBrowse(joinPosix(browsePath, d.name), "", "ssh", connectedSshProfileId); }}>
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
            onClick={closeDialog}
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
              disabled={busy || !browsePath.startsWith("/") || browseLoading || (kind === "ssh" && !connectedSshProfileId)}
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
