export type FileIndexRequest = {
  root: string;
  hostKind: string | null;
  hostProfileId: string | null;
  respectIgnore: boolean;
  defaultExcludes?: string[];
};

export type FileIndexResult = {
  root: string;
  files: string[];
  truncated: boolean;
  source?: "git" | "walk" | "multi-git";
};
export type CachedFileIndex = FileIndexResult & { at: number };

function requestKey(request: FileIndexRequest): string {
  return JSON.stringify([request.hostKind, request.hostProfileId, request.root,
    request.respectIgnore, request.defaultExcludes ?? null]);
}

function wasRemoved(file: string, removed: ReadonlySet<string>): boolean {
  if (removed.has(file)) return true;
  for (let slash = file.indexOf("/"); slash >= 0; slash = file.indexOf("/", slash + 1)) {
    if (removed.has(file.slice(0, slash))) return true;
  }
  return false;
}

/** Identity includes host and filters; invalidated in-flight results cannot repopulate it. */
export class FileIndexCache {
  private readonly entries = new Map<string, { request: FileIndexRequest; value: CachedFileIndex }>();
  private readonly pending = new Map<string, { root: string; promise: Promise<CachedFileIndex>; removed: Set<string> }>();

  peek(request: FileIndexRequest): CachedFileIndex | undefined {
    const key = requestKey(request);
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  load(request: FileIndexRequest, fetch: () => Promise<FileIndexResult>): Promise<CachedFileIndex> {
    const key = requestKey(request);
    // A first palette opening must share the warm-up even when no completed cache exists.
    const inflight = this.pending.get(key);
    if (inflight) return inflight.promise;
    const cached = this.peek(request);
    const ttl = request.hostKind === "local" || !request.hostKind ? 5 * 60_000 : 5_000;
    if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached);

    const removed = new Set<string>();
    const promise = Promise.resolve().then(fetch).then((result) => {
      const files = removed.size ? result.files.filter((file) => !wasRemoved(file, removed)) : result.files;
      const value = { ...result, files, at: Date.now() };
      if (this.pending.get(key)?.promise === promise) {
        this.entries.set(key, { request, value });
        while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });
    this.pending.set(key, { root: request.root, promise, removed });
    return promise;
  }

  invalidate(root?: string): void {
    for (const [key, entry] of this.entries) if (!root || entry.request.root === root) this.entries.delete(key);
    for (const [key, entry] of this.pending) if (!root || entry.root === root) this.pending.delete(key);
  }

  remove(request: FileIndexRequest, deleted: string[]): void {
    const key = requestKey(request);
    // Replay membership changes if a scan's snapshot predates this event.
    const pending = this.pending.get(key);
    for (const path of deleted) pending?.removed.add(path);
    const cached = this.entries.get(key);
    if (!cached) return;
    const paths = new Set(deleted);
    const files = cached.value.files.filter((file) => !wasRemoved(file, paths));
    if (files.length !== cached.value.files.length) {
      this.entries.set(key, { ...cached, value: { ...cached.value, files } });
    }
  }
}
