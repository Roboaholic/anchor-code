import { runHistoryCompare } from "@/features/shell/orchestrate";
import {
  selectionLabel,
  useHistoryStore,
} from "@/features/history/historyStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";

export function HistoryPane() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const repos = useHistoryStore((s) => s.repos);
  const selectedRepoRoot = useHistoryStore((s) => s.selectedRepoRoot);
  const commits = useHistoryStore((s) => s.commits);
  const logStatus = useHistoryStore((s) => s.logStatus);
  const logError = useHistoryStore((s) => s.logError);
  const selectedHashes = useHistoryStore((s) => s.selectedHashes);
  const toast = useHistoryStore((s) => s.toast);
  const comparing = useHistoryStore((s) => s.comparing);
  const selectRepo = useHistoryStore((s) => s.selectRepo);
  const toggleCommit = useHistoryStore((s) => s.toggleCommit);
  const swap = useHistoryStore((s) => s.swap);
  const clearToast = useHistoryStore((s) => s.clearToast);
  const discover = useHistoryStore((s) => s.discover);

  if (!workspaceRoot) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint">Open a workspace to discover git roots.</p>
      </div>
    );
  }

  if (logStatus === "loading" && repos.length === 0) {
    return (
      <div className="empty-pane">
        <h2 className="empty-pane__title">History (Git)</h2>
        <p className="empty-pane__hint">Scanning for repositories…</p>
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

  const label = selectionLabel(selectedHashes, commits);
  const compareText =
    selectedHashes.length === 1
      ? "Compare with worktree"
      : selectedHashes.length === 2
        ? "Compare"
        : "Compare";

  return (
    <div className="history-pane">
      <div className="history-pane__header">
        <label className="history-pane__repo">
          <span className="files-pane__title">REPO</span>
          <select
            value={selectedRepoRoot ?? ""}
            onChange={(e) => void selectRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {toast ? (
        <div className="banner banner--warn history-toast" role="status">
          <span>{toast}</span>
          <button type="button" className="icon-btn" onClick={clearToast}>
            ×
          </button>
        </div>
      ) : null}

      {logError ? (
        <p className="pane-hint pane-hint--error">{logError}</p>
      ) : null}

      <div className="history-pane__actions">
        <div className="history-pane__label" title={label ?? undefined}>
          {label ?? "Select 1 or 2 commits"}
        </div>
        <div className="history-pane__btns">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={selectedHashes.length !== 2}
            onClick={swap}
          >
            Swap
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={selectedHashes.length === 0 || comparing}
            onClick={() => void runHistoryCompare()}
          >
            {comparing ? "…" : compareText}
          </button>
        </div>
      </div>

      <ul className="commit-list">
        {commits.map((c) => {
          const checked = selectedHashes.includes(c.hash);
          const order = selectedHashes.indexOf(c.hash);
          return (
            <li key={c.hash}>
              <label
                className={`commit-row${checked ? " is-selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleCommit(c.hash)}
                />
                <span className="commit-row__hash">
                  {c.shortHash}
                  {order >= 0 ? (
                    <span className="commit-row__badge">
                      {order === 0 ? "base" : "head"}
                    </span>
                  ) : null}
                </span>
                <span className="commit-row__subject" title={c.subject}>
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
  );
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
