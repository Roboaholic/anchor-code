import {
  openFileFromTree,
  openWorkspacePath,
} from "@/features/shell/orchestrate";
import {
  useWorkspaceStore,
  type TreeNode,
} from "@/features/workspace/workspaceStore";
import { Icon } from "@/shared/Icon";
import type { CodiconName } from "@/shared/Icon";

export function FileTree() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const rootEntries = useWorkspaceStore((s) => s.rootEntries);
  const status = useWorkspaceStore((s) => s.status);
  const error = useWorkspaceStore((s) => s.error);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const recent = useWorkspaceStore((s) => s.recent);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);

  if (!workspaceRoot) {
    return (
      <div className="files-pane">
        <div className="files-pane__title">NO WORKSPACE</div>
        <p className="pane-hint">
          Use <strong>Open Workspace</strong> below (or File menu) to choose a
          folder. Non-git directories are fine for reading.
        </p>
        <div className="files-pane__actions">
          <button
            type="button"
            className="btn btn--accent files-pane__open-ws"
            onClick={() =>
              void import("@/features/shell/orchestrate").then((m) =>
                m.openWorkspaceFromPicker(),
              )
            }
          >
            <Icon name="folder-opened" className="files-pane__open-ws-icon" />
            Open Workspace
          </button>
        </div>
        {status === "error" && error ? (
          <p className="pane-hint pane-hint--error">{error}</p>
        ) : null}
        {recent.length > 0 ? (
          <div className="recent-list">
            <div className="files-pane__title">RECENT</div>
            <ul className="file-tree recent-list__items">
              {recent.map((r) => {
                const name =
                  r.path.split(/[/\\]/).filter(Boolean).pop() ?? r.path;
                const hostLabel =
                  r.hostProfileId === "local-default"
                    ? "local"
                    : r.hostProfileId === "wsl-default"
                      ? "wsl"
                      : r.hostProfileId;
                return (
                  <li key={`${r.hostProfileId}:${r.path}`}>
                    <button
                      type="button"
                      className="file-tree__row recent-row"
                      title={`${r.path} (${hostLabel})`}
                      onClick={() =>
                        void openWorkspacePath(r.path, r.hostProfileId)
                      }
                    >
                      <Icon name="folder" className="file-tree__icon" />
                      <span className="recent-row__text">
                        <span className="recent-row__name">{name}</span>
                        <span className="recent-row__path">{r.path}</span>
                      </span>
                      <span className="recent-row__host">{hostLabel}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="files-pane">
        <div className="files-pane__title">LOADING…</div>
        <p className="pane-hint" title={workspaceRoot}>
          {workspaceName ?? workspaceRoot}
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="files-pane">
        <div className="files-pane__title" title={workspaceRoot}>
          {(workspaceName ?? "WORKSPACE").toUpperCase()} (ERROR)
        </div>
        <p className="pane-hint pane-hint--error">{error}</p>
        {rootEntries.length > 0 ? (
          <ul className="file-tree" role="tree">
            {rootEntries.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onToggle={(p) => void toggleDir(p)}
                onOpenFile={(p) => void openFileFromTree(p)}
              />
            ))}
          </ul>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--small"
            style={{ margin: 12 }}
            onClick={() =>
              workspaceRoot
                ? void openWorkspacePath(workspaceRoot)
                : undefined
            }
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="files-pane">
      <div className="files-pane__title" title={workspaceRoot}>
        {(workspaceName ?? "WORKSPACE").toUpperCase()} (WORKSPACE)
      </div>
      <ul className="file-tree" role="tree">
        {rootEntries.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onToggle={(p) => void toggleDir(p)}
            onOpenFile={(p) => void openFileFromTree(p)}
          />
        ))}
      </ul>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const selected = selectedPath === node.path;
  const pad = 8 + depth * 12;

  if (node.type === "dir") {
    return (
      <li role="treeitem" aria-expanded={node.expanded}>
        <button
          type="button"
          className={`file-tree__row${selected ? " is-selected" : ""}`}
          style={{ paddingLeft: pad }}
          onClick={() => onToggle(node.path)}
        >
          <Icon
            name={node.expanded ? "chevron-down" : "chevron-right"}
            className="file-tree__chevron"
          />
          <Icon
            name={node.expanded ? "folder-opened" : "folder"}
            className="file-tree__icon"
          />
          <span className="file-tree__name">{node.name}</span>
        </button>
        {node.error ? (
          <div className="file-tree__error" style={{ paddingLeft: pad + 20 }}>
            {node.error}
          </div>
        ) : null}
        {node.expanded && node.children ? (
          <ul className="file-tree file-tree--nested" role="group">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li role="treeitem">
      <button
        type="button"
        className={`file-tree__row${selected ? " is-selected" : ""}`}
        style={{ paddingLeft: pad + 14 }}
        onClick={() => onOpenFile(node.path)}
      >
        <Icon name={fileIcon(node.name)} className="file-tree__icon" />
        <span className="file-tree__name">{node.name}</span>
      </button>
    </li>
  );
}

function fileIcon(name: string): CodiconName {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".html") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".go")
  ) {
    return "file-code";
  }
  return "file";
}
