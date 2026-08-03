import type { HostManager } from "../host/hostManager.js";
import { hostBasename, hostJoin, hostNormalize } from "../host/paths.js";
import { HostError } from "../host/types.js";
import type { TerminalService } from "../services/terminalService.js";
import {
  getHostProfile,
  loadSettings,
  pushRecentWorkspace,
  type AppSettings,
  type HostProfile,
  type RecentWorkspace,
} from "../settings.js";
import type {
  RemoteWorkspaceCatalog,
  RemoteWorkspaceRef,
} from "../../contracts/remote-api/v1/index.js";
import type { WorkspaceChangeSource } from "./applicationEvents.js";

export interface WorkspaceRegistry {
  load: () => Promise<Pick<AppSettings, "recentWorkspaces" | "hostProfiles">>;
  getHostProfile: (profileId: string) => Promise<HostProfile | null>;
  pushRecent: (path: string, hostProfileId: string) => Promise<RecentWorkspace[]>;
}

export class WorkspaceFacade {
  constructor(
    private readonly hosts: HostManager,
    private readonly terminal: TerminalService,
    private readonly onChanged?: (workspace: {
      path: string;
      name: string;
      hostProfileId: string;
      hostKind: string;
    }, source: WorkspaceChangeSource) => void,
    private readonly registry: WorkspaceRegistry = {
      load: loadSettings,
      getHostProfile,
      pushRecent: pushRecentWorkspace,
    },
  ) {}

  root(): string {
    const root = this.hosts.session.workspaceRoot;
    if (!root) throw new HostError("failed", "No workspace is open on the PC");
    return root;
  }

  current() {
    const host = this.hosts.session;
    const root = this.root();
    return {
      path: root,
      name: hostBasename(host.kind, root) || root,
      hostProfileId: host.profileId,
      hostKind: host.kind,
    };
  }

  active() {
    const host = this.hosts.session;
    const root = host.workspaceRoot;
    return root
      ? {
          path: root,
          name: hostBasename(host.kind, root) || root,
          hostProfileId: host.profileId,
          hostKind: host.kind,
        }
      : null;
  }

  hostInfo() {
    const host = this.hosts.session;
    return {
      id: host.id,
      kind: host.kind,
      profileId: host.profileId,
      workspaceRoot: host.workspaceRoot,
    };
  }

  listDir(path: string) { return this.hosts.session.listDir(path); }
  stat(path: string) { return this.hosts.session.stat(path); }

  safePath(input?: string | null): string {
    const host = this.hosts.session;
    const root = hostNormalize(host.kind, this.root());
    const candidate = input
      ? hostNormalize(
          host.kind,
          input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input)
            ? input
            : hostJoin(host.kind, root, input),
        )
      : root;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    const insensitive = host.kind === "local" && process.platform === "win32";
    const left = insensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
    const prefix = insensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (left !== prefix && !left.startsWith(`${prefix}/`)) {
      throw new HostError("permission", "Path is outside the active workspace");
    }
    return candidate;
  }

  /** Resolve a file path and require it to remain inside the supplied repo. */
  safeRepoPath(repoRoot: string, input: string): string {
    const host = this.hosts.session;
    const root = hostNormalize(host.kind, repoRoot);
    const candidate = hostNormalize(
      host.kind,
      input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input)
        ? input
        : hostJoin(host.kind, root, input),
    );
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    const insensitive = host.kind === "local" && process.platform === "win32";
    const left = insensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
    const prefix = insensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (left !== prefix && !left.startsWith(`${prefix}/`)) {
      throw new HostError("permission", "Path is outside the repository");
    }
    return candidate;
  }

  async listApproved(): Promise<RemoteWorkspaceCatalog> {
    const settings = await this.registry.load();
    const active = this.hosts.session;
    return {
      active: active.workspaceRoot
        ? { path: active.workspaceRoot, hostProfileId: active.profileId }
        : null,
      recent: settings.recentWorkspaces.map((workspace) => {
        const profile = settings.hostProfiles.find((item) => item.id === workspace.hostProfileId);
        return {
          ...workspace,
          name: workspace.path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || workspace.path,
          hostKind: profile?.kind ?? "local",
          hostLabel: profile?.label || profile?.kind || workspace.hostProfileId,
        };
      }),
    };
  }

  async open(
    input: RemoteWorkspaceRef,
    options: { requireApproved?: boolean; source?: WorkspaceChangeSource } = {},
  ): Promise<{ root: string; name: string; hostKind: string; hostProfileId: string }> {
    if (!input.path || !input.hostProfileId) throw new HostError("failed", "Invalid workspace");
    if (options.requireApproved) {
      const settings = await this.registry.load();
      const approved = settings.recentWorkspaces.some(
        (item) => item.path === input.path && item.hostProfileId === input.hostProfileId,
      );
      if (!approved) {
        throw new HostError("permission", "Workspace must be opened on the PC before remote selection");
      }
    }
    if (input.hostProfileId !== this.hosts.profileId) {
      const profile = await this.registry.getHostProfile(input.hostProfileId);
      if (!profile) throw new HostError("not_found", `Host profile not found: ${input.hostProfileId}`);
      this.terminal.disposeAll();
      await this.hosts.useProfile(profile);
    }
    const host = this.hosts.session;
    const resolved = hostNormalize(host.kind, input.path);
    if (!(await host.exists(resolved))) throw new HostError("not_found", `Directory not found: ${resolved}`);
    const stat = await host.stat(resolved);
    if (!stat.isDir) throw new HostError("failed", `Not a directory: ${resolved}`);
    this.terminal.disposeAll();
    host.workspaceRoot = resolved;
    await this.registry.pushRecent(resolved, host.profileId);
    const current = {
      path: resolved,
      name: hostBasename(host.kind, resolved) || resolved,
      hostProfileId: host.profileId,
      hostKind: host.kind,
    };
    this.onChanged?.(current, options.source ?? "desktop");
    return {
      root: resolved,
      name: current.name,
      hostKind: host.kind,
      hostProfileId: host.profileId,
    };
  }
}
