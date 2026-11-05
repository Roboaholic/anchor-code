/** Multi-repo snapshot model + pure helpers (no host I/O). */

export type SnapshotSource = "manual" | "auto" | "agent";

/** Untracked file skipped from the snapshot tree because it is too large. */
export interface SnapshotLargeFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SnapshotRepoEntry {
  /** Absolute repo root on the workspace host. */
  root: string;
  name: string;
  head: string | null;
  branch: string | null;
  /** Snapshot commit sha (tree = full worktree state). Empty when status !== "ok". */
  commit: string;
  tree: string;
  /** "repo" = refs/anchor/snapshots/<id> in the repo; "external" = app-side store. */
  storage: "repo" | "external";
  /** Git dir of the external store (only when storage === "external"). */
  storeDir?: string;
  largeFiles: SnapshotLargeFile[];
  status: "ok" | "error";
  note?: string;
}

export interface SnapshotTurn {
  index: number;
  phase: "start" | "end";
}

export interface SnapshotMeta {
  v: 1;
  id: string;
  workspaceRoot: string;
  name: string;
  source: SnapshotSource;
  agentTabId?: string;
  agentLabel?: string;
  turn?: SnapshotTurn;
  /** End snapshot whose trees equal its start snapshot. */
  empty?: boolean;
  createdAt: string;
  repos: SnapshotRepoEntry[];
}

export type SnapshotDiffRepoState =
  | "changed"
  | "unchanged"
  | "added"
  | "removed"
  | "error";

export interface SnapshotLargeFileChange {
  path: string;
  size: number;
  status: "A" | "M" | "D";
}

export interface SnapshotDiffRepo {
  root: string;
  name: string;
  state: SnapshotDiffRepoState;
  /** Base / head revisions usable with history:getFileDiff. */
  base: string;
  head: string | "worktree";
  files: { path: string; status: string }[];
  largeFiles: SnapshotLargeFileChange[];
  error?: string;
}

export interface SnapshotDiffPayload {
  workspaceRoot: string;
  baseId: string;
  targetId: string | "worktree";
  title: string;
  repos: SnapshotDiffRepo[];
  overlapWarning?: string;
}

