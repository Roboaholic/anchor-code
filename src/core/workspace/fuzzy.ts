/** Pure fuzzy match for Quick Open — basename and path-aware (VS Code-like). */

export interface FuzzyMatch {
  /** Full relative path (for open / display). */
  path: string;
  /** Basename used for name highlight. */
  name: string;
  score: number;
  /** Character indices in `name` that matched the query (for highlight). */
  indices: number[];
  /** Character indices in the directory portion (path without basename), if any. */
  pathIndices?: number[];
}

export function basenameOf(path: string): string {
  const n = path.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

export function dirnameOf(path: string): string {
  const n = path.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i) : "";
}

/**
 * Score how well `query` matches `text` as a subsequence.
 * Higher is better; `null` when no match.
 */
export function scoreFuzzyText(
  text: string,
  query: string,
): { score: number; indices: number[] } | null {
  const q = query.trim();
  if (!q) {
    return { score: 0, indices: [] };
  }

  return scorePreparedText(text, text.toLowerCase(), q.toLowerCase());
}

function scorePreparedText(
  text: string,
  textLower: string,
  queryLower: string,
): { score: number; indices: number[] } | null {
  const indices: number[] = [];

  let ti = 0;
  let consecutive = 0;
  let score = 0;

  for (let qi = 0; qi < queryLower.length; qi++) {
    const ch = queryLower[qi]!;
    let found = -1;
    for (; ti < textLower.length; ti++) {
      if (textLower[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found < 0) return null;
    indices.push(found);

    score += 10;
    if (indices.length > 1 && found === indices[indices.length - 2]! + 1) {
      consecutive += 1;
      score += 8 * consecutive;
    } else {
      consecutive = 0;
    }
    if (found === 0) {
      score += 12;
    } else {
      const prev = text[found - 1]!;
      if (
        prev === "." ||
        prev === "-" ||
        prev === "_" ||
        prev === " " ||
        prev === "/"
      ) {
        score += 10;
      }
    }
    ti = found + 1;
  }

  score -= Math.min(text.length, 80) * 0.2;
  if (textLower === queryLower) score += 100;
  else if (textLower.startsWith(queryLower)) score += 40;
  else if (textLower.includes(queryLower)) score += 20;

  return { score, indices };
}

/** Match query against file basename only. */
export function scoreFuzzyBasename(
  path: string,
  query: string,
): FuzzyMatch | null {
  const name = basenameOf(path);
  const m = scoreFuzzyText(name, query);
  if (!m) return null;
  return { path, name, score: m.score, indices: m.indices };
}

/**
 * Path-aware match (VS Code Go to File style).
 * Prefers basename matches; also accepts queries that hit path segments
 * (e.g. `src/foo` → `packages/src/foo/bar.ts`).
 */
export function scoreFuzzyPath(
  filePath: string,
  query: string,
): FuzzyMatch | null {
  const q = query.trim().replace(/\\/g, "/");
  return scorePreparedPath(preparePath(filePath), q, q.toLowerCase());
}

type PreparedPath = {
  path: string;
  normalized: string;
  lower: string;
  name: string;
  nameLower: string;
  dirLength: number;
};

function preparePath(path: string): PreparedPath {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const name = normalized.slice(slash + 1);
  return { path, normalized, lower: normalized.toLowerCase(), name,
    nameLower: name.toLowerCase(), dirLength: Math.max(0, slash) };
}

function scorePreparedPath(
  file: PreparedPath,
  q: string,
  queryLower: string,
): FuzzyMatch | null {
  const { path: filePath, normalized, name, dirLength: dirLen } = file;
  if (!q) {
    return {
      path: filePath,
      name,
      score: 0,
      indices: [],
    };
  }

  const baseHit = scorePreparedText(name, file.nameLower, queryLower);
  const pathHit = scorePreparedText(normalized, file.lower, queryLower);

  // Query looks path-like (contains /) → require full-path match.
  if (q.includes("/")) {
    if (!pathHit) return null;
    const pathIndices: number[] = [];
    const nameIndices: number[] = [];
    for (const i of pathHit.indices) {
      if (dirLen > 0 && i < dirLen) pathIndices.push(i);
      else if (i > dirLen) nameIndices.push(i - dirLen - 1);
      else if (dirLen === 0) nameIndices.push(i);
    }
    // Prefer tighter path / segment-boundary matches.
    let score = pathHit.score + 15;
    if (normalized.endsWith(q) || normalized.includes("/" + q)) score += 25;
    return {
      path: filePath,
      name,
      score,
      indices: nameIndices,
      pathIndices: pathIndices.length ? pathIndices : undefined,
    };
  }

  if (baseHit && pathHit) {
    // Basename wins unless the path score is clearly better (segment hit).
    const usePath = pathHit.score > baseHit.score + 20;
    if (!usePath) {
      return {
        path: filePath,
        name,
        score: baseHit.score + 8,
        indices: baseHit.indices,
      };
    }
  }

  if (baseHit) {
    return {
      path: filePath,
      name,
      score: baseHit.score + 8,
      indices: baseHit.indices,
    };
  }

  if (!pathHit) return null;
  const pathIndices: number[] = [];
  const nameIndices: number[] = [];
  for (const i of pathHit.indices) {
    if (dirLen > 0 && i < dirLen) pathIndices.push(i);
    else if (i > dirLen) nameIndices.push(i - dirLen - 1);
  }
  return {
    path: filePath,
    name,
    score: pathHit.score,
    indices: nameIndices,
    pathIndices: pathIndices.length ? pathIndices : undefined,
  };
}

/** Filter + rank by path-aware fuzzy; returns top `limit` matches. */
export function rankFuzzyPaths(
  paths: string[],
  query: string,
  limit = 50,
): FuzzyMatch[] {
  return new FuzzyPathIndex(paths).rank(query, limit);
}

function compareMatches(a: FuzzyMatch, b: FuzzyMatch): number {
  return b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

function yieldTask(): Promise<void> {
  // MessageChannel avoids nested setTimeout's 4 ms clamp for large indexes.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** A max-heap keeps the worst retained match at the root. */
class TopMatches {
  private readonly hits: FuzzyMatch[] = [];
  constructor(private readonly limit: number) {}

  add(hit: FuzzyMatch): void {
    if (this.limit <= 0) return;
    const heap = this.hits;
    if (heap.length < this.limit) {
      heap.push(hit);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compareMatches(heap[child]!, heap[parent]!) <= 0) break;
        [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
        child = parent;
      }
      return;
    }
    if (compareMatches(hit, heap[0]!) >= 0) return;
    heap[0] = hit;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && compareMatches(heap[right]!, heap[left]!) > 0 ? right : left;
      if (compareMatches(heap[child]!, heap[parent]!) <= 0) break;
      [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
      parent = child;
    }
  }

  sorted(): FuzzyMatch[] { return this.hits.sort(compareMatches); }
}

/** Reuse normalization across queries; only the best `limit` hits are retained. */
export class FuzzyPathIndex {
  private readonly prepared: Array<PreparedPath | undefined>;
  constructor(private readonly paths: string[]) {
    this.prepared = new Array(paths.length);
  }

  private score(index: number, query: string, lower: string): FuzzyMatch | null {
    const file = this.prepared[index] ??= preparePath(this.paths[index]!);
    return scorePreparedPath(file, query, lower);
  }

  private empty(limit: number): FuzzyMatch[] {
    return this.paths.slice(0, limit).map((path) => ({ path, name: basenameOf(path), score: 0, indices: [] }));
  }

  rank(query: string, limit = 50): FuzzyMatch[] {
    const count = Math.max(0, Math.floor(limit));
    const q = query.trim().replace(/\\/g, "/");
    if (!q || count === 0) return this.empty(count);
    const hits = new TopMatches(count);
    const lower = q.toLowerCase();
    for (let i = 0; i < this.paths.length; i++) {
      const hit = this.score(i, q, lower);
      if (hit) hits.add(hit);
    }
    return hits.sorted();
  }

  /** Yield between batches so a newer query can cancel work, including fallback. */
  async rankAsync(
    query: string,
    limit: number,
    cancelled: () => boolean,
    yieldControl: () => Promise<void> = yieldTask,
  ): Promise<FuzzyMatch[]> {
    const count = Math.max(0, Math.floor(limit));
    const q = query.trim().replace(/\\/g, "/");
    if (!q || count === 0) return cancelled() ? [] : this.empty(count);
    const hits = new TopMatches(count);
    const lower = q.toLowerCase();
    for (let start = 0; start < this.paths.length; start += 2048) {
      if (cancelled()) return [];
      const end = Math.min(start + 2048, this.paths.length);
      for (let i = start; i < end; i++) {
        const hit = this.score(i, q, lower);
        if (hit) hits.add(hit);
      }
      if (end < this.paths.length) await yieldControl();
    }
    return cancelled() ? [] : hits.sorted();
  }
}
