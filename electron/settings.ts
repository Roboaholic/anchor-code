import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

export interface RecentWorkspace {
  path: string;
  hostProfileId: string;
  lastOpenedAt: string;
}

export interface AppSettings {
  recentWorkspaces: RecentWorkspace[];
  hostProfiles: { id: string; kind: "local" | "ssh" }[];
  ui: {
    terminalVisible: boolean;
    leftWidth?: number;
    rightWidth?: number;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  recentWorkspaces: [],
  hostProfiles: [{ id: "local-default", kind: "local" }],
  ui: { terminalVisible: true },
};

const MAX_RECENT = 12;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      recentWorkspaces: parsed.recentWorkspaces ?? [],
      hostProfiles: parsed.hostProfiles ?? DEFAULT_SETTINGS.hostProfiles,
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
    ...settings.recentWorkspaces.filter((r) => r.path !== workspacePath),
  ].slice(0, MAX_RECENT);
  settings.recentWorkspaces = next;
  await saveSettings(settings);
  return next;
}
