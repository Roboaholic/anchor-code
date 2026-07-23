/** Pure helpers for Recent compares list (per repo). */

export interface CompareEntry {
  id: string;
  repoRoot: string;
  repoName: string;
  base: string;
  head: string | "worktree";
  label: string;
  createdAt: string;
}

export const MAX_RECENT_COMPARES_PER_REPO = 15;

export function compareEntryId(
  repoRoot: string,
  base: string,
  head: string | "worktree",
): string {
  return `${repoRoot}\0${base}\0${head}`;
}

export function makeCompareEntry(input: {
  repoRoot: string;
  repoName: string;
  base: string;
  head: string | "worktree";
  label: string;
  createdAt?: string;
}): CompareEntry {
  return {
    id: compareEntryId(input.repoRoot, input.base, input.head),
    repoRoot: input.repoRoot,
    repoName: input.repoName,
    base: input.base,
    head: input.head,
    label: input.label,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Prepend entry; dedupe by id; cap list. */
export function pushRecentCompare(
  list: CompareEntry[],
  entry: CompareEntry,
  max = MAX_RECENT_COMPARES_PER_REPO,
): CompareEntry[] {
  const without = list.filter((e) => e.id !== entry.id);
  return [entry, ...without].slice(0, max);
}

export function removeRecentCompare(
  list: CompareEntry[],
  id: string,
): CompareEntry[] {
  return list.filter((e) => e.id !== id);
}
