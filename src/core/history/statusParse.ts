/** Pure parsing of `git status --porcelain` (v1) output. */

export interface StatusEntry {
  /** Path relative to repo root (new path for renames). */
  path: string;
  /**
   * Single-letter summary for UI:
   * M modified, A added, D deleted, R renamed, C copied, ? untracked, U unmerged
   */
  status: string;
  /** Raw XY codes from porcelain (e.g. " M", "??", "R "). */
  code: string;
}

/**
 * Parse porcelain v1 lines:
 * - XY PATH
 * - XY ORIG -> PATH  (rename/copy)
 * - ?? PATH
 */
export function parsePorcelainStatus(stdout: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    // Untracked
    if (line.startsWith("?? ")) {
      const p = line.slice(3).trim();
      if (p) out.push({ path: unquotePath(p), status: "?", code: "??" });
      continue;
    }
    if (line.startsWith("!! ")) continue; // ignored
    // XY is two chars then space (or rename with " -> ")
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    let pathPart = rest;
    if (rest.includes(" -> ")) {
      pathPart = rest.split(" -> ").pop() ?? rest;
    }
    const path = unquotePath(pathPart.trim());
    if (!path) continue;
    out.push({ path, status: summarizeCode(code), code });
  }
  // Stable: path then code
  out.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return out;
}

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      // git C-style quotes occasionally
      return JSON.parse(p.replace(/\\([0-7]{1,3})/g, (_, o) =>
        String.fromCharCode(parseInt(o, 8)),
      ));
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function summarizeCode(code: string): string {
  const x = code[0] ?? " ";
  const y = code[1] ?? " ";
  if (x === "U" || y === "U" || code === "AA" || code === "DD") return "U";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  if (x === "D" || y === "D") return "D";
  if (x === "A" || y === "A") return "A";
  if (x === "M" || y === "M") return "M";
  if (x === "?" || y === "?") return "?";
  return (y !== " " ? y : x).trim() || "M";
}

export function statusCounts(entries: StatusEntry[]): {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  other: number;
} {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  let other = 0;
  for (const e of entries) {
    if (e.status === "M" || e.status === "R" || e.status === "C") modified += 1;
    else if (e.status === "A") added += 1;
    else if (e.status === "D") deleted += 1;
    else if (e.status === "?") untracked += 1;
    else other += 1;
  }
  return { modified, added, deleted, untracked, other };
}
