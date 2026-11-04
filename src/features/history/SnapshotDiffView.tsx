import { lazy, Suspense, useMemo, useState } from "react";
import type { SnapshotDiffRepo } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import { StatusTag, type TagTone } from "./StatusTag";
import { formatBytes } from "@/core/snapshots/model";
import { useDocumentStore, type OpenItem } from "@/features/document/documentStore";

const DiffViewer = lazy(() =>
  import("@/features/document/DiffViewer").then((m) => ({ default: m.DiffViewer })),
);

type SnapshotDiffItem = Extract<OpenItem, { kind: "snapshot-diff" }>;
type DiffItem = Extract<OpenItem, { kind: "diff" }>;

const STATE_LABEL: Record<SnapshotDiffRepo["state"], string> = {
  changed: "",
  unchanged: "无变化",
  added: "快照后新增仓",
  removed: "该仓已不在工作区",
  error: "读取失败",
};

const LARGE_STATUS: Record<"A" | "M" | "D", string> = {
  A: "新增",
  M: "已变化（大小或修改时间不同）",
  D: "已删除",
};

function repoCount(r: SnapshotDiffRepo): number {
  return r.files.length + r.largeFiles.length;
}

/** Read-only multi-repo snapshot diff: grouped file list + existing DiffViewer. */
const STATE_TONE: Partial<Record<SnapshotDiffRepo["state"], TagTone>> = {
  unchanged: "muted",
  added: "ok",
  removed: "warn",
  error: "danger",
};

export function SnapshotDiffView({ item }: { item: SnapshotDiffItem }) {
  const setActive = useDocumentStore((s) => s.setSnapshotDiffActive);
  const { payload, active } = item;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(payload.repos.map((r) => [r.root, r.state === "changed" || r.state === "added"])),
  );
  const totals = useMemo(() => {
    const changed = payload.repos.filter((r) => repoCount(r) > 0);
    return { repos: changed.length, files: changed.reduce((n, r) => n + repoCount(r), 0) };
  }, [payload.repos]);

  const activeRepo = active ? payload.repos.find((r) => r.root === active.repoRoot) : undefined;
  const activeLarge = active?.large ? activeRepo?.largeFiles.find((f) => f.path === active.path) : undefined;
  const activeFile = !active?.large ? activeRepo?.files.find((f) => f.path === active?.path) : undefined;

  const diffItem: DiffItem | null =
    activeRepo && activeFile
      ? {
          id: `${item.id}:${activeRepo.root}:${activeFile.path}`,
          kind: "diff",
          title: `${activeRepo.name} · ${payload.title}`,
          repoRoot: activeRepo.root,
          base: activeRepo.base,
          head: activeRepo.head,
          files: activeRepo.files,
          activeFilePath: activeFile.path,
          branch: null,
          hideFileList: true,
          focusRangeLabel: payload.title,
        }
      : null;

  return (
    <div className="diff-viewer snapshot-diff" data-testid="snapshot-diff">
      <aside className="diff-viewer__files snapshot-diff__files">
        <div className="diff-viewer__files-head">
          <div className="diff-viewer__range" title={payload.title}>
            {payload.title}
          </div>
        </div>
        <div className="diff-viewer__meta">
          {totals.repos} 仓有变化 · {totals.files} 个文件
        </div>
        {payload.overlapWarning ? (
          <div className="banner banner--warn snapshot-diff__warn" role="status">
            <Icon name="warning" /> {payload.overlapWarning}
          </div>
        ) : null}
        <ul className="snapshot-diff__repos">
          {payload.repos.map((repo) => {
            const count = repoCount(repo);
            const isOpen = expanded[repo.root] === true && count > 0;
            return (
              <li key={repo.root} className={`snapshot-diff__repo is-${repo.state}`}>
                <button
                  type="button"
                  className="snapshot-diff__repo-head"
                  aria-expanded={isOpen}
                  disabled={count === 0}
                  title={repo.error ?? repo.root}
                  onClick={() => setExpanded((e) => ({ ...e, [repo.root]: !isOpen }))}
                >
                  <Icon name={isOpen ? "chevron-down" : "chevron-right"} />
                  <span className="snapshot-diff__repo-name">{repo.name}</span>
                  {STATE_LABEL[repo.state] ? (
                    <StatusTag tone={STATE_TONE[repo.state] ?? "muted"}>{STATE_LABEL[repo.state]}</StatusTag>
                  ) : null}
                  {count > 0 ? (
                    <span className="snapshot-diff__repo-count" title={`${count} 个文件有变化`}>
                      {count}
                    </span>
                  ) : null}
                </button>
                {isOpen ? (
                  <ul className="diff-file-list">
                    {repo.files.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          className={`diff-file-list__row${
                            active?.repoRoot === repo.root && !active.large && active.path === f.path ? " is-selected" : ""
                          }`}
                          onClick={() => setActive(item.id, { repoRoot: repo.root, path: f.path })}
                        >
                          <span className={`diff-file-list__status status-${f.status[0] ?? "M"}`}>{f.status[0]}</span>
                          <span className="diff-file-list__path" title={f.path}>
                            {f.path}
                          </span>
                        </button>
                      </li>
                    ))}
                    {repo.largeFiles.map((f) => (
                      <li key={`large:${f.path}`}>
                        <button
                          type="button"
                          className={`diff-file-list__row${
                            active?.repoRoot === repo.root && active.large && active.path === f.path ? " is-selected" : ""
                          }`}
                          onClick={() => setActive(item.id, { repoRoot: repo.root, path: f.path, large: true })}
                        >
                          <span className={`diff-file-list__status status-${f.status}`}>{f.status}</span>
                          <span className="diff-file-list__path" title={f.path}>
                            {f.path}
                          </span>
                          <StatusTag tone="warn" className="snapshot-large-badge" title="超过 5 MB 的未跟踪文件：只记录名字、大小和修改时间">
                            大文件，未记录内容
                          </StatusTag>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="diff-viewer__main">
        {diffItem ? (
          <Suspense fallback={<div className="empty-center muted">Loading diff…</div>}>
            <DiffViewer key={diffItem.id} item={diffItem} />
          </Suspense>
        ) : activeLarge && activeRepo ? (
          <div className="snapshot-large-info" data-testid="snapshot-large-info">
            <Icon name="file-media" />
            <h3>{activeLarge.path}</h3>
            <dl>
              <dt>仓库</dt>
              <dd>{activeRepo.name}</dd>
              <dt>大小</dt>
              <dd>{formatBytes(activeLarge.size)}</dd>
              <dt>状态</dt>
              <dd>{LARGE_STATUS[activeLarge.status]}</dd>
            </dl>
            <p className="muted">超过 5 MB 的未跟踪文件不记录内容，只记录名字、大小和修改时间。</p>
          </div>
        ) : (
          <div className="empty-center muted">
            {totals.files === 0 ? "这两个点之间没有改动。" : "选择左侧文件查看 diff。"}
          </div>
        )}
      </div>
    </div>
  );
}
