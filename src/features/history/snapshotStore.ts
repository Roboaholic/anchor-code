import { create } from "zustand";
import type { SnapshotMeta, SnapshotProgress, SnapshotSource } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import { MERGE_START_WINDOW_MS } from "@/core/snapshots/model";
import { useDocumentStore } from "@/features/document/documentStore";

export type SnapshotFilter = "all" | SnapshotSource;

interface AgentTurnState {
  index: number;
  /** Start snapshot id of the open turn (null while the start is in flight or failed). */
  startId: string | null;
  startedAt: number;
  open: boolean;
}

export interface SnapshotState {
  snapshots: SnapshotMeta[];
  loaded: boolean;
  loading: boolean;
  creating: boolean;
  /** In-flight snapshots by id, fed by per-repo progress events. */
  progress: Record<string, SnapshotProgress>;
  comparing: boolean;
  error: string | null;
  filter: SnapshotFilter;
  selected: string[];
  autoEnabled: boolean;
  turns: Record<string, AgentTurnState>;

  load: () => Promise<void>;
  reset: () => void;
  create: (name?: string) => Promise<SnapshotMeta | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilter: (filter: SnapshotFilter) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  /** Click = vs current worktree; two ids = between them. */
  openCompare: (baseId: string, targetId?: string) => Promise<void>;
  loadAuto: () => Promise<void>;
  setAuto: (enabled: boolean) => Promise<void>;
  agentTurnStarted: (tabId: string, label: string) => Promise<void>;
  agentTurnEnded: (tabId: string, label: string) => Promise<void>;
}

function api() {
  return typeof window !== "undefined" ? window.anchor?.snapshot : undefined;
}

function upsert(list: SnapshotMeta[], meta: SnapshotMeta): SnapshotMeta[] {
  return [meta, ...list.filter((s) => s.id !== meta.id)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  snapshots: [],
  loaded: false,
  loading: false,
  creating: false,
  progress: {},
  comparing: false,
  error: null,
  filter: "all",
  selected: [],
  autoEnabled: true,
  turns: {},

  load: async () => {
    const a = api();
    if (!a) return;
    set({ loading: true });
    try {
      const snapshots = await a.list();
      set({ snapshots, loaded: true, loading: false, error: null });
    } catch (err) {
      set({ loading: false, loaded: true, error: formatError(err) });
    }
  },

  reset: () => set({ snapshots: [], loaded: false, selected: [], turns: {}, error: null }),

  create: async (name) => {
    const a = api();
    if (!a) return null;
    set({ creating: true, error: null });
    try {
      const meta = await a.create({ source: "manual", ...(name?.trim() ? { name: name.trim() } : {}) });
      set((s) => ({ snapshots: upsert(s.snapshots, meta), creating: false }));
      return meta;
    } catch (err) {
      set({ creating: false, error: formatError(err) });
      return null;
    }
  },

  rename: async (id, name) => {
    const clean = name.trim();
    if (!clean) return;
    set((s) => ({ snapshots: s.snapshots.map((x) => (x.id === id ? { ...x, name: clean } : x)) }));
    try {
      await api()?.rename({ id, name: clean });
    } catch (err) {
      set({ error: formatError(err) });
      void get().load();
    }
  },

  remove: async (id) => {
    set((s) => ({
      snapshots: s.snapshots.filter((x) => x.id !== id),
      selected: s.selected.filter((x) => x !== id),
    }));
    try {
      await api()?.remove({ ids: [id] });
    } catch (err) {
      set({ error: formatError(err) });
      void get().load();
    }
  },

  setFilter: (filter) => set({ filter }),

  toggleSelected: (id) =>
    set((s) => {
      if (s.selected.includes(id)) return { selected: s.selected.filter((x) => x !== id) };
      // Keep the two most recent picks.
      return { selected: [...s.selected, id].slice(-2) };
    }),

  clearSelection: () => set({ selected: [] }),

  openCompare: async (baseId, targetId) => {
    const a = api();
    if (!a) return;
    set({ comparing: true, error: null });
    try {
      const payload = await a.compare({ baseId, targetId: targetId ?? "worktree" });
      useDocumentStore.getState().openSnapshotDiff(payload);
      set({ comparing: false });
    } catch (err) {
      set({ comparing: false, error: formatError(err) });
    }
  },

  loadAuto: async () => {
    try {
      const enabled = await api()?.getAuto();
      if (typeof enabled === "boolean") set({ autoEnabled: enabled });
    } catch {
      // optional
    }
  },

  setAuto: async (enabled) => {
    set({ autoEnabled: enabled });
    try {
      await api()?.setAuto(enabled);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },

  agentTurnStarted: async (tabId, label) => {
    const a = api();
    if (!a || !get().autoEnabled) return;
    const now = Date.now();
    const prev = get().turns[tabId];
    // Merge rapid re-starts (e.g. several prompts within 5 s) into one turn.
    if (prev?.open && now - prev.startedAt < MERGE_START_WINDOW_MS) return;
    const index = (prev?.index ?? 0) + 1;
    set((s) => ({ turns: { ...s.turns, [tabId]: { index, startId: null, startedAt: now, open: true } } }));
    try {
      const meta = await a.create({
        source: "auto",
        name: `第 ${index} 轮开始`,
        agentTabId: tabId,
        agentLabel: label,
        turn: { index, phase: "start" },
      });
      set((s) => ({
        snapshots: upsert(s.snapshots, meta),
        turns: s.turns[tabId]?.index === index
          ? { ...s.turns, [tabId]: { ...s.turns[tabId]!, startId: meta.id } }
          : s.turns,
      }));
    } catch {
      // Auto snapshots are best-effort; never interrupt the agent.
    }
  },

  agentTurnEnded: async (tabId, label) => {
    const a = api();
    const turn = get().turns[tabId];
    if (!a || !turn?.open) return;
    set((s) => ({ turns: { ...s.turns, [tabId]: { ...turn, open: false } } }));
    try {
      const meta = await a.create({
        source: "auto",
        name: `第 ${turn.index} 轮结束`,
        agentTabId: tabId,
        agentLabel: label,
        turn: { index: turn.index, phase: "end" },
        ...(turn.startId ? { pairWithId: turn.startId } : {}),
      });
      // `empty` stays in metadata only; a single snapshot carries no change info in the UI.
      set((s) => ({ snapshots: upsert(s.snapshots, meta) }));
    } catch {
      // best-effort
    }
  },
}));

export function filterSnapshots(list: SnapshotMeta[], filter: SnapshotFilter): SnapshotMeta[] {
  return filter === "all" ? list : list.filter((s) => s.source === filter);
}

/** Keep a finished snapshot's bar briefly so the last step is visible. */
const PROGRESS_LINGER_MS = 600;

export function applySnapshotProgress(p: SnapshotProgress): void {
  useSnapshotStore.setState((s) => ({ progress: { ...s.progress, [p.id]: p } }));
  if (p.done >= p.total) {
    setTimeout(() => {
      useSnapshotStore.setState((s) => {
        if (!(p.id in s.progress)) return s;
        const { [p.id]: _gone, ...rest } = s.progress;
        return { progress: rest };
      });
    }, PROGRESS_LINGER_MS);
  }
}

api()?.onProgress?.(applySnapshotProgress);