export const SNAPSHOT_REF_PREFIX = "refs/anchor/snapshots/";
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
export const AUTO_KEEP_COUNT = 500;
export const AUTO_KEEP_DAYS = 30;
export const AGENT_KEEP_DAYS = 30;
export const MERGE_START_WINDOW_MS = 5_000;
/** git's well-known empty tree (sha1 repos). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Time-sortable id: base36 ms timestamp + random suffix. */
export function newSnapshotId(now = Date.now(), rand = Math.random): string {
  const t = now.toString(36).padStart(9, "0");
  const r = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${t}-${r}`;
}

export function defaultSnapshotName(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Does a push refspec's source side match `refs/anchor/snapshots/x`? */
export function refspecCoversAnchor(spec: string): boolean {
  const src = spec.replace(/^\+/, "").split(":")[0]?.trim() ?? "";
  if (!src) return false; // ":" = matching branches only
  const target = `${SNAPSHOT_REF_PREFIX}x`;
  if (!src.includes("*")) return src.startsWith("refs/anchor/");
  const re = new RegExp(
    `^${src.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return re.test(target);
}

/**
 * Parse `git config --get-regexp '^remote\..*\.(mirror|push)$'` output.
 * True when some remote would push refs/anchor/*.
 */
export function pushExposesAnchorRefs(configOutput: string): boolean {
  for (const raw of configOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const value = sp < 0 ? "true" : line.slice(sp + 1).trim();
    if (key.endsWith(".mirror") && /^(true|yes|on|1)$/i.test(value)) return true;
    if (key.endsWith(".push") && refspecCoversAnchor(value)) return true;
  }
  return false;
}

export function diffLargeFiles(
  base: SnapshotLargeFile[],
  target: SnapshotLargeFile[],
): SnapshotLargeFileChange[] {
  const b = new Map(base.map((f) => [f.path, f]));
  const t = new Map(target.map((f) => [f.path, f]));
  const out: SnapshotLargeFileChange[] = [];
  for (const [path, f] of t) {
    const old = b.get(path);
    if (!old) out.push({ path, size: f.size, status: "A" });
    else if (old.size !== f.size || old.mtimeMs !== f.mtimeMs)
      out.push({ path, size: f.size, status: "M" });
  }
  for (const [path, f] of b) {
    if (!t.has(path)) out.push({ path, size: f.size, status: "D" });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** Ids to delete under the retention policy (manual snapshots are kept forever). */
export function retentionVictims(list: SnapshotMeta[], now = Date.now()): string[] {
  const dayMs = 86_400_000;
  const victims = new Set<string>();
  const autos = list
    .filter((s) => s.source === "auto")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  autos.forEach((s, i) => {
    if (i >= AUTO_KEEP_COUNT) victims.add(s.id);
    if (now - Date.parse(s.createdAt) > AUTO_KEEP_DAYS * dayMs) victims.add(s.id);
  });
  for (const s of list) {
    if (s.source === "agent" && now - Date.parse(s.createdAt) > AGENT_KEEP_DAYS * dayMs) {
      victims.add(s.id);
    }
  }
  return [...victims];
}

interface TurnSpan {
  agent: string;
  label: string;
  start: number;
  end: number;
  startId: string;
  endId: string | null;
}

function turnSpans(list: SnapshotMeta[], now: number): TurnSpan[] {
  const spans: TurnSpan[] = [];
  const open = new Map<string, TurnSpan>();
  const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const s of sorted) {
    if (s.source !== "auto" || !s.turn || !s.agentTabId) continue;
    const key = s.agentTabId;
    const t = Date.parse(s.createdAt);
    if (s.turn.phase === "start") {
      const span: TurnSpan = {
        agent: key,
        label: s.agentLabel ?? "agent",
        start: t,
        end: now,
        startId: s.id,
        endId: null,
      };
      open.set(key, span);
      spans.push(span);
    } else {
      const span = open.get(key);
      if (span) {
        span.end = t;
        span.endId = s.id;
        open.delete(key);
      }
    }
  }
  return spans;
}

/**
 * Warn when the compared window overlaps more than one agent turn, or only
 * part of one turn (someone else may have edited meanwhile). No attribution.
 */
export function overlapWarning(
  list: SnapshotMeta[],
  baseId: string,
  targetId: string | "worktree",
  now = Date.now(),
): string | undefined {
  const base = list.find((s) => s.id === baseId);
  if (!base) return undefined;
  const target = targetId === "worktree" ? null : list.find((s) => s.id === targetId);
  const from = Date.parse(base.createdAt);
  const to = target ? Date.parse(target.createdAt) : now;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const hits = turnSpans(list, now).filter((sp) => sp.start < hi && sp.end > lo);
  const agents = new Set(hits.map((h) => h.agent));
  if (agents.size > 1) {
    const labels = [...new Set(hits.map((h) => h.label))].join("、");
    return `这段时间有多个 agent（${labels}）同时在改，diff 无法区分是谁改的。`;
  }
  if (hits.length === 1) {
    const h = hits[0]!;
    const exact =
      (h.startId === base.id || h.start >= lo) && (h.endId === target?.id || h.end <= hi);
    if (!exact) {
      return `这段时间与 ${h.label} 的一轮改动部分重叠，diff 可能混有其他改动。`;
    }
  }
  return undefined;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export type SnapshotRepoProgressState = "pending" | "ok" | "error";

/** Streamed while a snapshot is being created (main → renderer). */
export interface SnapshotProgress {
  id: string;
  source: SnapshotSource;
  agentTabId?: string;
  total: number;
  done: number;
  failed: number;
  /** Large untracked files recorded by path only so far. */
  largeFiles: number;
  repos: { name: string; state: SnapshotRepoProgressState }[];
}
