/**
 * Pure helpers for the streaming search results list: incremental grouping,
 * flattening into fixed-height rows, virtual window math and per-workspace
 * persisted search settings.
 */

export type SearchHit = { path: string; line: number; text: string };

export type SearchFileGroup = {
  path: string;
  hits: SearchHit[];
};

/** Group hits by file path (preserve first-seen order). */
export function groupHitsByFile(hits: SearchHit[]): SearchFileGroup[] {
  return appendHitsToGroups([], hits);
}

/**
 * Append a streamed batch to existing groups without regrouping everything.
 * Untouched groups keep object identity (cheap React reconciliation); only
 * groups that received hits are replaced.
 */
export function appendHitsToGroups(
  groups: SearchFileGroup[],
  batch: SearchHit[],
): SearchFileGroup[] {
  if (batch.length === 0) return groups;
  const index = new Map<string, number>();
  groups.forEach((g, i) => index.set(g.path, i));
  const next = groups.slice();
  const touched = new Set<number>();
  for (const hit of batch) {
    const i = index.get(hit.path);
    if (i === undefined) {
      index.set(hit.path, next.length);
      touched.add(next.length);
      next.push({ path: hit.path, hits: [hit] });
      continue;
    }
    if (!touched.has(i)) {
      next[i] = { path: next[i]!.path, hits: next[i]!.hits.slice() };
      touched.add(i);
    }
    next[i]!.hits.push(hit);
  }
  return next;
}

export function countHits(groups: SearchFileGroup[]): number {
  let n = 0;
  for (const g of groups) n += g.hits.length;
  return n;
}

export type SearchRow =
  | { kind: "file"; key: string; group: SearchFileGroup; collapsed: boolean }
  | { kind: "hit"; key: string; hit: SearchHit };

/** Flatten groups into rows (file header + its hits unless collapsed). */
export function flattenSearchRows(
  groups: SearchFileGroup[],
  collapsed: ReadonlySet<string>,
): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.path);
    rows.push({ kind: "file", key: `f:${group.path}`, group, collapsed: isCollapsed });
    if (isCollapsed) continue;
    group.hits.forEach((hit, i) => {
      rows.push({ kind: "hit", key: `h:${group.path}:${hit.line}:${i}`, hit });
    });
  }
  return rows;
}

/** Visible row range for a fixed-row-height virtual list. */
export function computeVirtualWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): { start: number; end: number } {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.min(total, Math.max(0, first - overscan));
  const end = Math.min(total, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

/** Search filter settings remembered per workspace root. */
export interface WorkspaceSearchSettings {
  include: string;
  exclude: string;
  /** Respect .gitignore / hidden rules and default excludes. */
  respectIgnore: boolean;
  /** Display-only path regex post-filter. */
  excludeRegex: string;
  /** Edited default exclude list; null = built-in defaults. */
  defaultExcludes: string[] | null;
}

export const DEFAULT_SEARCH_SETTINGS: WorkspaceSearchSettings = {
  include: "",
  exclude: "",
  respectIgnore: true,
  excludeRegex: "",
  defaultExcludes: null,
};

const SETTINGS_PREFIX = "anchor.search.v1:";

export function searchSettingsKey(root: string): string {
  return `${SETTINGS_PREFIX}${root}`;
}

type KV = Pick<Storage, "getItem" | "setItem">;

export function loadSearchSettings(
  root: string,
  storage: KV | null = typeof localStorage === "undefined" ? null : localStorage,
): WorkspaceSearchSettings {
  try {
    const raw = storage?.getItem(searchSettingsKey(root));
    if (!raw) return { ...DEFAULT_SEARCH_SETTINGS };
    const v = JSON.parse(raw) as Partial<WorkspaceSearchSettings>;
    return {
      include: typeof v.include === "string" ? v.include : "",
      exclude: typeof v.exclude === "string" ? v.exclude : "",
      respectIgnore: v.respectIgnore !== false,
      excludeRegex: typeof v.excludeRegex === "string" ? v.excludeRegex : "",
      defaultExcludes: Array.isArray(v.defaultExcludes)
        ? v.defaultExcludes.filter((x): x is string => typeof x === "string")
        : null,
    };
  } catch {
    return { ...DEFAULT_SEARCH_SETTINGS };
  }
}

export function saveSearchSettings(
  root: string,
  settings: WorkspaceSearchSettings,
  storage: KV | null = typeof localStorage === "undefined" ? null : localStorage,
): void {
  try {
    storage?.setItem(searchSettingsKey(root), JSON.stringify(settings));
  } catch {
    // quota / private mode
  }
}

/** Parse a default-exclude editor textarea (one pattern per line or comma). */
export function parseExcludeList(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate the display-only exclude regex; returns an error message or null. */
export function excludeRegexError(source: string): string | null {
  if (!source.trim()) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid regex";
  }
}
