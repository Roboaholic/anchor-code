import type { FileDiffContent } from "@/shared/anchor-api";

type DiffKey = string;

const cache = new Map<DiffKey, FileDiffContent>();
const inflight = new Map<DiffKey, Promise<FileDiffContent>>();

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

  const p = window.anchor.history
    .getFileDiff(args)
    .then((res) => {
      touch(key, res);
      return res;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
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

export function clearFileDiffCache(): void {
  cache.clear();
  inflight.clear();
}
