import type { HostSession } from "../host/types.js";
import {
  loadSettings,
  saveSettings,
  type AgentCliProfile,
} from "../settings.js";

/** Built-in candidates scanned on the active host. */
export const BUILTIN_AGENT_CANDIDATES: Omit<
  AgentCliProfile,
  "detected" | "enabled"
>[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [] },
  { id: "codex", name: "Codex", command: "codex", args: [] },
  { id: "aider", name: "Aider", command: "aider", args: [] },
  { id: "goose", name: "Goose", command: "goose", args: [] },
  { id: "cursor-agent", name: "Cursor Agent", command: "cursor-agent", args: [] },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: [] },
];

function mergeProfiles(
  stored: AgentCliProfile[] | undefined,
): AgentCliProfile[] {
  const byId = new Map<string, AgentCliProfile>();
  for (const b of BUILTIN_AGENT_CANDIDATES) {
    byId.set(b.id, { ...b, enabled: true, detected: false });
  }
  for (const s of stored ?? []) {
    if (!s?.id || !s.command) continue;
    const prev = byId.get(s.id);
    byId.set(s.id, {
      id: s.id,
      name: s.name || prev?.name || s.id,
      command: s.command,
      args: s.args ?? prev?.args ?? [],
      enabled: s.enabled !== false,
      detected: s.detected ?? false,
    });
  }
  return [...byId.values()];
}

export async function listAgentProfiles(): Promise<AgentCliProfile[]> {
  const settings = await loadSettings();
  return mergeProfiles(settings.agentProfiles);
}

export async function saveAgentProfiles(
  profiles: AgentCliProfile[],
): Promise<AgentCliProfile[]> {
  const settings = await loadSettings();
  const next = mergeProfiles(profiles);
  settings.agentProfiles = next;
  if (
    settings.defaultAgentId &&
    !next.some((p) => p.id === settings.defaultAgentId && p.enabled !== false)
  ) {
    settings.defaultAgentId = next.find((p) => p.enabled !== false)?.id;
  }
  await saveSettings(settings);
  return next;
}

export async function upsertAgentProfile(
  profile: AgentCliProfile,
): Promise<AgentCliProfile[]> {
  const list = await listAgentProfiles();
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx]!,
      ...profile,
      command: profile.command,
      name: profile.name || list[idx]!.name,
    };
  } else {
    list.push({
      ...profile,
      enabled: profile.enabled !== false,
      detected: profile.detected ?? false,
      args: profile.args ?? [],
    });
  }
  return saveAgentProfiles(list);
}

export async function getDefaultAgentId(): Promise<string | undefined> {
  const settings = await loadSettings();
  return settings.defaultAgentId;
}

export async function setDefaultAgentId(
  id: string | undefined,
): Promise<void> {
  const settings = await loadSettings();
  settings.defaultAgentId = id;
  await saveSettings(settings);
}

/**
 * Probe `command -v` / `where` on the active host for each profile.
 * Updates `detected` flags and persists.
 */
export async function detectAgentClis(
  host: HostSession,
): Promise<AgentCliProfile[]> {
  const profiles = await listAgentProfiles();
  const updated: AgentCliProfile[] = [];
  for (const p of profiles) {
    const ok = await commandExistsOnHost(host, p.command);
    updated.push({ ...p, detected: ok });
  }
  const settings = await loadSettings();
  settings.agentProfiles = updated;
  if (!settings.defaultAgentId) {
    const first = updated.find((p) => p.detected && p.enabled !== false);
    if (first) settings.defaultAgentId = first.id;
  }
  await saveSettings(settings);
  return updated;
}

async function commandExistsOnHost(
  host: HostSession,
  command: string,
): Promise<boolean> {
  const cmd = command.trim();
  if (!cmd) return false;
  // Absolute / Windows path: ask host exists when path-like.
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      return await host.exists(cmd);
    } catch {
      return false;
    }
  }

  const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  try {
    if (host.kind === "local" && process.platform === "win32") {
      const r = await host.run(cwd, "cmd.exe", ["/d", "/s", "/c", `where ${cmd}`]);
      return r.code === 0 && r.stdout.trim().length > 0;
    }
    // POSIX / WSL / SSH
    const r = await host.run(cwd, "sh", [
      "-lc",
      `command -v ${shellSingleQuote(cmd)} >/dev/null 2>&1`,
    ]);
    return r.code === 0;
  } catch {
    return false;
  }
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
