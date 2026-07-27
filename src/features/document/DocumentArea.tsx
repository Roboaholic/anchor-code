import { useCallback, useState, type DragEvent } from "react";
import { Icon } from "@/shared/Icon";
import type { CodiconName } from "@/shared/Icon";
import { CodeViewer } from "./CodeViewer";
import { DiffViewer } from "./DiffViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { useDocumentStore, type OpenItem } from "./documentStore";

const TAB_DND_MIME = "application/x-anchor-tab-index";

export function DocumentArea() {
  const openItems = useDocumentStore((s) => s.openItems);
  const activeId = useDocumentStore((s) => s.activeId);
  const setActive = useDocumentStore((s) => s.setActive);
  const closeItem = useDocumentStore((s) => s.closeItem);
  const reorderTabs = useDocumentStore((s) => s.reorderTabs);
  const setMdViewMode = useDocumentStore((s) => s.setMdViewMode);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const active = openItems.find((i) => i.id === activeId) ?? openItems[0] ?? null;

  const onDragStart = useCallback(
    (index: number, e: DragEvent<HTMLDivElement>) => {
      setDragFrom(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_DND_MIME, String(index));
      // Fallback for environments that strip custom MIME types
      e.dataTransfer.setData("text/plain", String(index));
    },
    [],
  );

  const onDragOver = useCallback(
    (index: number, e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOver !== index) setDragOver(index);
    },
    [dragOver],
  );

  const onDrop = useCallback(
    (toIndex: number, e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const raw =
        e.dataTransfer.getData(TAB_DND_MIME) ||
        e.dataTransfer.getData("text/plain");
      const fromIndex = Number.parseInt(raw, 10);
      setDragFrom(null);
      setDragOver(null);
      if (Number.isNaN(fromIndex)) return;
      reorderTabs(fromIndex, toIndex);
    },
    [reorderTabs],
  );

  const onDragEnd = useCallback(() => {
    setDragFrom(null);
    setDragOver(null);
  }, []);

  return (
    <section className="document-area">
      <div className="tabs" role="tablist" aria-label="Open items">
        {openItems.map((item, index) => {
          const isDragging = dragFrom === index;
          const isOver = dragOver === index && dragFrom !== null && dragFrom !== index;
          return (
            <div
              key={item.id}
              className={`tab${item.id === active?.id ? " is-active" : ""}${
                isDragging ? " is-dragging" : ""
              }${isOver ? " is-drag-over" : ""}`}
              role="tab"
              aria-selected={item.id === active?.id}
              draggable
              onDragStart={(e) => onDragStart(index, e)}
              onDragOver={(e) => onDragOver(index, e)}
              onDrop={(e) => onDrop(index, e)}
              onDragEnd={onDragEnd}
              onClick={() => setActive(item.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActive(item.id);
                }
              }}
              tabIndex={0}
              title={itemTitle(item)}
            >
              <Icon name={tabIcon(item)} className="tab__icon" />
              <span className="tab__label" title={itemTitle(item)}>
                {item.title}
              </span>
              <button
                type="button"
                className="tab__close"
                aria-label={`Close ${item.title}`}
                draggable={false}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeItem(item.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="document-area__content document-area__content--fill">
        {/*
          Pane DOM order is sorted by id, not tab order. Reordering tabs must not
          move Monaco/DiffEditor containers in the tree — that leaves a blank view.
        */}
        {[...openItems]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((item) => {
            const isActive = item.id === active?.id;
            return (
              <div
                key={item.id}
                className={`document-area__pane${isActive ? " is-active" : ""}`}
                // Keep inactive tabs mounted so DiffViewer does not re-fetch on switch.
                hidden={!isActive}
                aria-hidden={!isActive}
              >
                <ActiveView
                  item={item}
                  onMdMode={(mode) => {
                    if (item.kind === "file") setMdViewMode(item.id, mode);
                  }}
                />
              </div>
            );
          })}
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
    return <DiffViewer item={item} />;
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
        revealLine={item.revealLine}
        focusCommentId={item.focusCommentId}
        revealNonce={item.revealNonce}
      />
    );
  }

  return (
    <CodeViewer
      path={item.path}
      content={item.content}
      language={item.language}
      truncated={item.truncated}
      revealLine={item.revealLine}
      focusCommentId={item.focusCommentId}
      revealNonce={item.revealNonce}
      kind="source"
    />
  );
}

function WelcomeView() {
  return (
    <article className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">Anchor Code</h1>
        <p className="welcome__slogan">Agent it. Review it. Feed it back.</p>
        <p className="welcome__lead">
          A human-in-the-loop reader for agent coding.
        </p>

        <ol className="welcome__steps">
          <li>
            <span className="welcome__step-n" aria-hidden>
              1
            </span>
            <span className="welcome__step-body">
              Open a workspace — files, code, and docs in one place.
            </span>
          </li>
          <li>
            <span className="welcome__step-n" aria-hidden>
              2
            </span>
            <span className="welcome__step-body">
              Review the change — History: pick commits and Compare.
            </span>
          </li>
          <li>
            <span className="welcome__step-n" aria-hidden>
              3
            </span>
            <span className="welcome__step-body">
              Leave feedback — select text and add comments.
            </span>
          </li>
          <li>
            <span className="welcome__step-n" aria-hidden>
              4
            </span>
            <span className="welcome__step-body">
              Close the loop — send the session path to your agent terminal.
            </span>
          </li>
        </ol>
      </div>
    </article>
  );
}

function tabIcon(item: OpenItem): CodiconName {
  if (item.kind === "welcome") return "home";
  if (item.kind === "diff") return "diff";
  if (item.kind === "file" && item.isMarkdown) return "markdown";
  if (item.kind === "file") {
    if (
      item.language === "typescript" ||
      item.language === "javascript" ||
      item.language === "json" ||
      item.language === "css" ||
      item.language === "html"
    ) {
      return "file-code";
    }
    return "file";
  }
  return "file";
}

function itemTitle(item: OpenItem): string {
  if (item.kind === "file") return item.relativePath || item.path;
  return item.title;
}
