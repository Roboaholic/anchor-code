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

/**
 * Split a stored comment body into optional machine prefix + human text.
 * Prefix is kept in YAML for AI; UI should show `text` only.
 */
export function parseDiffCommentBody(body: string): {
  prefix: string;
  text: string;
} {
  const raw = body ?? "";
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("[diff context]\n") && normalized !== "[diff context]") {
    return { prefix: "", text: raw };
  }
  const lines = normalized.split("\n");
  let i = 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i += 1;
      break;
    }
    if (/^(branch|base|head|file):\s/.test(line)) {
      i += 1;
      continue;
    }
    break;
  }
  const prefixLines = lines.slice(0, i);
  const text = lines.slice(i).join("\n");
  // Rebuild prefix with trailing newline so `${prefix}${text}` round-trips.
  const prefix =
    prefixLines.length === 0
      ? ""
      : `${prefixLines.join("\n")}${prefixLines[prefixLines.length - 1] === "" ? "" : "\n"}`;
  return { prefix, text };
}

/** Human-visible comment text (drops leading [diff context] block). */
export function commentBodyForDisplay(body: string): string {
  return parseDiffCommentBody(body).text;
}

/**
 * When editing a primary message, keep any existing diff-context prefix.
 */
export function rejoinDiffCommentBody(
  originalBody: string,
  nextText: string,
): string {
  const { prefix } = parseDiffCommentBody(originalBody);
  const text = nextText.replace(/\r\n/g, "\n");
  if (!prefix) return text;
  return `${prefix}${text}`;
}

/** Whether a commit/worktree row is locked out when selection is full. */
export function isSelectionLockedOut(
  selectedIds: string[],
  rowId: string,
  max = 2,
): boolean {
  return selectedIds.length >= max && !selectedIds.includes(rowId);
}
