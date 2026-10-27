import type { HostKind, HostProfile, RecentWorkspace } from "@/shared/anchor-api";

export type RecentWorkspaceView = RecentWorkspace & {
  name: string;
  hostKind: HostKind;
  hostLabel: string;
};

/** Folder name for a workspace path (POSIX or Windows). */
export function workspaceFolderName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || workspacePath;
}

/** Compact relative time for recent rows (e.g. 5m, 3h, 2d). */
export function formatRecentOpenedAt(iso: string, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const diff = Math.max(0, nowMs - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Single-line muted meta: "path · host". */
export function formatRecentMeta(path: string, hostLabel: string): string {
  const p = path.trim();
  const h = hostLabel.trim();
  if (p && h) return `${p} · ${h}`;
  return p || h;
}

export function hostIconName(kind: HostKind): "device-desktop" | "terminal-linux" | "remote" {
  if (kind === "wsl") return "terminal-linux";
  if (kind === "ssh") return "remote";
  return "device-desktop";
}

export function hostLabelForProfile(profile: HostProfile | undefined, hostProfileId: string): string {
  if (!profile) return hostProfileId;
  if (profile.label?.trim()) return profile.label.trim();
  if (profile.kind === "ssh") {
    const ssh = profile.ssh;
    if (ssh?.configHost) return ssh.configHost;
    if (ssh?.host && ssh.username) return `${ssh.username}@${ssh.host}`;
    if (ssh?.host) return ssh.host;
  }
  if (profile.kind === "wsl") {
    return profile.wsl?.distro ? `WSL (${profile.wsl.distro})` : "WSL";
  }
  return "This computer";
}

/** Join persisted recent rows with host profiles for dialog display. */
export function buildRecentWorkspaceViews(
  recent: RecentWorkspace[],
  profiles: HostProfile[],
): RecentWorkspaceView[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return recent.map((entry) => {
    const profile = byId.get(entry.hostProfileId);
    const hostKind = profile?.kind ?? "local";
    return {
      ...entry,
      name: workspaceFolderName(entry.path),
      hostKind,
      hostLabel: hostLabelForProfile(profile, entry.hostProfileId),
    };
  });
}
