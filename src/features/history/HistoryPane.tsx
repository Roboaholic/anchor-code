import { useEffect } from "react";
import { Icon } from "@/shared/Icon";
import { joinPath } from "@/core/workspace/paths";
import {
  openFileFromTree,
  openHistoryCompare,
  openHistoryRecent,
} from "@/features/shell/orchestrate";
import {
  WORKTREE_SELECTION,
  recentForRepo,
  selectionLabelForCard,
  statusEntries,
  useHistoryStore,
  type RepoCardState,
} from "@/features/history/historyStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { HistoryCompareEntry } from "@/shared/anchor-api";

export function HistoryPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const repos = useHistoryStore((s) => s.repos);
  const discoverStatus = useHistoryStore((s) => s.discoverStatus);
  const discoverError = useHistoryStore((s) => s.discoverError);
  const recentCompares = useHistoryStore((s) => s.recentCompares);
  const toast = useHistoryStore((s) => s.toast);
  const clearToast = useHistoryStore((s) => s.clearToast);
  const discover = useHistoryStore((s) => s.discover);

  useEffect(() => {
    if (!workspaceRoot) return;
    if (discoverStatus === "loading") return;
    if (repos.length > 0) return;
    if (discoverStatus === "error") return;
    void discover(workspaceRoot);
  }, [workspaceRoot, discoverStatus, repos.length, discover]);

  if (!workspaceRoot) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint">Open a workspace to discover git roots.</p>
      </div>
    );
  }

  if (discoverStatus === "loading" && repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint">Scanning for repositories…</p>
      </div>
    );
  }

  if (discoverStatus === "error" && repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint pane-hint--error">
          {discoverError ?? "Failed to scan repositories"}
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => void discover(workspaceRoot)}
        >
          Rescan
        </button>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint">
          No git root found under this workspace. Reading still works.
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => void discover(workspaceRoot)}
        >
          Rescan
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
          className="btn btn--ghost btn--small"
          onClick={() => void discover(workspaceRoot)}
          title="Rescan for git roots"
        >
          Rescan
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
  const toggleCompares = useHistoryStore((s) => s.toggleCompares);
  const toggleCommit = useHistoryStore((s) => s.toggleCommit);
  const swap = useHistoryStore((s) => s.swap);
  const refreshStatus = useHistoryStore((s) => s.refreshStatus);
  const removeRecent = useHistoryStore((s) => s.removeRecent);

  const dirty = dirtyCount(card);
  const label = selectionLabelForCard(card);
  const canCompare = card.selectedHashes.length > 0 && !card.comparing;
  const entries = statusEntries(card);

  return (
    <div className={`repo-row${card.expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="repo-row__header"
        onClick={() => toggleExpanded(card.root)}
        aria-expanded={card.expanded}
      >
        <Icon
          name={card.expanded ? "chevron-down" : "chevron-right"}
          className="repo-row__chevron"
        />
        <span className="repo-row__name" title={card.root}>
          {card.name}
        </span>
        <span className="repo-row__meta">
          {card.statusState === "loading" ? (
            <span className="repo-row__count is-muted">…</span>
          ) : dirty > 0 ? (
            <>
              {(card.status?.modified ?? 0) > 0 ? (
                <span className="repo-row__count" title="Modified">
                  M{card.status!.modified}
                </span>
              ) : null}
              {(card.status?.added ?? 0) > 0 ? (
                <span className="repo-row__count" title="Added">
                  A{card.status!.added}
                </span>
              ) : null}
              {(card.status?.deleted ?? 0) > 0 ? (
                <span className="repo-row__count" title="Deleted">
                  D{card.status!.deleted}
                </span>
              ) : null}
              {(card.status?.untracked ?? 0) > 0 ? (
                <span className="repo-row__count" title="Untracked">
                  ?{card.status!.untracked}
                </span>
              ) : null}
            </>
          ) : (
            <span className="repo-row__count is-muted">clean</span>
          )}
        </span>
      </button>

      {card.expanded ? (
        <div className="repo-row__body">
          {/* CHANGES — default open */}
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
                <span className="repo-block__title">
                  Changes{dirty > 0 ? ` · ${dirty}` : ""}
                </span>
              </button>
              <div className="repo-block__head-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => void refreshStatus(card.root)}
                  title="Refresh working tree status"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn btn--accent btn--small"
                  disabled={!canCompare}
                  onClick={() => void openHistoryCompare(card.root)}
                  title="Start compare from current selection"
                >
                  {card.comparing ? "…" : "Compare"}
                </button>
              </div>
            </div>
            {card.changesOpen ? (
              <div className="repo-block__body">
                {card.statusError ? (
                  <p className="pane-hint pane-hint--error">{card.statusError}</p>
                ) : null}
                {card.statusState === "loading" ? (
                  <p className="pane-hint">Loading status…</p>
                ) : null}

                <label
                  className={`commit-row commit-row--wt${
                    card.selectedHashes.includes(WORKTREE_SELECTION)
                      ? " is-selected"
                      : ""
                  }${dirty === 0 ? " is-disabled" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={card.selectedHashes.includes(WORKTREE_SELECTION)}
                    disabled={dirty === 0}
                    onChange={() =>
                      toggleCommit(card.root, WORKTREE_SELECTION)
                    }
                  />
                  <span className="commit-row__hash">wt</span>
                  <span className="commit-row__subject">
                    Uncommitted
                    {dirty > 0 ? ` · ${dirty}` : " · clean"}
                  </span>
                  <span className="commit-row__meta">
                    {card.selectedHashes.includes(WORKTREE_SELECTION)
                      ? card.selectedHashes.indexOf(WORKTREE_SELECTION) === 0
                        ? "base"
                        : "head"
                      : ""}
                  </span>
                </label>

                {entries.length > 0 ? (
                  <ul className="wt-list">
                    {entries.map((e) => (
                      <li key={`${e.code}:${e.path}`}>
                        <button
                          type="button"
                          className="wt-row wt-row--btn"
                          title={`Open ${e.path}`}
                          disabled={e.status === "D"}
                          onClick={() => {
                            if (e.status === "D") return;
                            const abs = joinPath(card.root, e.path);
                            void openFileFromTree(abs);
                          }}
                        >
                          <span className="wt-row__status">{e.status}</span>
                          <span className="wt-row__path">{e.path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : dirty === 0 && card.statusState !== "loading" ? (
                  <p className="pane-hint">No local changes.</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* HISTORY — default closed */}
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
            </div>
            {card.historyOpen ? (
              <div className="repo-block__body">
                {card.logError ? (
                  <p className="pane-hint pane-hint--error">{card.logError}</p>
                ) : null}
                {card.logStatus === "loading" ? (
                  <p className="pane-hint">Loading commits…</p>
                ) : null}

                <div className="history-pane__actions">
                  <div
                    className="history-pane__label"
                    title={label ?? undefined}
                  >
                    {label ?? "Select range · max 2"}
                  </div>
                  <div className="history-pane__btns">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      disabled={card.selectedHashes.length !== 2}
                      onClick={() => swap(card.root)}
                    >
                      Swap
                    </button>
                    <button
                      type="button"
                      className="btn btn--accent btn--small"
                      disabled={!canCompare}
                      onClick={() => void openHistoryCompare(card.root)}
                    >
                      {card.comparing ? "…" : "Start Compare"}
                    </button>
                  </div>
                </div>

                <ul className="commit-list">
                  {card.commits.map((c) => {
                    const checked = card.selectedHashes.includes(c.hash);
                    const order = card.selectedHashes.indexOf(c.hash);
                    return (
                      <li key={c.hash}>
                        <label
                          className={`commit-row${checked ? " is-selected" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
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
