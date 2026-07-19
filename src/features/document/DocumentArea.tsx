import { CodeViewer } from "./CodeViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { useDocumentStore, type OpenItem } from "./documentStore";

export function DocumentArea() {
  const openItems = useDocumentStore((s) => s.openItems);
  const activeId = useDocumentStore((s) => s.activeId);
  const setActive = useDocumentStore((s) => s.setActive);
  const closeItem = useDocumentStore((s) => s.closeItem);
  const setMdViewMode = useDocumentStore((s) => s.setMdViewMode);

  const active = openItems.find((i) => i.id === activeId) ?? openItems[0] ?? null;

  return (
    <section className="document-area">
      <div className="tabs" role="tablist" aria-label="Open items">
        {openItems.map((item) => (
          <div
            key={item.id}
            className={`tab${item.id === active?.id ? " is-active" : ""}`}
            role="tab"
            aria-selected={item.id === active?.id}
            onClick={() => setActive(item.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActive(item.id);
              }
            }}
            tabIndex={0}
          >
            <span className="tab__icon" aria-hidden>
              {tabIcon(item)}
            </span>
            <span className="tab__label" title={itemTitle(item)}>
              {item.title}
            </span>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${item.title}`}
              onClick={(e) => {
                e.stopPropagation();
                closeItem(item.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="document-area__content document-area__content--fill">
        {active ? (
          <ActiveView
            item={active}
            onMdMode={(mode) => {
              if (active.kind === "file") setMdViewMode(active.id, mode);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function ActiveView({
  item,
  onMdMode,
}: {
  item: OpenItem;
  onMdMode: (mode: "rendered" | "raw") => void;
}) {
  if (item.kind === "welcome") {
    return <WelcomeView />;
  }

  if (item.kind === "diff") {
    return (
      <div className="empty-center">
        <p>Diff view arrives in Slice 3 (History compare).</p>
      </div>
    );
  }

  if (item.error) {
    return (
      <div className="empty-center">
        <p className="error-text">Failed to open file</p>
        <p className="muted">{item.error}</p>
      </div>
    );
  }

  if (item.isMarkdown) {
    return (
      <MarkdownViewer
        path={item.path}
        content={item.content}
        truncated={item.truncated}
        mode={item.mdViewMode}
        onModeChange={onMdMode}
      />
    );
  }

  return (
    <CodeViewer
      path={item.path}
      content={item.content}
      language={item.language}
      truncated={item.truncated}
    />
  );
}

function WelcomeView() {
  return (
    <article className="welcome">
      <h1 className="welcome__title">Anchor Code</h1>
      <p className="welcome__lead">
        Human-in-the-loop workbench for{" "}
        <strong>auditing AI coding output</strong> and feeding structured
        feedback back to AI CLIs — not a general-purpose IDE.
      </p>

      <ol className="welcome__steps">
        <li>
          <strong>Open a workspace</strong> — top-left Open Workspace, then
          browse the file tree (this slice).
        </li>
        <li>
          <strong>Read</strong> — code is read-only Monaco; Markdown defaults to
          Rendered (toggle Raw).
        </li>
        <li>
          <strong>Compare</strong> — History dual-commit diff (Slice 3).
        </li>
        <li>
          <strong>Annotate & hand off</strong> — session YAML path to the AI CLI
          (Slices 4–5).
        </li>
      </ol>

      <p className="welcome__meta">
        Central pane never shows a multi-repo switcher. Git multi-root lives only
        in History.
      </p>
    </article>
  );
}

function tabIcon(item: OpenItem): string {
  if (item.kind === "welcome") return "✦";
  if (item.kind === "diff") return "±";
  if (item.kind === "file" && item.isMarkdown) return "MD";
  if (item.kind === "file") {
    const lang = item.language;
    if (lang === "typescript") return "TS";
    if (lang === "javascript") return "JS";
    return "◇";
  }
  return "◇";
}

function itemTitle(item: OpenItem): string {
  if (item.kind === "file") return item.relativePath || item.path;
  return item.title;
}
