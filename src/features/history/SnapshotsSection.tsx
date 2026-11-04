import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotMeta } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import { SegmentedControl } from "@/shared/SegmentedControl";
import { StatusTag, ownerTag } from "./StatusTag";
import { Checkbox } from "@/shared/Checkbox";
import { overlapWarning } from "@/core/snapshots/model";
import { filterSnapshots, useSnapshotStore, type SnapshotFilter } from "./snapshotStore";

const FILTER_OPTIONS: { value: SnapshotFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "manual", label: "手动" },
  { value: "auto", label: "自动" },
  { value: "agent", label: "Agent" },
];

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function repoTooltip(s: SnapshotMeta): string {
  return s.repos
    .map((r) => (r.status === "ok" ? r.name : `${r.name}: 失败 — ${r.note ?? "error"}`))
    .join("\n");
}

function SnapshotRow({ s }: { s: SnapshotMeta }) {
  const selected = useSnapshotStore((st) => st.selected.includes(s.id));
  const toggleSelected = useSnapshotStore((st) => st.toggleSelected);
  const openCompare = useSnapshotStore((st) => st.openCompare);
  const rename = useSnapshotStore((st) => st.rename);
  const remove = useSnapshotStore((st) => st.remove);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.name);
  const owner = ownerTag(s);
  const ownerTitle =
    s.source === "manual" ? "你手动打的快照" : s.agentLabel ? `${s.agentLabel}${s.source === "auto" ? " 轮次自动快照" : " 打的快照"}` : "自动快照";

  return (
    <li data-testid="snapshot-row">
      <div className={`commit-row snapshot-row${selected ? " is-selected" : ""}`}>
        <Checkbox checked={selected} onChange={() => toggleSelected(s.id)} aria-label={`选择快照 ${s.name}`} />
        {editing ? (
          <form
            className="snapshot-row__edit"
            onSubmit={(e) => {
              e.preventDefault();
              void rename(s.id, draft);
              setEditing(false);
            }}
          >
            <input
              className="field__input"
              value={draft}
              autoFocus
              aria-label="快照名称"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="snapshot-row__main"
            title={`${s.name}\n单击：与当前工作区比较\n${repoTooltip(s)}`}
            onClick={() => void openCompare(s.id)}
          >
            <span className="commit-row__subject">{s.name}</span>
          </button>
        )}
        <span className="snapshot-row__end">
          <span className="commit-row__meta snapshot-row__time" title={new Date(s.createdAt).toLocaleString()}>
            {timeLabel(s.createdAt)}
          </span>
          <span className="snapshot-row__actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="重命名"
              title="重命名快照"
              onClick={() => {
                setDraft(s.name);
                setEditing(true);
              }}
            >
              <Icon name="edit" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="删除快照"
              title="删除快照（不影响任何仓的代码）"
              onClick={() => void remove(s.id)}
            >
              <Icon name="trash" />
            </button>
          </span>
          <StatusTag tone={owner.tone} className="snapshot-owner-tag" title={ownerTitle} data-testid="snapshot-owner">
            <span>{owner.label}</span>
          </StatusTag>
        </span>
      </div>
    </li>
  );
}

