/** Pure helpers for Diff-workspace comment bodies (no host I/O). */

export function shortRev(rev: string): string {
  if (rev === "worktree" || rev === "HEAD") return rev;
  return rev.length > 12 ? rev.slice(0, 7) : rev;
}

export function buildDiffCommentPrefix(opts: {
  branch?: string | null;
  base: string;
  head: string | "worktree";
  filePath: string;
  startLine: number;
  endLine: number;
}): string {
  const branch = opts.branch?.trim() || "(detached/unknown)";
  const base = shortRev(opts.base);
  const head = opts.head === "worktree" ? "worktree" : shortRev(opts.head);
  const lines =
    opts.startLine === opts.endLine
      ? `L${opts.startLine}`
      : `L${opts.startLine}–${opts.endLine}`;
  return [
    "[diff context]",
    `branch: ${branch}`,
    `base: ${base}`,
    `head: ${head}`,
    `file: ${opts.filePath} (${lines}, newer side)`,
    "",
  ].join("\n");
}

/** Whether a commit/worktree row is locked out when selection is full. */
export function isSelectionLockedOut(
  selectedIds: string[],
  rowId: string,
  max = 2,
): boolean {
  return selectedIds.length >= max && !selectedIds.includes(rowId);
}
