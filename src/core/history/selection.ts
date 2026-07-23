/** Pure dual-select rules for History compare (testable without host). */

/** Sentinel id for “Uncommitted changes” (worktree). */
export const WORKTREE_SELECTION = "__worktree__";

export type ToggleResult =
  | { ok: true; selectedHashes: string[] }
  | { ok: false; selectedHashes: string[]; reason: string };

/** First check = base, second = head. Max two; third ignored. */
export function toggleCommitSelection(
  selectedHashes: string[],
  hash: string,
): ToggleResult {
  const idx = selectedHashes.indexOf(hash);
  if (idx >= 0) {
    return {
      ok: true,
      selectedHashes: selectedHashes.filter((h) => h !== hash),
    };
  }
  if (selectedHashes.length >= 2) {
    return {
      ok: false,
      selectedHashes,
      reason: "Select at most two commits",
    };
  }
  return { ok: true, selectedHashes: [...selectedHashes, hash] };
}

export function swapSelection(selectedHashes: string[]): string[] {
  if (selectedHashes.length !== 2) return selectedHashes;
  return [selectedHashes[1]!, selectedHashes[0]!];
}

export function compareLabel(
  selectedHashes: string[],
  shortOf: (hash: string) => string,
): string | null {
  if (selectedHashes.length === 0) return null;
  const labelOf = (h: string) =>
    h === WORKTREE_SELECTION ? "worktree" : shortOf(h);
  if (selectedHashes.length === 1) {
    const only = selectedHashes[0]!;
    if (only === WORKTREE_SELECTION) return "HEAD → worktree";
    return `${labelOf(only)} → worktree`;
  }
  const a = selectedHashes[0]!;
  const b = selectedHashes[1]!;
  // Worktree always as head side for a readable range
  if (a === WORKTREE_SELECTION && b !== WORKTREE_SELECTION) {
    return `${labelOf(b)} → worktree`;
  }
  if (b === WORKTREE_SELECTION) {
    return `${labelOf(a)} → worktree`;
  }
  return `${labelOf(a)} → ${labelOf(b)}`;
}

/** Resolve selection into base/head for compare IPC. */
export function resolveCompareRange(selectedHashes: string[]): {
  base: string;
  head: string | "worktree";
} | null {
  if (selectedHashes.length === 0) return null;
  if (selectedHashes.length === 1) {
    const only = selectedHashes[0]!;
    if (only === WORKTREE_SELECTION) return { base: "HEAD", head: "worktree" };
    return { base: only, head: "worktree" };
  }
  const a = selectedHashes[0]!;
  const b = selectedHashes[1]!;
  if (a === WORKTREE_SELECTION && b === WORKTREE_SELECTION) return null;
  if (a === WORKTREE_SELECTION) return { base: b, head: "worktree" };
  if (b === WORKTREE_SELECTION) return { base: a, head: "worktree" };
  return { base: a, head: b };
}
