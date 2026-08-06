import type { HostManager } from "../host/hostManager.js";
import { HostError } from "../host/types.js";
import {
  detectAgentClis,
  getDefaultAgentId,
  listAgentProfiles,
  saveAgentProfiles,
  setDefaultAgentId,
  upsertAgentProfile,
} from "../services/agentCli.js";
import { buildAgentLaunchArgs, buildAgentResumeArgs, discoverAgentLaunchOptions } from "../services/agentLaunch.js";
import {
  listAgentSessionIds,
  readAgentSessionTitle,
  waitForCreatedAgentSession,
} from "../services/agentSessionIdentity.js";
import type { TerminalService } from "../services/terminalService.js";
import type { CreateAgentSessionInput } from "../../contracts/remote-api/v1/index.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";

export class AgentFacade {
  private readonly titleWatchers = new Set<string>();
  private readonly claimedSessions = new Set<string>();

  constructor(
    private readonly hosts: HostManager,
    private readonly terminal: TerminalService,
    private readonly workspace: WorkspaceFacade,
  ) {}

  async listProfiles() {
    return {
      profiles: await listAgentProfiles(),
      defaultAgentId: await getDefaultAgentId(),
    };
  }

  profiles() { return listAgentProfiles(); }
  detect() { return detectAgentClis(this.hosts.session); }
  saveProfiles(profiles: Parameters<typeof saveAgentProfiles>[0]) { return saveAgentProfiles(profiles); }
  upsertProfile(profile: Parameters<typeof upsertAgentProfile>[0]) { return upsertAgentProfile(profile); }
  defaultId() { return getDefaultAgentId(); }
  setDefaultId(id?: string) { return setDefaultAgentId(id); }
  buildLaunchArgs(profileId: string, input: { model?: string; effort?: string; prompt?: string }) {
    return buildAgentLaunchArgs(profileId, input);
  }

  async launchOptions(
    profileId: string,
    options?: Parameters<typeof discoverAgentLaunchOptions>[2],
  ) {
    return discoverAgentLaunchOptions(this.hosts.session, profileId, options);
  }

  private watchSessionTitle(
    host: HostManager["session"],
    tabId: string,
    profileId: string,
    sessionId: string,
  ): void {
    const key = `${host.id}:${tabId}:${sessionId}`;
    if (this.titleWatchers.has(key)) return;
    this.titleWatchers.add(key);
    void (async () => {
      try {
        for (;;) {
          const current = this.terminal.list().find((tab) => tab.id === tabId);
          if (
            !current ||
            current.status !== "running" ||
            current.agentId !== profileId ||
            current.agentSessionId !== sessionId
          ) return;
          const title = await readAgentSessionTitle(host, profileId, sessionId);
          const latest = this.terminal.list().find((tab) => tab.id === tabId);
          if (
            title &&
            latest?.agentId === profileId &&
            latest.agentSessionId === sessionId
          ) {
            this.terminal.setAgentTitle(tabId, title);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      } finally {
        this.titleWatchers.delete(key);
      }
    })().catch(() => undefined);
  }


  async createSession(input: CreateAgentSessionInput) {
    const profiles = await listAgentProfiles();
    const profile = profiles.find((item) => item.id === input.profileId && item.enabled !== false);
    if (!profile) throw new HostError("not_found", `Agent profile not found: ${input.profileId}`);
    const prompt = input.prompt?.trim();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const fallbackTitle = [profile.name.trim() || profile.id, input.model, input.effort, time]
      .filter(Boolean)
      .join(" · ");
    const extra = input.resume && input.sessionId
      ? buildAgentResumeArgs(profile.id, input.sessionId)
      : buildAgentLaunchArgs(profile.id, {
          model: input.model,
          effort: input.effort,
          prompt: prompt || undefined,
        });
    if (!extra) {
      throw new HostError(
        "failed",
        input.resume
          ? `Exact session id required to resume ${profile.name}`
          : `Agent launch failed: ${profile.name}`,
      );
    }
    const host = this.hosts.session;
    const previousSessionIds = input.resume
      ? new Set<string>()
      : await listAgentSessionIds(host, profile.id);
    const session = await this.terminal.create({
      cwd: this.workspace.root(),
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      kind: "agent",
      command: profile.command,
      args: [...(profile.args ?? []), ...extra],
      title: prompt || fallbackTitle,
      agentId: profile.id,
      agentSessionId: input.sessionId,
    });
    if (!input.resume) {
      void waitForCreatedAgentSession(
        host,
        profile.id,
        previousSessionIds,
        undefined,
        (sessionId) => {
          const key = `${host.id}:${profile.id}:${sessionId}`;
          if (this.claimedSessions.has(key)) return false;
          this.claimedSessions.add(key);
          return true;
        },
      ).then((sessionId) => {
        if (sessionId) {
          this.terminal.setAgentSessionId(session.id, sessionId);
          this.watchSessionTitle(host, session.id, profile.id, sessionId);
        }
      }).catch(() => undefined);
    } else if (input.sessionId) {
      this.watchSessionTitle(host, session.id, profile.id, input.sessionId);
    }
    return prompt ? this.terminal.rename(session.id, prompt) ?? session : session;
  }
}
