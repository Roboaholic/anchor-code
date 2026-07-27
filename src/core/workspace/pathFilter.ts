/**
 * Workspace path exclude filters (VS Code files.exclude–style).
 * Patterns are relative to the workspace root, POSIX separators.
 */

/** Normalize to relative POSIX path without leading/trailing slashes. */
export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Normalize a user pattern (keep `**` etc., strip leading ./). */
export function normalizeExcludePattern(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * Convert a simple exclude pattern to a RegExp that matches full relative paths.
 * - `foo` or `foo/` → hides `foo` and `foo/...`
 * - `*.log` → basename-style segment globs
 * - `** /x` → recursive
 */
export function patternToRegExp(pattern: string): RegExp | null {
  const raw = normalizeExcludePattern(pattern);
  if (!raw || raw === "." || raw === "**") return null;

  // Escape regex specials except our glob tokens * and ?
  let i = 0;
  let body = "";
  while (i < raw.length) {
    if (raw[i] === "*" && raw[i + 1] === "*") {
      // ** or **/
      if (raw[i + 2] === "/") {
        body += "(?:.+/)?";
        i += 3;
      } else {
        body += ".*";
        i += 2;
      }
      continue;
    }
    if (raw[i] === "*") {
      body += "[^/]*";
      i += 1;
      continue;
    }
    if (raw[i] === "?") {
      body += "[^/]";
      i += 1;
      continue;
    }
    const ch = raw[i]!;
    if (/[.+^${}()|[\]\\]/.test(ch)) body += `\\${ch}`;
    else body += ch;
    i += 1;
  }

  // Plain path without globs: match exact path or any descendant
  if (!/[*?]/.test(raw)) {
    const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }

  return new RegExp(`^${body}$`);
}

export function pathMatchesExclude(
  relPath: string,
  patterns: readonly string[],
): boolean {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;
  for (const p of patterns) {
    const re = patternToRegExp(p);
    if (re && re.test(rel)) return true;
  }
  return false;
}

export function isValidExcludePattern(pattern: string): boolean {
  const n = normalizeExcludePattern(pattern);
  if (!n || n === "." || n === "**") return false;
  return true;
}

/**
 * Filter directory listing entries under `parentRel` (relative to root, "" for root).
 */
export function filterDirEntries<T extends { name: string }>(
  entries: T[],
  parentRel: string,
  patterns: readonly string[],
): T[] {
  if (patterns.length === 0) return entries;
  const parent = normalizeRelPath(parentRel);
  return entries.filter((e) => {
    const rel = parent ? `${parent}/${e.name}` : e.name;
    return !pathMatchesExclude(rel, patterns);
  });
}

/** Drop tree nodes whose relative path is excluded (recursive). */
export function pruneExcludedPaths<
  T extends { path: string; children?: T[] },
>(
  nodes: T[],
  root: string,
  patterns: readonly string[],
  relativeToRootFn: (root: string, abs: string) => string,
): T[] {
  if (patterns.length === 0) return nodes;
  const out: T[] = [];
  for (const n of nodes) {
    const rel = relativeToRootFn(root, n.path);
    if (pathMatchesExclude(rel, patterns)) continue;
    const children = n.children
      ? pruneExcludedPaths(n.children, root, patterns, relativeToRootFn)
      : n.children;
    out.push(children !== undefined ? { ...n, children } : n);
  }
  return out;
}
