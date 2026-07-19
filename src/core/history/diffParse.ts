/** Pure parsing of `git diff --name-status` output (no host I/O). */

export interface DiffFile {
  path: string;
  status: string;
}

/**
 * Parse name-status lines:
 * - M\tpath
 * - A\tpath
 * - D\tpath
 * - R100\told\tnew  (use new path)
 * - C100\told\tnew
 */
export function parseNameStatus(stdout: string): DiffFile[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "?";
      if (status.startsWith("R") || status.startsWith("C")) {
        const newPath = parts[2] ?? parts[1] ?? "";
        return { path: newPath, status };
      }
      return { path: parts[1] ?? "", status };
    })
    .filter((f) => f.path.length > 0);
}

/** Format short compare title for UI. */
export function formatCompareTitle(
  baseShort: string,
  head: string | "worktree",
  headShort?: string,
): string {
  if (head === "worktree") return `${baseShort} → worktree`;
  return `${baseShort} → ${headShort ?? head.slice(0, 7)}`;
}
