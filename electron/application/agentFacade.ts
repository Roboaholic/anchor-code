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
import { buildAgentLaunchArgs, discoverAgentLaunchOptions } from "../services/agentLaunch.js";
import type { TerminalService } from "../services/terminalService.js";
import type { CreateAgentSessionInput } from "../../contracts/remote-api/v1/index.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";

export class AgentFacade {
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
    const extra = buildAgentLaunchArgs(profile.id, {
      model: input.model,
      effort: input.effort,
      prompt: prompt || undefined,
    });
    const session = await this.terminal.create({
      cwd: this.workspace.root(),
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      kind: "agent",
      command: profile.command,
      args: [...(profile.args ?? []), ...extra],
      title: prompt || fallbackTitle,
      agentId: profile.id,
    });
    return prompt ? this.terminal.rename(session.id, prompt) ?? session : session;
  }
}
