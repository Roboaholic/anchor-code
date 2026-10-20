import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry, HostKind, HostProfile } from "@/shared/anchor-api";
import { Dropdown } from "@/shared/Dropdown";
import { Icon } from "@/shared/Icon";
import "./OpenWorkspaceDialog.css";
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
  const [pathInput, setPathInput] = useState("/");
  const dialogRef = useRef<HTMLDivElement>(null);
  const folderHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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

  // All dismissal controls share the same guard and invalidate pending loads.
  const closeDialog = useCallback(() => {
    if (committingWorkspace.current) return;
    requestVersion.current += 1;
    onCloseRef.current();
  }, []);

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
      setPathInput(path);
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
    setPathInput("/");
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

  // Keep keyboard navigation inside the dialog and restore the launcher's focus.
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!committingWorkspace.current) {
          event.preventDefault();
          closeDialog();
        }
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter((element) =>
        element.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')
        && (!element.closest('details:not([open])') || element.tagName === "SUMMARY"),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open, closeDialog]);

  useEffect(() => {
    if (!open || kind !== "ssh") return;
    if (connectedSshProfileId) folderHeadingRef.current?.focus();
    else dialogRef.current?.querySelector<HTMLInputElement>('.workspace-dialog__connection input')?.focus();
  }, [open, kind, sshMode, connectedSshProfileId]);

  useEffect(() => {
    if (open && error) errorRef.current?.focus();
  }, [open, error]);

  if (!open) return null;

  async function chooseLocal() {
    if (busy || committingWorkspace.current) return;
    committingWorkspace.current = true;
    setOpeningWorkspace(true);
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
      committingWorkspace.current = false;
      setOpeningWorkspace(false);
      setBusy(false);
    }
  }

  async function chooseWsl() {
    if (busy || committingWorkspace.current) return;
    const path = browsePath.trim();
    if (!path.startsWith("/")) {
      setError("Select a folder under WSL");
      return;
    }
    committingWorkspace.current = true;
    setOpeningWorkspace(true);
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
      committingWorkspace.current = false;
      setOpeningWorkspace(false);
      setBusy(false);
    }
  }
  function invalidateSsh() {
    interactionVersion.current += 1;
    requestVersion.current += 1;
    setConnectedSshProfileId(null);
    setDirs([]);
    setBrowsePath("/");
    setPathInput("/");
    setBrowseLoading(false);
    setError(null);
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
  const connectedProfile = profiles.find((profile) => profile.id === connectedSshProfileId);
  const connectedLabel = connectedProfile?.label ?? (sshMode === "config" ? configAlias : `${sshUsername}@${sshHost}`);
  const selectingFolder = kind === "wsl" || (kind === "ssh" && !!connectedSshProfileId);
  const connectionReady = sshMode === "config"
    ? !!configAlias.trim()
    : !!sshHost.trim() && !!sshUsername.trim();
  const pathChanged = pathInput.trim() !== browsePath;

  function browseFolder(path: string) {
    const next = path.trim();
    if (!next.startsWith("/")) {
      setError("Enter an absolute folder path starting with /.");
      return;
    }
    if (kind === "ssh" && connectedSshProfileId) {
      void loadBrowse(next, "", "ssh", connectedSshProfileId);
    } else if (kind === "wsl") {
      void loadBrowse(next, selectedDistro);
    }
  }

  return (
    <div className="modal-backdrop workspace-dialog-backdrop" role="presentation" onClick={closeDialog}>
      <div
        ref={dialogRef}
        className="modal workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-ws-title"
        aria-describedby="open-ws-description"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="open-ws-title" className="modal__title">Open Workspace</h2>
            <p id="open-ws-description" className="modal__hint">Choose where your project lives.</p>
          </div>
          <button type="button" className="btn btn--ghost btn--icon workspace-dialog__close" aria-label="Close" title="Close" disabled={openingWorkspace} onClick={closeDialog}>
            <Icon name="close" />
          </button>
        </header>

        <div className="workspace-dialog__content">
          <div className="host-choice" role="radiogroup" aria-label="Host">
            <label className={`host-choice__card${kind === "local" ? " is-selected" : ""}`}>
              <input type="radio" name="host-kind" checked={kind === "local"} disabled={busy} onChange={() => changeKind("local")} />
              <Icon name="device-desktop" />
              <span><span className="host-choice__title">Local</span><span className="host-choice__desc">This computer</span></span>
            </label>
            {win ? (
              <label className={`host-choice__card${kind === "wsl" ? " is-selected" : ""}`}>
                <input type="radio" name="host-kind" checked={kind === "wsl"} disabled={busy} onChange={() => changeKind("wsl")} />
                <Icon name="terminal-linux" />
                <span><span className="host-choice__title">WSL</span><span className="host-choice__desc">Linux on Windows</span></span>
              </label>
            ) : null}
            <label className={`host-choice__card${kind === "ssh" ? " is-selected" : ""}`}>
              <input type="radio" name="host-kind" checked={kind === "ssh"} disabled={busy} onChange={() => changeKind("ssh")} />
              <Icon name="remote" />
              <span><span className="host-choice__title">SSH</span><span className="host-choice__desc">Remote server</span></span>
            </label>
          </div>

          {kind === "ssh" ? (
            <>
              {connectedSshProfileId ? (
                <div className="workspace-dialog__connected">
                  <Icon name="remote" />
                  <div className="workspace-dialog__host-summary">
                    <strong title={connectedLabel}>{connectedLabel}</strong>
                    <span role="status"><span className="workspace-dialog__status-dot" />Connected · {sshMode === "config" ? "SSH config" : "Manual SSH"}</span>
                  </div>
                  <button type="button" className="btn btn--ghost btn--small" disabled={busy || browseLoading} onClick={invalidateSsh}>Change connection</button>
                </div>
              ) : (
                <form id="ssh-connection-form" className="workspace-dialog__connection" aria-labelledby="ssh-connection-title" onSubmit={(event) => { event.preventDefault(); if (connectionReady) void connectSsh(); }}>
                  <h3 id="ssh-connection-title" className="workspace-dialog__section-title">Connect to a host</h3>
                  <div className="workspace-dialog__modes" role="group" aria-label="Connection method">
                    <button type="button" className={`btn btn--ghost btn--small${sshMode === "config" ? " is-active" : ""}`} disabled={busy} aria-pressed={sshMode === "config"} onClick={() => { invalidateSsh(); setSshMode("config"); }}>Use SSH config</button>
                    <button type="button" className={`btn btn--ghost btn--small${sshMode === "manual" ? " is-active" : ""}`} disabled={busy} aria-pressed={sshMode === "manual"} onClick={() => { invalidateSsh(); setSshMode("manual"); }}>Manual connection</button>
                  </div>
                  {sshMode === "config" ? (
                    <>
                      <label className="field">
                        <span className="field__label">SSH config host</span>
                        <input className="field__input" list="ssh-config-hosts" value={configAlias} disabled={busy} onChange={(event) => { invalidateSsh(); setConfigAlias(event.target.value); }} placeholder="Select or type a host alias" autoCapitalize="none" spellCheck={false} />
                      </label>
                      <datalist id="ssh-config-hosts">{configHosts.map((host) => <option key={host.alias} value={host.alias}>{host.source}</option>)}</datalist>
                      <p className="modal__hint">Uses your OpenSSH config, keys, agent and jump hosts.</p>
                      {configHosts.length === 0 ? <p className="modal__hint">No named hosts found. Type an alias or use a manual connection.</p> : null}
                      <div className="workspace-dialog__security-note"><Icon name="shield" /><p>Only connect to hosts you trust. Unknown host keys must be verified in a terminal first.</p></div>
                      <details className="workspace-dialog__details">
                        <summary>Authentication &amp; security details</summary>
                        <p>SSH config may run local commands. Key or agent authentication is required; load encrypted keys into ssh-agent. For password authentication, use a manual connection. Changed host keys are always rejected.</p>
                      </details>
                    </>
                  ) : (
                    <div className="workspace-dialog__manual-fields">
                      {profiles.some((profile) => profile.kind === "ssh" && !profile.ssh?.configHost) ? (
                        <div className="field workspace-dialog__full-width">
                          <span className="field__label" id="workspace-manual-profile-label">Saved manual connection</span>
                          <Dropdown
                            aria-labelledby="workspace-manual-profile-label"
                            value={sshProfileId ?? ""}
                            disabled={busy}
                            onChange={selectManualProfile}
                            options={[
                              { value: "", label: "New connection" },
                              ...profiles
                                .filter((profile) => profile.kind === "ssh" && !profile.ssh?.configHost)
                                .map((profile) => ({ value: profile.id, label: profile.label ?? profile.ssh?.host ?? profile.id })),
                            ]}
                          />
                        </div>
                      ) : null}
                      <div className="workspace-dialog__host-fields workspace-dialog__full-width">
                        <label className="field">
                          <span className="field__label">Host</span>
                          <input className="field__input" value={sshHost} disabled={busy} onChange={(event) => { invalidateSsh(); setSshHost(event.target.value); }} placeholder="example.com" autoCapitalize="none" spellCheck={false} />
                        </label>
                        <label className="field">
                          <span className="field__label">Port</span>
                          <input className="field__input" inputMode="numeric" value={sshPort} disabled={busy} onChange={(event) => { invalidateSsh(); setSshPort(event.target.value); }} />
                        </label>
                      </div>
                      <label className="field">
                        <span className="field__label">Username</span>
                        <input className="field__input" value={sshUsername} disabled={busy} onChange={(event) => { invalidateSsh(); setSshUsername(event.target.value); }} placeholder="Your server username" autoCapitalize="none" spellCheck={false} />
                      </label>
                      <label className="field">
                        <span className="field__label">Password (this session only)</span>
                        <input className="field__input" type="password" value={sshPassword} disabled={busy} onChange={(event) => { invalidateSsh(); setSshPassword(event.target.value); }} autoComplete="new-password" placeholder="Optional" />
                      </label>
                      <details className="workspace-dialog__details workspace-dialog__full-width">
                        <summary>Private key &amp; host verification</summary>
                        <div className="workspace-dialog__advanced-fields">
                          <label className="field">
                            <span className="field__label">Private key path (optional)</span>
                            <input className="field__input" value={sshPrivateKeyPath} disabled={busy} onChange={(event) => { invalidateSsh(); setSshPrivateKeyPath(event.target.value); }} placeholder="Path on this computer" spellCheck={false} />
                          </label>
                          <div className="field">
                            <span className="field__label" id="workspace-host-key-label">Host key verification</span>
                            <Dropdown<"strict" | "accept-new">
                              aria-labelledby="workspace-host-key-label"
                              value={sshPolicy}
                              disabled={busy}
                              onChange={(next) => { invalidateSsh(); setSshPolicy(next); }}
                              options={[
                                { value: "strict", label: "Strict: require a known host key" },
                                { value: "accept-new", label: "Trust first key automatically; reject changed keys" },
                              ]}
                            />
                          </div>
                        </div>
                      </details>
                      <div className="workspace-dialog__security-note workspace-dialog__full-width"><Icon name="shield" /><p>{sshPolicy === "strict" ? "Host keys are checked against known hosts. Unknown keys must be verified before connecting." : "The first host key will be trusted automatically. Changed keys are always rejected."}</p></div>
                    </div>
                  )}
                  {configWarning ? <details className="workspace-dialog__details workspace-dialog__warning"><summary>SSH config discovery notice</summary><p>{configWarning}</p></details> : null}
                </form>
              )}
            </>
          ) : null}

          {selectingFolder ? (
            <section className="workspace-dialog__folder" aria-labelledby="workspace-folder-title">
              {kind === "wsl" && win ? (
                distros.length > 0 ? <div className="field"><span className="field__label" id="workspace-distro-label">Distro</span><Dropdown aria-labelledby="workspace-distro-label" value={selectedDistro} disabled={busy} onChange={setSelectedDistro} options={distros.map((distro) => ({ value: distro, label: distro }))} /></div> : <p className="modal__hint">No distros listed. The default WSL distro will be used.</p>
              ) : null}
              <div>
                <h3 ref={folderHeadingRef} tabIndex={-1} id="workspace-folder-title" className="workspace-dialog__section-title">Choose a folder</h3>
                <p className="modal__hint">Browse to your project, or enter its full path.</p>
              </div>
              <div className="wsl-browser">
                <form className="wsl-browser__toolbar" onSubmit={(event) => { event.preventDefault(); if (!browseLoading && !busy) browseFolder(pathInput); }}>
                  <button type="button" className="btn btn--ghost btn--icon" aria-label="Up" title="Parent folder" disabled={!parent || browseLoading || busy} onClick={() => { if (parent) browseFolder(parent); }}><Icon name="arrow-up" /></button>
                  <input className="field__input wsl-browser__path" aria-label="Folder path" value={pathInput} disabled={browseLoading || busy} onChange={(event) => setPathInput(event.target.value)} autoCapitalize="none" spellCheck={false} />
                  <button type="submit" className="btn btn--ghost btn--small" disabled={!pathChanged || browseLoading || busy}>Go</button>
                </form>
                <ul className={`wsl-browser__list${browseLoading ? " is-loading" : ""}`} aria-label={kind === "ssh" ? "Remote folders" : "Folders"} aria-busy={browseLoading}>
                  {browseLoading ? <li className="wsl-browser__empty" role="status">Loading folders…</li> : dirs.length === 0 ? <li className="wsl-browser__empty">No subfolders. You can open this folder.</li> : dirs.map((directory) => (
                    <li key={directory.name}>
                      <button type="button" className="wsl-browser__row" disabled={busy || browseLoading} onClick={() => browseFolder(joinPosix(browsePath, directory.name))}>
                        <Icon name="folder" className="wsl-browser__icon" />
                        <span className="wsl-browser__name" title={directory.name}>{directory.name}</span>
                        <Icon name="chevron-right" className="wsl-browser__chevron" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {pathChanged ? <p className="modal__hint">Press Enter or Go to load this path before opening it.</p> : null}
            </section>
          ) : kind === "local" ? (
            <div className="workspace-dialog__local">
              <Icon name="folder-opened" />
              <strong>Local workspace</strong>
              <p className="modal__hint">Choose a project folder on this computer.<br />Your terminal, Git and comments will stay local.</p>
            </div>
          ) : null}
          {error ? <p ref={errorRef} tabIndex={-1} className="modal__error" role="alert">{error}</p> : null}
        </div>

        <footer className="modal__footer workspace-dialog__footer">
          <div className="workspace-dialog__footer-context" aria-live="polite">
            {selectingFolder ? <><span>Selected folder</span><strong title={browsePath}>{browsePath}</strong></> : <span>{kind === "ssh" ? (busy ? "Connecting to your host…" : "Next: choose a project folder") : "Select a folder to get started"}</span>}
          </div>
          <button type="button" className="btn btn--ghost" onClick={closeDialog} disabled={openingWorkspace}>Cancel</button>
          {kind === "ssh" && !connectedSshProfileId ? (
            <button type="submit" form="ssh-connection-form" className="btn btn--accent" disabled={busy || !connectionReady}>
              {busy ? "Connecting…" : "Connect"}{!busy ? <Icon name="arrow-right" /> : null}
            </button>
          ) : kind === "local" ? (
            <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void chooseLocal()}>{busy ? "Opening…" : "Choose folder…"}</button>
          ) : (
            <button type="button" className="btn btn--accent" disabled={busy || !browsePath.startsWith("/") || browseLoading || pathChanged} onClick={() => void (kind === "ssh" ? chooseSsh() : chooseWsl())}>{openingWorkspace || busy ? "Opening…" : "Open Workspace"}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
