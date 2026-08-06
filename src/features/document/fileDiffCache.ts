import type { FileDiffContent } from "@/shared/anchor-api";

type DiffKey = string;

const cache = new Map<DiffKey, FileDiffContent>();
const inflight = new Map<DiffKey, Promise<FileDiffContent>>();
const generations = new Map<DiffKey, number>();

/** Soft cap — drop oldest entries when exceeded. */
const MAX_ENTRIES = 80;

function makeKey(args: {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  path: string;
  status: string;
}): DiffKey {
  return `${args.repoRoot}\0${args.base}\0${args.head}\0${args.path}\0${args.status}`;
}


function touch(key: DiffKey, value: FileDiffContent): void {
  // Refresh insertion order for a simple LRU-ish Map.
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function peekFileDiff(args: {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  path: string;
  status: string;
}): FileDiffContent | null {
  return cache.get(makeKey(args)) ?? null;
}

/**
 * Load one file's old/new text. Dedupes concurrent requests and caches hits.
 */
export function loadFileDiff(args: {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  path: string;
  status: string;
}): Promise<FileDiffContent> {
  const key = makeKey(args);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const pending = inflight.get(key);
  if (pending) return pending;

  const generation = generations.get(key) ?? 0;
  let request: Promise<FileDiffContent>;
  request = window.anchor.history
    .getFileDiff(args)
    .then((res) => {
      if ((generations.get(key) ?? 0) === generation) touch(key, res);
      return res;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Prefetch without blocking UI; ignores errors. */
export function prefetchFileDiff(args: {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  path: string;
  status: string;
}): void {
  const key = makeKey(args);
  if (cache.has(key) || inflight.has(key)) return;
  void loadFileDiff(args).catch(() => {
    // best-effort
  });
}

/** Drop mutable worktree snapshots before opening a newly-computed compare. */
export function invalidateWorktreeDiffCache(repoRoot: string, base: string): void {
  const prefix = `${repoRoot}\0${base}\0worktree\0`;
  const keys = new Set([...cache.keys(), ...inflight.keys()]);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    inflight.delete(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }
}

export function clearFileDiffCache(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
}