/** HISTORY → Snapshots: workspace-wide 打点 across every repo. */
export function SnapshotsSection({ workspaceRoot }: { workspaceRoot: string }) {
  const snapshots = useSnapshotStore((s) => s.snapshots);
  const loaded = useSnapshotStore((s) => s.loaded);
  const creating = useSnapshotStore((s) => s.creating);
  const comparing = useSnapshotStore((s) => s.comparing);
  const error = useSnapshotStore((s) => s.error);
  const filter = useSnapshotStore((s) => s.filter);
  const selected = useSnapshotStore((s) => s.selected);
  const load = useSnapshotStore((s) => s.load);
  const create = useSnapshotStore((s) => s.create);
  const setFilter = useSnapshotStore((s) => s.setFilter);
  const openCompare = useSnapshotStore((s) => s.openCompare);
  const clearSelection = useSnapshotStore((s) => s.clearSelection);
  const [open, setOpen] = useState(true);
  const [naming, setNaming] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load, workspaceRoot]);

  const visible = useMemo(() => filterSnapshots(snapshots, filter), [snapshots, filter]);
  const pair = useMemo(() => {
    if (selected.length !== 2) return null;
    const picked = snapshots
      .filter((s) => selected.includes(s.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return picked.length === 2 ? picked : null;
  }, [selected, snapshots]);
  const warning = pair ? overlapWarning(snapshots, pair[0]!.id, pair[1]!.id) : undefined;

  const submit = async () => {
    const meta = await create(name);
    if (meta) {
      setName("");
      setNaming(false);
    }
  };

  return (
    <section className="snapshots-section" aria-label="快照">
      <div className="history-pane__toolbar snapshots-section__head">
        <button
          type="button"
          className="snapshots-section__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "折叠快照" : "展开快照"}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} />
          <span className="files-pane__title">快照</span>
          {snapshots.length ? (
            <span className="snapshots-section__count" title={`共 ${snapshots.length} 个快照`}>
              {snapshots.length}
            </span>
          ) : null}
        </button>
        <span className="snapshots-section__actions">
          <button
            type="button"
            className={`icon-btn${showFilter || filter !== "all" ? " is-active" : ""}`}
            aria-label="按来源筛选"
            title={`按来源筛选（当前：${FILTER_OPTIONS.find((o) => o.value === filter)?.label}）`}
            aria-pressed={showFilter}
            onClick={() => setShowFilter((v) => !v)}
          >
            <Icon name={filter !== "all" ? "filter-filled" : "filter"} />
          </button>
          <button
            type="button"
            className={`icon-btn${naming ? " is-active" : ""}`}
            aria-label="命名后打点"
            title="命名后打点：先输入名字再记录"
            onClick={() => {
              setNaming((v) => !v);
              setTimeout(() => nameRef.current?.focus(), 0);
            }}
          >
            <Icon name="tag" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="打点"
            title={creating ? "打点中…" : "打点：记录工作区内所有仓的当前状态"}
            disabled={creating}
            onClick={() => void create()}
            data-testid="snapshot-create"
          >
            <Icon name={creating ? "loading" : "add"} className={creating ? "codicon-modifier-spin" : undefined} />
          </button>
        </span>
      </div>
      {open ? (
        <div className="snapshots-section__body">
          {showFilter ? (
            <div className="snapshots-section__bar">
              <SegmentedControl size="sm" aria-label="按来源筛选" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
            </div>
          ) : null}
          {naming ? (
            <form
              className="snapshots-section__bar"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <input
                ref={nameRef}
                className="field__input"
                placeholder="快照名称（默认当前时间）"
                value={name}
                aria-label="新快照名称"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className="icon-btn" aria-label="确认打点" title="确认打点" disabled={creating}>
                <Icon name="check" />
              </button>
            </form>
          ) : null}
          {error ? <p className="pane-hint pane-hint--error">{error}</p> : null}
          {selected.length > 0 ? (
            <div className="snapshots-section__bar">
              <span className="commit-row__meta snapshots-section__grow">
                {pair ? "已选 2 个，比较较早 → 较晚" : `已选 ${selected.length} 个，再选 1 个即可比较`}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="比较所选"
                title="比较所选的两个快照（较早 → 较晚）"
                disabled={!pair || comparing}
                onClick={() => pair && void openCompare(pair[0]!.id, pair[1]!.id)}
                data-testid="snapshot-compare"
              >
                <Icon name="git-compare" />
              </button>
              <button type="button" className="icon-btn" aria-label="清除选择" title="清除选择" onClick={clearSelection}>
                <Icon name="clear-all" />
              </button>
            </div>
          ) : null}
          {warning ? (
            <div className="banner banner--warn snapshots-section__warn" role="status">
              <Icon name="warning" /> {warning}
            </div>
          ) : null}
          {visible.length === 0 ? (
            <p className="pane-hint">
              {loaded ? "还没有快照。点 + 记录所有仓的当前状态。" : "加载中…"}
            </p>
          ) : (
            <ul className="snapshot-list">
              {visible.map((s) => (
                <SnapshotRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
