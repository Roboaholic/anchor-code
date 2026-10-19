import type { HostKind, HostSession } from "./types.js";
import { HostError } from "./types.js";
import { LocalHostSession } from "./localHost.js";
import { OpenSshHostSession } from "./openSshHost.js";
import { isSshConfigAlias } from "./sshConfig.js";
import { SshHostSession } from "./sshHost.js";
import { WslHostSession, listWslDistros } from "./wslHost.js";
import type { HostProfile } from "../settings.js";

/**
 * Owns the single active HostSession used by workspace / history / terminal.
 */
export class HostManager {
  private active: HostSession;
  private activeProfileConfig: string | undefined;

  constructor(initial?: HostSession) {
    this.active = initial ?? new LocalHostSession();
  }

  get session(): HostSession {
    return this.active;
  }

  get kind(): HostKind {
    return this.active.kind;
  }

  get profileId(): string {
    return this.active.profileId;
  }

  /**
   * Switch to the host for the given profile. No-op if already that profile.
   * Disposes the previous session (and its PTYs).
   */
  async useProfile(profile: HostProfile): Promise<HostSession> {
    if (
      this.active.profileId === profile.id &&
      this.active.kind === profile.kind &&
      (profile.kind !== "ssh" || this.activeProfileConfig === JSON.stringify(profile.ssh))
    ) {
      return this.active;
    }
    const next = createHostForProfile(profile);
    const prev = this.active;
    this.active = next;
    this.activeProfileConfig = JSON.stringify(profile.ssh);
    try {
      await prev.dispose();
    } catch (err) {
      console.warn("[host] dispose previous session failed:", err);
    }
    return this.active;
  }

  async ensureLocal(): Promise<HostSession> {
    if (this.active.kind === "local") return this.active;
    return this.useProfile({ id: "local-default", kind: "local" });
  }

  async dispose(): Promise<void> {
    await this.active.dispose();
  }
}

export function createHostForProfile(profile: HostProfile): HostSession {
  switch (profile.kind) {
    case "local":
      return new LocalHostSession(undefined, profile.id);
    case "wsl": {
      if (process.platform !== "win32") {
        throw new HostError(
          "failed",
          "WSL host is only available on Windows",
        );
      }
      return new WslHostSession({
        profileId: profile.id,
        distro: profile.wsl?.distro,
        user: profile.wsl?.user,
      });
    }
    case "ssh": {
      if (profile.ssh?.configHost) {
        if (!isSshConfigAlias(profile.ssh.configHost)) throw new HostError("failed", "Invalid SSH config host alias");
        return new OpenSshHostSession({ profileId: profile.id, configHost: profile.ssh.configHost });
      }
      if (!profile.ssh?.host || !profile.ssh?.username) {
        throw new HostError(
          "failed",
          "SSH host profile is missing host or username",
        );
      }
      return new SshHostSession({
        profileId: profile.id,
        host: profile.ssh.host,
        port: profile.ssh.port,
        username: profile.ssh.username,
        privateKeyPath: profile.ssh.privateKeyPath,
        password: profile.ssh.password,
        knownHostsPolicy: profile.ssh.knownHostsPolicy,
      });
    }
    default: {
      const _exhaustive: never = profile.kind;
      throw new HostError("failed", `Unknown host kind: ${String(_exhaustive)}`);
    }
  }
}

export { listWslDistros };
