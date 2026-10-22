import { isAppActive } from "@/shared/appActivity";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Icon } from "@/shared/Icon";
import {
  openHistoryCompare,
  openHistoryRecent,
  openWorkingTreeFileDiff,
} from "@/features/shell/orchestrate";
import {
  UNTRACKED_SCAN_MS,
  WORKTREE_SELECTION,
  recentForRepo,
  selectionLabelForCard,
  statusEntries,
  useHistoryStore,
  type RepoCardState,
} from "@/features/history/historyStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { isUntrackedDirectoryPath } from "@/core/history/statusParse";
import type { HistoryCompareEntry } from "@/shared/anchor-api";

/** Quiet status poll while HISTORY is visible. */
export const HISTORY_POLL_MS = 30_000;
/** Module-level so effect re-runs (repo count changes) cannot overlap rounds. */
let historyPollInFlight = false;

export function HistoryPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const repos = useHistoryStore((s) => s.repos);
  const discoverStatus = useHistoryStore((s) => s.discoverStatus);
  const discoverError = useHistoryStore((s) => s.discoverError);
  const recentCompares = useHistoryStore((s) => s.recentCompares);
  const toast = useHistoryStore((s) => s.toast);
  const clearToast = useHistoryStore((s) => s.clearToast);
  const discover = useHistoryStore((s) => s.discover);
  const softRefreshStatuses = useHistoryStore((s) => s.softRefreshStatuses);
  const refreshAllStatuses = useHistoryStore((s) => s.refreshAllStatuses);
  const scanUntracked = useHistoryStore((s) => s.scanUntracked);

  useEffect(() => {
    if (!workspaceRoot) return;
    if (discoverStatus === "loading") return;
    if (useHistoryStore.getState().workspaceRoot === workspaceRoot) return;
    if (discoverStatus === "error") return;
    void discover(workspaceRoot);
  }, [workspaceRoot, discoverStatus, repos.length, discover]);

  // Badge-first (VS Code SCM style):
  // - While HISTORY is open: quiet-poll M/A/D/? + ahead/behind for all repos
  // - Expanding a repo / Changes / History section: refresh that repo's detail
  // Untracked files light the M badge too, but scanning for them is the
  // expensive part of `git status` on big trees: every 5 minutes (plus on
  // workspace load and the Repos Refresh), never on the 30s poll.
  useEffect(() => {
    if (!workspaceRoot) return;
    if (repos.length === 0) return;
    const interval = window.setInterval(() => {
      if (!isAppActive()) return;
      void scanUntracked();
    }, UNTRACKED_SCAN_MS);
    return () => window.clearInterval(interval);
  }, [workspaceRoot, repos.length, scanUntracked]);

  useEffect(() => {
    if (!workspaceRoot) return;
    if (repos.length === 0) return;
    if (discoverStatus === "loading") return;

    let cancelled = false;
    const tick = () => {
      // Pane is only mounted while HISTORY is the visible left mode.
      if (cancelled || historyPollInFlight) return;
      if (!isAppActive()) return;
      historyPollInFlight = true;
      // Quiet badge refresh only — no commit logs, no loading flicker.
      void softRefreshStatuses().finally(() => {
        historyPollInFlight = false;
      });
    };

    tick();

    const onFocus = () => tick();
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    const interval = window.setInterval(tick, HISTORY_POLL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(interval);
    };
  }, [workspaceRoot, repos.length, discoverStatus, softRefreshStatuses]);

  if (!workspaceRoot) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History</h2>
        <p className="empty-pane__hint">Open a workspace to discover git roots.</p>
      </div>
    );
  }

  if (discoverStatus === "loading" && repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History</h2>
        <p className="empty-pane__hint">Scanning for repositories…</p>
      </div>
    );
  }

  if (discoverStatus === "error" && repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History</h2>
        <p className="empty-pane__hint pane-hint--error">
          {discoverError ?? "Failed to scan repositories"}
        </p>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void discover(workspaceRoot, { force: true })}
          title="Rescan for git roots"
          aria-label="Rescan for git roots"
        >
          <Icon name="refresh" />
        </button>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History</h2>
        <p className="empty-pane__hint">
          No git root found under this workspace. Reading still works.
        </p>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void discover(workspaceRoot, { force: true })}
          title="Rescan for git roots"
          aria-label="Rescan for git roots"
        >
          <Icon name="refresh" />
        </button>
      </div>
    );
  }

  return (
    <div className="history-pane">
      <div className="history-pane__toolbar">
        <span className="files-pane__title">Repos</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() =>
            void refreshAllStatuses().then(() => scanUntracked())
          }
          title="Refresh status"
          aria-label="Refresh status"
        >
          <Icon name="refresh" />
        </button>
      </div>

      {toast ? (
        <div className="banner banner--warn history-toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon-btn" onClick={clearToast}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      <ul className="repo-card-list">
        {repos.map((card) => (
          <li key={card.root}>
            <RepoCard
              card={card}
              recent={recentForRepo(recentCompares, card.root)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Repo-level change parts, in tooltip order. */
const CHANGE_PARTS = [
  { key: "modified", label: "modified" },
  { key: "added", label: "added" },
  { key: "deleted", label: "deleted" },
  { key: "untracked", label: "untracked" },
] as const;

/** Tooltip for the single repo "M" badge, e.g. "Changes: 14 modified, 2 deleted". */
function changesSummary(card: RepoCardState): string {
  const parts = CHANGE_PARTS.flatMap(({ key, label }) => {
    const n = card.status?.[key] ?? 0;
    return n > 0 ? [`${n} ${label}`] : [];
  });
  return `Changes: ${parts.join(", ")}`;
}

/** Git reports untracked files as "?"; the UI shows them as "U". */
function displayStatus(status: string): string {
  return status === "?" ? "U" : status;
}

function dirtyCount(card: RepoCardState): number {
  return (
    (card.status?.modified ?? 0) +
    (card.status?.added ?? 0) +
    (card.status?.deleted ?? 0) +
    (card.status?.untracked ?? 0)
  );
}

function RepoCard({
  card,
  recent,
}: {
  card: RepoCardState;
  recent: HistoryCompareEntry[];
}) {
  const toggleExpanded = useHistoryStore((s) => s.toggleExpanded);
  const toggleChanges = useHistoryStore((s) => s.toggleChanges);
  const toggleHistory = useHistoryStore((s) => s.toggleHistory);
  const refreshRepo = useHistoryStore((s) => s.refreshRepo);
  const refreshing = useHistoryStore((s) => s.refreshingRepos[card.root] === true);
  const loadMoreLog = useHistoryStore((s) => s.loadMoreLog);
  const toggleCompares = useHistoryStore((s) => s.toggleCompares);
  const toggleCommit = useHistoryStore((s) => s.toggleCommit);
  const refreshStatus = useHistoryStore((s) => s.refreshStatus);
  const removeRecent = useHistoryStore((s) => s.removeRecent);
  const commitChanges = useHistoryStore((s) => s.commitChanges);
  const dirty = dirtyCount(card);
  const label = selectionLabelForCard(card);
  const canCompare = card.selectedHashes.length > 0 && !card.comparing;
  const entries = statusEntries(card);
  const selectionFull = card.selectedHashes.length >= 2;
  const branchLabel = card.status?.branch ?? null;
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  // Selected file paths for the next commit; defaults to all changed files.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(entries.map((e) => e.path)),
  );

  useEffect(() => {
    if (dirty === 0) {
      setCommitOpen(false);
      setCommitMessage("");
    }
  }, [dirty]);

  // Keep selection in sync with the set of changed files: newly-changed files
  // default to selected; files no longer present are dropped. The fingerprint
  // ensures this only runs when the actual path set changes, not every render.
  const entriesKey = entries.map((e) => e.path).join("\n");
  const seenPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = entriesKey ? entriesKey.split("\n") : [];
    const seen = seenPathsRef.current;
    setSelectedPaths((prev) => {
      const next = new Set<string>();
      for (const p of current) {
        // Preserve the user's prior choice; a brand-new path defaults selected.
        if (prev.has(p) || !seen.has(p)) next.add(p);
      }
      seenPathsRef.current = new Set(current);
      return next;
    });
  }, [entriesKey]);

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allSelected = entries.length > 0 && selectedPaths.size === entries.length;
  const noneSelected = selectedPaths.size === 0;
  const toggleAll = () => {
    setSelectedPaths(allSelected ? new Set() : new Set(entries.map((e) => e.path)));
  };
  // Tracked-only changes (modified/added/deleted), excluding untracked (?).
  const trackedPaths = entries.filter((e) => e.status !== "?").map((e) => e.path);
  // True when selection is exactly the tracked set (toggle back to all on re-click).
  const trackedOnly =
    trackedPaths.length > 0 &&
    selectedPaths.size === trackedPaths.length &&
    trackedPaths.every((p) => selectedPaths.has(p));
  const selectTracked = () => {
    setSelectedPaths(
      trackedOnly ? new Set(entries.map((e) => e.path)) : new Set(trackedPaths),
    );
  };

  const onCommitSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    const paths = [...selectedPaths];
    const ok = await commitChanges(card.root, commitMessage, paths);
    if (ok) {
      setCommitOpen(false);
      setCommitMessage("");
    }
  };

  return (
    <div className={`repo-row${card.expanded ? " is-expanded" : ""}`}>
      {/* One line: chevron · name (ellipsis) · fill · ↑ahead ↓behind ·
          branch (muted, right-aligned) · badge slot (M / … / !, empty when
          clean). ↑↓ sit *before* the branch and the slot is a fixed 16px
          square, so branch names share one right edge on every row.
          Refresh lives in the body. */}
      <div className="repo-row__header">
        <button
          type="button"
          className="repo-row__expand"
          onClick={() => toggleExpanded(card.root)}
          aria-expanded={card.expanded}
          aria-label={card.name}
        >
          <Icon
            name={card.expanded ? "chevron-down" : "chevron-right"}
            className="repo-row__chevron"
          />
          <span className="repo-row__name">{card.name}</span>
        </button>
        <span
          className="repo-row__fill"
          aria-hidden
          onClick={() => toggleExpanded(card.root)}
        />
        {(card.status?.ahead ?? 0) > 0 || (card.status?.behind ?? 0) > 0 ? (
          <span className="repo-row__syncs">
            {(card.status?.ahead ?? 0) > 0 ? (
              <span
                className="repo-row__sync repo-row__sync--ahead"
                aria-label={`Ahead ${card.status?.ahead}`}
              >
                ↑{card.status?.ahead}
              </span>
            ) : null}
            {(card.status?.behind ?? 0) > 0 ? (
              <span
                className="repo-row__sync repo-row__sync--behind"
                aria-label={`Behind ${card.status?.behind}`}
              >
                ↓{card.status?.behind}
              </span>
            ) : null}
          </span>
        ) : null}
        <BranchSwitcher card={card} branchLabel={branchLabel} />
        {/* Fixed 16px badge slot, kept (empty) on clean rows so branch
            names share one right edge: error › M › refreshing › nothing. */}
        <span className="repo-row__meta">
          {card.statusState === "error" ? (
            <span
              className="repo-row__badge is-muted"
              title={card.statusError ?? "Status failed"}
              aria-label={card.statusError ?? "Status failed"}
            >
              !
            </span>
          ) : card.status && dirty > 0 ? (
            <span
              className="repo-row__badge repo-row__badge--modified"
              title={changesSummary(card)}
              aria-label={changesSummary(card)}
            >
              M
            </span>
          ) : card.statusState === "loading" ? (
            <span className="repo-row__badge is-muted" aria-label="Refreshing">
              …
            </span>
          ) : null}
        </span>
      </div>

      {card.expanded ? (
        <div className="repo-row__body">
          {/* CHANGES — default open: file list + commit */}
          <div className="repo-block">
            <div className="repo-block__head">
              <button
                type="button"
                className="repo-block__toggle"
                onClick={() => toggleChanges(card.root)}
                aria-expanded={card.changesOpen}
              >
                <Icon
                  name={card.changesOpen ? "chevron-down" : "chevron-right"}
                />
                <span className="repo-block__title">Changes</span>
                {dirty > 0 ? (
                  <span
                    className="repo-block__count"
                    aria-label={`${dirty} changed file${dirty === 1 ? "" : "s"}`}
                  >
                    {dirty}
                  </span>
                ) : null}
              </button>
              {card.changesOpen && entries.length > 0 ? (
                <div
                  className="repo-seg"
                  role="group"
                  aria-label="Select files to commit"
                >
                  <button
                    type="button"
                    className={`repo-seg__btn${allSelected ? " is-active" : ""}`}
                    aria-pressed={allSelected}
                    onClick={toggleAll}
                    title={allSelected ? "Deselect all files" : "Select all files"}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`repo-seg__btn${trackedOnly && !allSelected ? " is-active" : ""}`}
                    aria-pressed={trackedOnly && !allSelected}
                    onClick={selectTracked}
                    title="Select only tracked changes (M / A / D), excluding untracked (U)"
                  >
                    Tracked
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className={`icon-btn repo-row__refresh${refreshing ? " is-spinning" : ""}`}
                disabled={refreshing}
                aria-busy={refreshing}
                onClick={() => void refreshRepo(card.root)}
                aria-label="Refresh"
              >
                <Icon name="refresh" />
              </button>
            </div>
            {card.changesOpen ? (
              <div className="repo-block__body">
                {card.statusError ? (
                  <p className="pane-hint pane-hint--error">{card.statusError}</p>
                ) : null}
                {card.statusState === "loading" ? (
                  <p className="pane-hint">Loading status…</p>
                ) : null}
                {entries.length > 0 ? (
                  <ul className="wt-list">
                    {entries.map((e) => {
                      const checked = selectedPaths.has(e.path);
                      return (
                      <li key={`${e.code}:${e.path}`} className="wt-row__li">
                        <label
                          className="wt-row__check"
                          title={checked ? "Exclude from commit" : "Include in commit"}
                        >
                          <input
                            type="checkbox"
                            className="anchor-checkbox"

                            checked={checked}
                            onChange={() => togglePath(e.path)}
                            onClick={(e2) => e2.stopPropagation()}
                          />
                        </label>
                        <button
                          type="button"
                          className="wt-row wt-row--btn"
                          title={
                            isUntrackedDirectoryPath(e.path)
                              ? `Untracked directory ${e.path}`
                              : `Diff ${e.path} (HEAD → worktree)`
                          }
                          onClick={() => {
                            if (isUntrackedDirectoryPath(e.path)) {
                              void refreshStatus(card.root, { badgeOnly: false });
                              return;
                            }
                            void openWorkingTreeFileDiff(
                              card.root,
                              e.path,
                              e.status,
                            );
                          }}
                        >
                          <span className="wt-row__status">{displayStatus(e.status)}</span>
                          <span className="wt-row__path">{e.path}</span>
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                ) : card.status && dirty === 0 && card.statusState !== "loading" ? (
                  <p className="pane-hint">No local changes.</p>
                ) : null}
                {dirty > 0 && commitOpen ? (
                  <form
                    className="repo-commit"
                    onSubmit={(e) => void onCommitSubmit(e)}
                  >
                    <textarea
                      className="repo-commit__input"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      placeholder="Commit message"
                      rows={3}
                      disabled={card.committing}
                      autoFocus
                      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                        if (
                          (e.ctrlKey || e.metaKey) &&
                          e.key === "Enter" &&
                          commitMessage.trim()
                        ) {
                          e.preventDefault();
                          void onCommitSubmit();
                        }
                      }}
                    />
                    <div className="repo-commit__actions">
                      <span className="repo-commit__hint">
                        {noneSelected
                          ? "No files selected"
                          : `Stages ${selectedPaths.size} of ${entries.length} files · Ctrl+Enter`}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={card.committing}
                        onClick={() => setCommitOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="btn btn--accent btn--small"
                        disabled={
                          card.committing ||
                          !commitMessage.trim() ||
                          noneSelected
                        }
                      >
                        {card.committing ? "Committing…" : "Commit"}
                      </button>
                    </div>
                  </form>
                ) : dirty > 0 ? (
                  <button
                    type="button"
                    className="btn btn--fill btn--small repo-commit__open"
                    disabled={card.committing || noneSelected}
                    onClick={() => setCommitOpen(true)}
                    title="Commit selected files"
                  >
                    {noneSelected
                      ? "Commit"
                      : `Commit ${selectedPaths.size} file${selectedPaths.size === 1 ? "" : "s"}`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* HISTORY — default closed; selection + uncommitted checkbox */}
          <div className="repo-block">
            <div className="repo-block__head">
              <button
                type="button"
                className="repo-block__toggle"
                onClick={() => void toggleHistory(card.root)}
                aria-expanded={card.historyOpen}
              >
                <Icon
                  name={card.historyOpen ? "chevron-down" : "chevron-right"}
                />
                <span className="repo-block__title">History</span>
              </button>
              {card.historyOpen ? (
                <div className="repo-block__head-actions">
                  <button
                    type="button"
                    className="btn btn--accent btn--small"
                    disabled={!canCompare}
                    onClick={() => void openHistoryCompare(card.root)}
                    title={
                      card.comparing
                        ? "Comparing selection…"
                        : "Compare selection (older on left, newer on right)"
                    }
                  >
                    {card.comparing ? "Comparing…" : "Compare"}
                  </button>
                </div>
              ) : null}
            </div>
            {card.historyOpen ? (
              <div className="repo-block__body">
                {card.logError ? (
                  <p className="pane-hint pane-hint--error">{card.logError}</p>
                ) : null}
                {card.logStatus === "loading" ? (
                  <p className="pane-hint">Loading commits…</p>
                ) : null}

                {label ? (
                  <div className="history-pane__actions">
                    <span className="history-pane__label" title={label}>
                      {label}
                    </span>
                  </div>
                ) : null}
                <ul className="commit-list">
                  <li>
                    <label
                      className={`commit-row commit-row--wt${
                        card.selectedHashes.includes(WORKTREE_SELECTION)
                          ? " is-selected"
                          : ""
                      }${
                        dirty === 0 ||
                        (selectionFull &&
                          !card.selectedHashes.includes(WORKTREE_SELECTION))
                          ? " is-disabled"
                          : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="anchor-checkbox"

                        checked={card.selectedHashes.includes(
                          WORKTREE_SELECTION,
                        )}
                        disabled={
                          dirty === 0 ||
                          (selectionFull &&
                            !card.selectedHashes.includes(WORKTREE_SELECTION))
                        }
                        onChange={() =>
                          toggleCommit(card.root, WORKTREE_SELECTION)
                        }
                      />
                      <span className="commit-row__hash">
                        wt
                        {card.selectedHashes.includes(WORKTREE_SELECTION) ? (
                          <span className="commit-row__badge">
                            head
                          </span>
                        ) : null}
                      </span>
                      <span className="commit-row__subject">
                        Uncommitted changes
                        {dirty > 0 ? ` · ${dirty}` : " · clean"}
                      </span>
                      <span className="commit-row__meta">now</span>
                    </label>
                  </li>

                  {card.commits.map((c) => {
                    const checked = card.selectedHashes.includes(c.hash);
                    const selectedCommitOrder = card.commits
                      .filter((commit) =>
                        card.selectedHashes.includes(commit.hash),
                      )
                      .reverse()
                      .map((commit) => commit.hash);
                    const order = selectedCommitOrder.indexOf(c.hash);
                    const lockedOut = selectionFull && !checked;
                    return (
                      <li key={c.hash}>
                        <label
                          className={`commit-row${checked ? " is-selected" : ""}${
                            lockedOut ? " is-disabled" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="anchor-checkbox"

                            checked={checked}
                            disabled={lockedOut}
                            onChange={() => toggleCommit(card.root, c.hash)}
                          />
                          <span className="commit-row__hash">
                            {c.shortHash}
                            {order >= 0 ? (
                              <span className="commit-row__badge">
                                {order === 0 ? "base" : "head"}
                              </span>
                            ) : null}
                          </span>
                          <span
                            className="commit-row__subject"
                            title={c.subject}
                          >
                            {c.subject}
                          </span>
                          <span className="commit-row__meta" title={c.dateIso}>
                            {formatRelative(c.dateIso)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {card.logHasMore ? (
                  <div className="history-pane__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={card.logStatus === "loading"}
                      onClick={() => void loadMoreLog(card.root)}
                    >
                      {card.logStatus === "loading"
                        ? "Loading…"
                        : "Load more commits"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* COMPARES — default closed */}
          <div className="repo-block">
            <div className="repo-block__head">
              <button
                type="button"
                className="repo-block__toggle"
                onClick={() => toggleCompares(card.root)}
                aria-expanded={card.comparesOpen}
              >
                <Icon
                  name={card.comparesOpen ? "chevron-down" : "chevron-right"}
                />
                <span className="repo-block__title">
                  Compares{recent.length > 0 ? ` · ${recent.length}` : ""}
                </span>
              </button>
            </div>
            {card.comparesOpen ? (
              <div className="repo-block__body">
                {recent.length === 0 ? (
                  <p className="pane-hint">None yet for this repo.</p>
                ) : (
                  <ul className="recent-compare-list">
                    {recent.map((e) => (
                      <li key={e.id} className="recent-compare-row">
                        <button
                          type="button"
                          className="recent-compare-row__open"
                          title="Re-open this compare"
                          onClick={() => void openHistoryRecent(e)}
                        >
                          {stripRepoPrefix(e.label, e.repoName)}
                        </button>
                        <button
                          type="button"
                          className="icon-btn recent-compare-row__remove"
                          aria-label="Remove from recent"
                          onClick={() => void removeRecent(e.id)}
                        >
                          <Icon name="close" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BranchSwitcher({
  card,
  branchLabel,
}: {
  card: RepoCardState;
  branchLabel: string | null;
}) {
  const loadBranches = useHistoryStore((s) => s.loadBranches);
  const checkoutBranch = useHistoryStore((s) => s.checkoutBranch);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Only show "detached" after a successful status with branch === null.
  // While first-load / switching, show "…" — never wipe a known branch.
  const busy = card.switchingBranch;
  const label =
    branchLabel ?? (busy || !card.status ? "…" : "detached");

  const toggle = () => {
    if (busy) return;
    const next = !open;
    setOpen(next);
    if (next) void loadBranches(card.root);
  };

  const onPick = async (name: string) => {
    if (name === branchLabel) {
      setOpen(false);
      return;
    }
    const ok = await checkoutBranch(card.root, name);
    if (ok) setOpen(false);
  };

  return (
    <div className="repo-branch" ref={rootRef}>
      <button
        type="button"
        className={`repo-branch__btn${open ? " is-open" : ""}`}
        onClick={toggle}
        disabled={busy}
        aria-label={
          branchLabel
            ? `Current branch: ${branchLabel}. Click to switch.`
            : card.status
              ? "Detached HEAD. Click to switch to a branch."
              : "Loading branch…"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name="git-branch" className="repo-branch__icon" />
        <span className="repo-branch__label">{label}</span>
      </button>
      {open ? (
        <div className="repo-branch__menu" role="listbox" aria-label="Branches">
          {card.branchesStatus === "loading" ? (
            <p className="repo-branch__empty">Loading branches…</p>
          ) : null}
          {card.branchesError ? (
            <p className="repo-branch__empty pane-hint--error">
              {card.branchesError}
            </p>
          ) : null}
          {card.branchesStatus === "idle" && card.branches.length === 0 ? (
            <p className="repo-branch__empty">No local branches</p>
          ) : null}
          <ul className="repo-branch__list">
            {card.branches.map((b) => (
              <li key={b.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={b.current}
                  className={`repo-branch__item${
                    b.current ? " is-current" : ""
                  }`}
                  disabled={busy || b.current}
                  onClick={() => void onPick(b.name)}
                >
                  <span className="repo-branch__item-name">{b.name}</span>
                  {b.current ? (
                    <span className="repo-branch__item-badge">current</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function stripRepoPrefix(label: string, repoName: string): string {
  const p = `${repoName} · `;
  return label.startsWith(p) ? label.slice(p.length) : label;
}

function formatRelative(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
