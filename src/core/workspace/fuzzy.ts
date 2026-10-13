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

  const textLower = text.toLowerCase();
  const queryLower = q.toLowerCase();
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
  if (!q) {
    return {
      path: filePath,
      name: basenameOf(filePath),
      score: 0,
      indices: [],
    };
  }

  const normalized = filePath.replace(/\\/g, "/");
  const name = basenameOf(normalized);
  const dir = dirnameOf(normalized);

  const baseHit = scoreFuzzyText(name, q);
  const pathHit = scoreFuzzyText(normalized, q);

  // Query looks path-like (contains /) → require full-path match.
  if (q.includes("/")) {
    if (!pathHit) return null;
    const pathIndices: number[] = [];
    const nameIndices: number[] = [];
    const dirLen = dir.length;
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
  const dirLen = dir.length;
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
  const q = query.trim();
  if (!q) {
    return paths.slice(0, limit).map((path) => ({
      path,
      name: basenameOf(path),
      score: 0,
      indices: [],
    }));
  }
  const hits: FuzzyMatch[] = [];
  for (const path of paths) {
    const m = scoreFuzzyPath(path, q);
    if (m) hits.push(m);
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  );
  return hits.slice(0, limit);
}
