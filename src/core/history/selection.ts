/** Pure dual-select rules for History compare (testable without host). */

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
  if (selectedHashes.length === 2) {
    return `${shortOf(selectedHashes[0]!)} → ${shortOf(selectedHashes[1]!)}`;
  }
  if (selectedHashes.length === 1) {
    return `${shortOf(selectedHashes[0]!)} → worktree`;
  }
  return null;
}
