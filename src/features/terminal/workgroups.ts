export const DEFAULT_WORKGROUP_ID = "default";
export const DEFAULT_WORKGROUP_NAME = "Default";
export const WORKSPACE_WORKGROUPS_KEY = "anchor.workspace.workgroups.v1";

export type AgentWorkgroup = {
  id: string;
  name: string;
  createdAt: string;
  lastProfileId?: string;
};

export type WorkgroupsState = {
  groups: AgentWorkgroup[];
  activeGroupId: string;
  /** CLI session id → workgroup, kept after a PTY tab is closed. */
  sessionGroupById: Record<string, string>;
};

export function createDefaultWorkgroup(now = new Date()): AgentWorkgroup {
  return {
    id: DEFAULT_WORKGROUP_ID,
    name: DEFAULT_WORKGROUP_NAME,
    createdAt: now.toISOString(),
  };
}

export function emptyWorkgroupsState(now = new Date()): WorkgroupsState {
  return {
    groups: [createDefaultWorkgroup(now)],
    activeGroupId: DEFAULT_WORKGROUP_ID,
    sessionGroupById: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asGroup(value: unknown): AgentWorkgroup | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !rec.id.trim()) return null;
  if (typeof rec.name !== "string" || !rec.name.trim()) return null;
  const group: AgentWorkgroup = {
    id: rec.id.trim(),
    name: rec.name.trim().slice(0, 80),
    createdAt:
      typeof rec.createdAt === "string" && rec.createdAt
        ? rec.createdAt
        : new Date(0).toISOString(),
  };
  if (typeof rec.lastProfileId === "string" && rec.lastProfileId.trim()) {
    group.lastProfileId = rec.lastProfileId.trim();
  }
  return group;
}

export function ensureDefaultGroup(groups: AgentWorkgroup[]): AgentWorkgroup[] {
  const seen = new Set<string>();
  const unique: AgentWorkgroup[] = [];
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    unique.push(group);
  }
  const def = unique.find((group) => group.id === DEFAULT_WORKGROUP_ID);
  const rest = unique.filter((group) => group.id !== DEFAULT_WORKGROUP_ID);
  return [def ?? createDefaultWorkgroup(), ...rest];
}

export function parseWorkgroupsState(raw: unknown): WorkgroupsState {
  const fallback = emptyWorkgroupsState();
  const rec = asRecord(raw);
  if (!rec) return fallback;
  const groups = ensureDefaultGroup(
    Array.isArray(rec.groups)
      ? rec.groups.flatMap((item) => {
          const group = asGroup(item);
          return group ? [group] : [];
        })
      : [],
  );
  const ids = new Set(groups.map((group) => group.id));
  const active =
    typeof rec.activeGroupId === "string" && ids.has(rec.activeGroupId)
      ? rec.activeGroupId
      : DEFAULT_WORKGROUP_ID;
  const sessionGroupById: Record<string, string> = {};
  const sessions = asRecord(rec.sessionGroupById) ?? {};
  for (const [sessionId, groupId] of Object.entries(sessions)) {
    if (!sessionId.trim() || typeof groupId !== "string") continue;
    sessionGroupById[sessionId] = ids.has(groupId)
      ? groupId
      : DEFAULT_WORKGROUP_ID;
  }
  return { groups, activeGroupId: active, sessionGroupById };
}

export function uniqueWorkgroupName(
  groups: Array<{ name: string }>,
  base = "Workgroup",
): string {
  const names = new Set(groups.map((group) => group.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let n = 2;
  while (names.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

export function nextWorkgroupId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `wg-${crypto.randomUUID()}`;
  }
  return `wg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function removeWorkgroup(
  state: WorkgroupsState,
  id: string,
): WorkgroupsState {
  if (id === DEFAULT_WORKGROUP_ID) return state;
  if (!state.groups.some((group) => group.id === id)) return state;
  const groups = state.groups.filter((group) => group.id !== id);
  const sessionGroupById = Object.fromEntries(
    Object.entries(state.sessionGroupById).map(([sessionId, groupId]) => [
      sessionId,
      groupId === id ? DEFAULT_WORKGROUP_ID : groupId,
    ]),
  );
  return {
    groups,
    activeGroupId:
      state.activeGroupId === id ? DEFAULT_WORKGROUP_ID : state.activeGroupId,
    sessionGroupById,
  };
}

export function renameWorkgroupInState(
  state: WorkgroupsState,
  id: string,
  name: string,
): WorkgroupsState {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return state;
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === id ? { ...group, name: trimmed } : group,
    ),
  };
}

export function reassignGroupIds(
  mapping: Record<string, string>,
  fromId: string,
  toId: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, groupId]) => [
      key,
      groupId === fromId ? toId : groupId,
    ]),
  );
}

export function workgroupIdForTab(
  tabWorkgroupById: Record<string, string>,
  tabId: string,
): string {
  return tabWorkgroupById[tabId] ?? DEFAULT_WORKGROUP_ID;
}
