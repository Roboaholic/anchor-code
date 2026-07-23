/** Pure fuzzy match for Quick Open — basename only (not full path). */

export interface FuzzyMatch {
  /** Full relative path (for open / display). */
  path: string;
  /** Basename used for matching. */
  name: string;
  score: number;
  /** Character indices in `name` that matched the query (for highlight). */
  indices: number[];
}

export function basenameOf(path: string): string {
  const n = path.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * Score how well `query` matches `text` as a subsequence.
 * Higher is better; `null` when no match.
 */
export function scoreFuzzyText(text: string, query: string): {
  score: number;
  indices: number[];
} | null {
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
      if (prev === "." || prev === "-" || prev === "_" || prev === " ") {
        score += 10;
      }
    }
    ti = found + 1;
  }

  // Tighter names rank higher
  score -= Math.min(text.length, 80) * 0.2;
  // Exact / prefix / includes boosts
  if (textLower === queryLower) score += 100;
  else if (textLower.startsWith(queryLower)) score += 40;
  else if (textLower.includes(queryLower)) score += 20;

  return { score, indices };
}

/** Match query against file basename only. */
export function scoreFuzzyBasename(path: string, query: string): FuzzyMatch | null {
  const name = basenameOf(path);
  const m = scoreFuzzyText(name, query);
  if (!m) return null;
  return { path, name, score: m.score, indices: m.indices };
}

/** Filter + rank by basename; returns top `limit` matches. */
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
    const m = scoreFuzzyBasename(path, q);
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
