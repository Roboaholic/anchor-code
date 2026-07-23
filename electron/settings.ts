import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostKind } from "./host/types.js";

export interface RecentWorkspace {
  path: string;
  hostProfileId: string;
  lastOpenedAt: string;
}

export interface SshProfileConfig {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  knownHostsPolicy?: "accept-new" | "strict" | "ignore";
}

export interface WslProfileConfig {
  /** Distro name from `wsl -l -q`; omit for default. */
  distro?: string;
  user?: string;
}

export interface HostProfile {
  id: string;
  kind: HostKind;
  label?: string;
  ssh?: SshProfileConfig;
  wsl?: WslProfileConfig;
}

export interface AgentCliProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
  /** Last detect result on active host. */
  detected?: boolean;
  enabled?: boolean;
}

export interface HistoryCompareEntry {
  id: string;
  repoRoot: string;
  repoName: string;
  base: string;
  head: string | "worktree";
  label: string;
  createdAt: string;
}

export interface AppSettings {
  recentWorkspaces: RecentWorkspace[];
  hostProfiles: HostProfile[];
  /** Last used host profile for Open Workspace default. */
  lastHostProfileId?: string;
  /** External agent CLIs (Claude Code, Codex, …). */
  agentProfiles?: AgentCliProfile[];
  /** Default agent id for Agent mode "+". */
  defaultAgentId?: string;
  /**
   * Persisted model/effort discovery per host+profile.
   * Key: `${hostKind}:${hostProfileId}:${agentId}`
   */
  agentLaunchCache?: Record<string, unknown>;
  /**
   * Recent compares per workspace root → list of entries (each entry has repoRoot).
   * Key: workspace absolute path.
   */
  historyRecentCompares?: Record<string, HistoryCompareEntry[]>;
  ui: {
    terminalVisible: boolean;
    leftWidth?: number;
    rightWidth?: number;
    /** Workbench color theme. Default light. */
    theme?: "light" | "light-modern" | "dark" | "dark-modern";
  };
}

const DEFAULT_PROFILES: HostProfile[] = [
  { id: "local-default", kind: "local", label: "Local" },
  ...(process.platform === "win32"
    ? [{ id: "wsl-default", kind: "wsl" as const, label: "WSL" }]
    : []),
];

const DEFAULT_SETTINGS: AppSettings = {
  recentWorkspaces: [],
  hostProfiles: DEFAULT_PROFILES,
  lastHostProfileId:
    process.platform === "win32" ? "wsl-default" : "local-default",
  agentProfiles: [],
  agentLaunchCache: {},
  historyRecentCompares: {},
  ui: { terminalVisible: true, theme: "light" },
};

const MAX_RECENT = 12;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function normalizeProfiles(parsed: HostProfile[] | undefined): HostProfile[] {
  const list = parsed?.length ? [...parsed] : [...DEFAULT_PROFILES];
  // Ensure local default always present.
  if (!list.some((p) => p.id === "local-default")) {
    list.unshift({ id: "local-default", kind: "local", label: "Local" });
  }
  if (
    process.platform === "win32" &&
    !list.some((p) => p.kind === "wsl")
  ) {
    list.push({ id: "wsl-default", kind: "wsl", label: "WSL" });
  }
  return list;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      recentWorkspaces: parsed.recentWorkspaces ?? [],
      hostProfiles: normalizeProfiles(parsed.hostProfiles),
      lastHostProfileId:
        parsed.lastHostProfileId ?? DEFAULT_SETTINGS.lastHostProfileId,
      agentProfiles: parsed.agentProfiles ?? [],
      defaultAgentId: parsed.defaultAgentId,
      agentLaunchCache: parsed.agentLaunchCache ?? {},
      historyRecentCompares: parsed.historyRecentCompares ?? {},
      ui: { ...DEFAULT_SETTINGS.ui, ...parsed.ui },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

export async function pushRecentWorkspace(
  workspacePath: string,
  hostProfileId = "local-default",
): Promise<RecentWorkspace[]> {
  const settings = await loadSettings();
  const now = new Date().toISOString();
  const next: RecentWorkspace[] = [
    { path: workspacePath, hostProfileId, lastOpenedAt: now },
    ...settings.recentWorkspaces.filter(
      (r) => !(r.path === workspacePath && r.hostProfileId === hostProfileId),
    ),
  ].slice(0, MAX_RECENT);
  settings.recentWorkspaces = next;
  settings.lastHostProfileId = hostProfileId;
  await saveSettings(settings);
  return next;
}

export async function getHostProfile(
  profileId: string,
): Promise<HostProfile | null> {
  const settings = await loadSettings();
  return settings.hostProfiles.find((p) => p.id === profileId) ?? null;
}

export async function upsertHostProfile(
  profile: HostProfile,
): Promise<HostProfile[]> {
  const settings = await loadSettings();
  const idx = settings.hostProfiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    settings.hostProfiles[idx] = profile;
  } else {
    settings.hostProfiles.push(profile);
  }
  await saveSettings(settings);
  return settings.hostProfiles;
}

const MAX_RECENT_COMPARES_PER_REPO = 15;

export async function getHistoryRecentCompares(
  workspaceRoot: string,
): Promise<HistoryCompareEntry[]> {
  const settings = await loadSettings();
  return settings.historyRecentCompares?.[workspaceRoot] ?? [];
}

export async function pushHistoryRecentCompare(
  workspaceRoot: string,
  entry: HistoryCompareEntry,
): Promise<HistoryCompareEntry[]> {
  const settings = await loadSettings();
  const all = { ...(settings.historyRecentCompares ?? {}) };
  // Keep per-repo lists: filter workspace list then re-group… simpler: store flat list per workspace, filter by repoRoot when reading.
  const list = all[workspaceRoot] ?? [];
  // Dedupe by id within this repo's entries only for cap: keep global workspace list ordered, cap per repoRoot.
  const without = list.filter((e) => e.id !== entry.id);
  const next = [entry, ...without];
  // Cap each repo independently while preserving overall order
  const counts = new Map<string, number>();
  const capped: HistoryCompareEntry[] = [];
  for (const e of next) {
    const n = counts.get(e.repoRoot) ?? 0;
    if (n >= MAX_RECENT_COMPARES_PER_REPO) continue;
    counts.set(e.repoRoot, n + 1);
    capped.push(e);
  }
  all[workspaceRoot] = capped;
  settings.historyRecentCompares = all;
  await saveSettings(settings);
  return capped;
}

export async function removeHistoryRecentCompare(
  workspaceRoot: string,
  id: string,
): Promise<HistoryCompareEntry[]> {
  const settings = await loadSettings();
  const all = { ...(settings.historyRecentCompares ?? {}) };
  all[workspaceRoot] = (all[workspaceRoot] ?? []).filter((e) => e.id !== id);
  settings.historyRecentCompares = all;
  await saveSettings(settings);
  return all[workspaceRoot] ?? [];
}

export type UiTheme = "light" | "light-modern" | "dark" | "dark-modern";

export function normalizeTheme(value: unknown): UiTheme {
  if (
    value === "dark" ||
    value === "dark-modern" ||
    value === "light" ||
    value === "light-modern"
  ) {
    return value;
  }
  return "light";
}

export async function getUiTheme(): Promise<UiTheme> {
  const settings = await loadSettings();
  return normalizeTheme(settings.ui?.theme);
}

export async function setUiTheme(theme: UiTheme): Promise<UiTheme> {
  const settings = await loadSettings();
  const next = normalizeTheme(theme);
  settings.ui = { ...settings.ui, theme: next };
  await saveSettings(settings);
  return next;
}
