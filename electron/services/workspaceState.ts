import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { hostJoin } from "../host/paths.js";
import type { HostKind, HostSession } from "../host/types.js";

export const WORKSPACE_DEFINITION_SEGMENTS = [".anchor-code", "workspace.yaml"] as const;
export const WORKSPACE_INSTANCES_FILE = "workspace-instances.yaml";

export type WorkspaceId = string;

export interface WorkspaceDefinition {
  version: 1;
  workspace?: {
    name?: string;
    kind?: "project" | "repo" | "folder";
    idHint?: string;
  };
  host?: {
    preferredKind?: HostKind;
  };
  paths?: {
    root?: string;
    defaultOpen?: string[];
    exclude?: string[];
  };
  agents?: {
    defaultProfileId?: string;
    suggestedProfiles?: string[];
  };
  ui?: {
    defaultLeftMode?: "files" | "comments" | "history";
  };
}

export interface WorkspaceUiRestoreState {
  leftMode: "files" | "comments" | "history";
  selectedPath: string | null;
  expandedDirs: string[];
  agentVisible: boolean;
  terminalVisible: boolean;
}

export type WorkspaceOpenItem =
  | { id: string; kind: "welcome" }
  | {
      id: string;
      kind: "file";
      path: string;
      mdViewMode?: "rendered" | "raw";
      cursor?: { line: number; column: number };
      scrollTop?: number;
    }
  | {
      id: string;
      kind: "preview";
      path: string;
      viewMode: "preview" | "raw";
    }
  | {
      id: string;
      kind: "diff";
      repoRoot: string;
      base: string;
      head: string | "worktree";
      path?: string | null;
    };

export interface WorkspaceDocumentRestoreState {
  activeItemId: string | null;
  openItems: WorkspaceOpenItem[];
}

export interface WorkspaceAgentRestoreState {
  activeAgentId: string | null;
  openSessions: Array<{
    id: string;
    profileId: string;
    title: string;
    cwd: string;
    terminalId?: string;
    agentSessionId?: string;
    status: "running" | "exited";
    lastOutputAt?: string;
  }>;
}

export interface WorkspaceTerminalRestoreState {
  activeTerminalId: string | null;
  openTabs: Array<{
    id: string;
    title: string;
    cwd: string;
    status: "running" | "exited";
    kind: "shell" | "agent";
  }>;
}

export interface WorkspaceRestoreState {
  ui: WorkspaceUiRestoreState;
  documents: WorkspaceDocumentRestoreState;
  agents: WorkspaceAgentRestoreState;
  terminals: WorkspaceTerminalRestoreState;
}

export interface WorkspaceInstance {
  id: WorkspaceId;
  root: string;
  name: string;
  hostProfileId: string;
  hostKind: HostKind;
  definitionPath: string | null;
  openedAt: string;
  lastActiveAt: string;
  foreground: boolean;
  restore: WorkspaceRestoreState;
}

export interface WorkspaceInstancesState {
  version: 1;
  activeWorkspaceId: WorkspaceId | null;
  openWorkspaces: WorkspaceInstance[];
}

export interface OpenWorkspaceInstanceInput {
  root: string;
  name: string;
  hostProfileId: string;
  hostKind: HostKind;
  definitionPath?: string | null;
}

function runtimePath(): string {
  return path.join(app.getPath("userData"), WORKSPACE_INSTANCES_FILE);
}

export function normalizeWorkspaceRoot(root: string, hostKind: HostKind): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return hostKind === "local" ? normalized.toLowerCase() : normalized;
}

export function workspaceInstanceId(
  hostProfileId: string,
  root: string,
  hostKind: HostKind,
): WorkspaceId {
  return `${hostProfileId || "local-default"}::${normalizeWorkspaceRoot(root, hostKind)}`;
}

export function workspaceDefinitionPath(hostKind: HostKind, root: string): string {
  return hostJoin(hostKind, root, ...WORKSPACE_DEFINITION_SEGMENTS);
}

