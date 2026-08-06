import type { FileDiffContent } from "@/shared/anchor-api";

type FileDiffRequest = {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  path: string;
  status: string;
};

type DiffKey = string;
type QueuedDiff = {
  args: FileDiffRequest;
  promise: Promise<FileDiffContent>;
  resolve: (value: FileDiffContent) => void;
  reject: (reason: unknown) => void;
};

const cache = new Map<DiffKey, FileDiffContent>();
const inflight = new Map<DiffKey, Promise<FileDiffContent>>();
const queued = new Map<DiffKey, QueuedDiff>();
const generations = new Map<DiffKey, number>();

/** Background work stays serial so a clicked file can start immediately. */
const MAX_BACKGROUND_REQUESTS = 1;
let activeBackgroundRequests = 0;

/** Soft cap — drop oldest entries when exceeded. */
const MAX_ENTRIES = 80;

function makeKey(args: FileDiffRequest): DiffKey {
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

export function peekFileDiff(args: FileDiffRequest): FileDiffContent | null {
  return cache.get(makeKey(args)) ?? null;
}

/**
 * Load one file's old/new text. Dedupes concurrent requests and caches hits.
 */
function startFileDiffRequest(
  args: FileDiffRequest,
  key = makeKey(args),
): Promise<FileDiffContent> {
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

function pumpPrefetchQueue(): void {
  while (activeBackgroundRequests < MAX_BACKGROUND_REQUESTS) {
    const entry = queued.entries().next().value as [DiffKey, QueuedDiff] | undefined;
    if (!entry) return;
    const [key, job] = entry;
    queued.delete(key);
    const hit = cache.get(key);
    if (hit) {
      job.resolve(hit);
      continue;
    }
    activeBackgroundRequests += 1;
    void startFileDiffRequest(job.args, key)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeBackgroundRequests -= 1;
        pumpPrefetchQueue();
      });
  }
}

/**
 * Load a clicked file immediately. A queued background load is promoted ahead
 * of the remaining queue while preserving its original promise.
 */
export function loadFileDiff(args: FileDiffRequest): Promise<FileDiffContent> {
  const key = makeKey(args);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const pending = inflight.get(key);
  if (pending) return pending;

  const waiting = queued.get(key);
  if (waiting) {
    queued.delete(key);
    void startFileDiffRequest(args, key).then(waiting.resolve, waiting.reject);
    return waiting.promise;
  }
  return startFileDiffRequest(args, key);
}

/** Prefetch without blocking UI; ignores errors. */
export function prefetchFileDiff(args: FileDiffRequest): void {
  const key = makeKey(args);
  if (cache.has(key) || inflight.has(key) || queued.has(key)) return;
  let resolve!: (value: FileDiffContent) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<FileDiffContent>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  queued.set(key, { args, promise, resolve, reject });
  void promise.catch(() => undefined);
  pumpPrefetchQueue();
}

/** Drop mutable worktree snapshots before opening a newly-computed compare. */
export function invalidateWorktreeDiffCache(repoRoot: string, base: string): void {
  const prefix = `${repoRoot}\0${base}\0worktree\0`;
  const keys = new Set([...cache.keys(), ...inflight.keys(), ...queued.keys()]);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    inflight.delete(key);
    const waiting = queued.get(key);
    queued.delete(key);
    waiting?.reject(new Error("Diff prefetch invalidated"));
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }
}

export function clearFileDiffCache(): void {
  const keys = new Set([...cache.keys(), ...inflight.keys(), ...queued.keys()]);
  for (const key of keys) {
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }
  for (const waiting of queued.values()) waiting.reject(new Error("Diff cache cleared"));
  cache.clear();
  inflight.clear();
  queued.clear();
}