export function defaultWorkspaceRestoreState(): WorkspaceRestoreState {
  return {
    ui: {
      leftMode: "files",
      selectedPath: null,
      expandedDirs: [],
      agentVisible: false,
      terminalVisible: false,
    },
    documents: {
      activeItemId: null,
      openItems: [],
    },
    agents: {
      activeAgentId: null,
      openSessions: [],
    },
    terminals: {
      activeTerminalId: null,
      openTabs: [],
    },
  };
}
export function defaultWorkspaceDefinition(
  name: string,
  hostKind: HostKind,
): WorkspaceDefinition {
  return {
    version: 1,
    workspace: {
      name,
      kind: "project",
      idHint: name,
    },
    host: {
      preferredKind: hostKind,
    },
    paths: {
      root: ".",
      defaultOpen: [],
      exclude: ["node_modules", "dist", "dist-electron", "release", ".git"],
    },
    ui: {
      defaultLeftMode: "files",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRestoreState(value: unknown): WorkspaceRestoreState {
  const fallback = defaultWorkspaceRestoreState();
  if (!isRecord(value)) return fallback;
  const ui = isRecord(value.ui) ? value.ui : {};
  const documents = isRecord(value.documents) ? value.documents : {};
  const agents = isRecord(value.agents) ? value.agents : {};
  const terminals = isRecord(value.terminals) ? value.terminals : {};
  const leftMode = ui.leftMode;
  return {
    ui: {
      leftMode:
        leftMode === "comments" || leftMode === "history" ? leftMode : "files",
      selectedPath: asString(ui.selectedPath) ?? null,
      expandedDirs: Array.isArray(ui.expandedDirs)
        ? ui.expandedDirs.filter((item): item is string => typeof item === "string")
        : [],
      agentVisible: ui.agentVisible === true,
      terminalVisible: ui.terminalVisible === true,
    },
    documents: {
      activeItemId: asString(documents.activeItemId) ?? null,
      openItems: Array.isArray(documents.openItems)
        ? (documents.openItems.filter(isRecord) as WorkspaceOpenItem[])
        : [],
    },
    agents: {
      activeAgentId: asString(agents.activeAgentId) ?? null,
      openSessions: Array.isArray(agents.openSessions)
        ? (agents.openSessions.filter(isRecord) as WorkspaceAgentRestoreState["openSessions"])
        : [],
    },
    terminals: {
      activeTerminalId: asString(terminals.activeTerminalId) ?? null,
      openTabs: Array.isArray(terminals.openTabs)
        ? (terminals.openTabs.filter(isRecord) as WorkspaceTerminalRestoreState["openTabs"])
        : [],
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeDefinition(value: unknown): WorkspaceDefinition | null {
  if (!isRecord(value)) return null;
  const version = value.version === 1 ? 1 : null;
  if (!version) return null;
  const workspace = isRecord(value.workspace) ? value.workspace : undefined;
  const host = isRecord(value.host) ? value.host : undefined;
  const paths = isRecord(value.paths) ? value.paths : undefined;
  const agents = isRecord(value.agents) ? value.agents : undefined;
  const ui = isRecord(value.ui) ? value.ui : undefined;
  const preferredKind = host?.preferredKind;
  const defaultLeftMode = ui?.defaultLeftMode;
  return {
    version,
    workspace: workspace
      ? {
          name: asString(workspace.name),
          kind:
            workspace.kind === "repo" ||
            workspace.kind === "folder" ||
            workspace.kind === "project"
              ? workspace.kind
              : undefined,
          idHint: asString(workspace.idHint),
        }
      : undefined,
    host: host
      ? {
          preferredKind:
            preferredKind === "local" || preferredKind === "wsl" || preferredKind === "ssh"
              ? preferredKind
              : undefined,
        }
      : undefined,
    paths: paths
      ? {
          root: asString(paths.root),
          defaultOpen: Array.isArray(paths.defaultOpen)
            ? paths.defaultOpen.filter((item): item is string => typeof item === "string")
            : undefined,
          exclude: Array.isArray(paths.exclude)
            ? paths.exclude.filter((item): item is string => typeof item === "string")
            : undefined,
        }
      : undefined,
    agents: agents
      ? {
          defaultProfileId: asString(agents.defaultProfileId),
          suggestedProfiles: Array.isArray(agents.suggestedProfiles)
            ? agents.suggestedProfiles.filter((item): item is string => typeof item === "string")
            : undefined,
        }
      : undefined,
    ui: ui
      ? {
          defaultLeftMode:
            defaultLeftMode === "comments" || defaultLeftMode === "history"
              ? defaultLeftMode
              : "files",
        }
      : undefined,
  };
}

export async function readWorkspaceDefinition(
  host: HostSession,
  root: string,
): Promise<{ path: string; definition: WorkspaceDefinition } | null> {
  const file = workspaceDefinitionPath(host.kind, root);
  try {
    if (!(await host.exists(file))) return null;
    const raw = await host.readFile(file);
    const definition = normalizeDefinition(parse(raw));
    return definition ? { path: file, definition } : null;
  } catch {
    return null;
  }
}
export async function ensureWorkspaceDefinition(
  host: HostSession,
  root: string,
  name: string,
): Promise<{ path: string; definition: WorkspaceDefinition; created: boolean }> {
  const existing = await readWorkspaceDefinition(host, root);
  if (existing) return { ...existing, created: false };
  const file = workspaceDefinitionPath(host.kind, root);
  const dir = hostJoin(host.kind, root, WORKSPACE_DEFINITION_SEGMENTS[0]);
  const definition = defaultWorkspaceDefinition(name, host.kind);
  await host.mkdirp(dir);
  await host.writeFile(file, stringify(definition));
  return { path: file, definition, created: true };
}

function normalizeWorkspaceInstance(value: unknown): WorkspaceInstance | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const root = asString(value.root);
  const name = asString(value.name);
  const hostProfileId = asString(value.hostProfileId);
  const hostKind = value.hostKind;
  if (!id || !root || !name || !hostProfileId) return null;
  if (hostKind !== "local" && hostKind !== "wsl" && hostKind !== "ssh") return null;
  return {
    id,
    root,
    name,
    hostProfileId,
    hostKind,
    definitionPath: asString(value.definitionPath) ?? null,
    openedAt: asString(value.openedAt) ?? new Date().toISOString(),
    lastActiveAt: asString(value.lastActiveAt) ?? new Date().toISOString(),
    foreground: value.foreground === true,
    restore: normalizeRestoreState(value.restore),
  };
}

export async function loadWorkspaceInstances(): Promise<WorkspaceInstancesState> {
  try {
    const raw = await fs.readFile(runtimePath(), "utf8");
    const parsed = parse(raw);
    if (!isRecord(parsed)) throw new Error("Invalid workspace instances file");
    const openWorkspaces = Array.isArray(parsed.openWorkspaces)
      ? parsed.openWorkspaces.flatMap((item) => {
          const instance = normalizeWorkspaceInstance(item);
          return instance ? [instance] : [];
        })
      : [];
    const activeWorkspaceId = asString(parsed.activeWorkspaceId) ?? openWorkspaces[0]?.id ?? null;
    return {
      version: 1,
      activeWorkspaceId,
      openWorkspaces: openWorkspaces.map((item) => ({
        ...item,
        foreground: item.id === activeWorkspaceId,
      })),
    };
  } catch {
    return { version: 1, activeWorkspaceId: null, openWorkspaces: [] };
  }
}

export async function saveWorkspaceInstances(
  state: WorkspaceInstancesState,
): Promise<WorkspaceInstancesState> {
  const normalized: WorkspaceInstancesState = {
    version: 1,
    activeWorkspaceId: state.activeWorkspaceId,
    openWorkspaces: state.openWorkspaces.map((item) => ({
      ...item,
      foreground: item.id === state.activeWorkspaceId,
    })),
  };
  const file = runtimePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stringify(normalized), "utf8");
  return normalized;
}

export async function recordActiveWorkspaceInstance(
  input: OpenWorkspaceInstanceInput,
): Promise<WorkspaceInstance> {
  const now = new Date().toISOString();
  const previous = await loadWorkspaceInstances();
  const id = workspaceInstanceId(input.hostProfileId, input.root, input.hostKind);
  const existing = previous.openWorkspaces.find((item) => item.id === id);
  const instance: WorkspaceInstance = {
    id,
    root: input.root,
    name: input.name,
    hostProfileId: input.hostProfileId,
    hostKind: input.hostKind,
    definitionPath: input.definitionPath ?? existing?.definitionPath ?? null,
    openedAt: existing?.openedAt ?? now,
    lastActiveAt: now,
    foreground: true,
    restore: existing?.restore ?? defaultWorkspaceRestoreState(),
  };

  // The current backend owns one active workspace session. Keep the runtime file
  // semantically honest until WorkspaceSessionManager supports multiple live sessions.
  await saveWorkspaceInstances({
    version: 1,
    activeWorkspaceId: id,
    openWorkspaces: [instance],
  });
  return instance;
}