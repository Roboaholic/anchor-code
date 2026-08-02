import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines, type Change } from "diff";
import { basename } from "./api";

type DiffMode = "inline" | "side";
type LineKind = "context" | "added" | "removed" | "changed" | "empty";

interface SideRow {
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  oldKind: LineKind;
  newKind: LineKind;
}

interface InlineRow {
  oldLine?: number;
  newLine?: number;
  text: string;
  kind: "context" | "added" | "removed";
}

interface DiffHunk {
  start: number;
  end: number;
  kind: "added" | "removed" | "mixed";
}

function groupHunks(kinds: Array<Array<"added" | "removed">>): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start = -1;
  let seen = new Set<"added" | "removed">();

  const finish = (end: number) => {
    if (start < 0) return;
    hunks.push({
      start,
      end,
      kind: seen.size > 1 ? "mixed" : seen.has("added") ? "added" : "removed",
    });
    start = -1;
    seen = new Set();
  };

  kinds.forEach((rowKinds, index) => {
    if (!rowKinds.length) {
      finish(index - 1);
      return;
    }
    if (start < 0) start = index;
    rowKinds.forEach((kind) => seen.add(kind));
  });
  finish(kinds.length - 1);
  return hunks;
}

function linesOf(change: Change): string[] {
  const lines = change.value.split("\n");
  if (change.value.endsWith("\n")) lines.pop();
  return lines;
}

function buildRows(oldText: string, newText: string): {
  side: SideRow[];
  inline: InlineRow[];
} {
  const changes = diffLines(oldText, newText);
  const side: SideRow[] = [];
  const inline: InlineRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  const unchanged = (change: Change) => {
    for (const text of linesOf(change)) {
      side.push({ oldLine, newLine, oldText: text, newText: text, oldKind: "context", newKind: "context" });
      inline.push({ oldLine, newLine, text, kind: "context" });
      oldLine += 1;
      newLine += 1;
    }
  };

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      unchanged(change);
      continue;
    }

    const next = changes[index + 1];
    const pair = change.removed && next?.added
      ? { removed: change, added: next }
      : change.added && next?.removed
        ? { removed: next, added: change }
        : null;
    if (pair) {
      const removed = linesOf(pair.removed);
      const added = linesOf(pair.added);
      for (const text of removed) {
        inline.push({ oldLine, text, kind: "removed" });
        oldLine += 1;
      }
      const firstNewLine = newLine;
      for (const text of added) {
        inline.push({ newLine, text, kind: "added" });
        newLine += 1;
      }
      const oldStart = oldLine - removed.length;
      for (let row = 0; row < Math.max(removed.length, added.length); row += 1) {
        side.push({
          oldLine: row < removed.length ? oldStart + row : undefined,
          newLine: row < added.length ? firstNewLine + row : undefined,
          oldText: removed[row],
          newText: added[row],
          oldKind: row < removed.length ? "changed" : "empty",
          newKind: row < added.length ? "changed" : "empty",
        });
      }
      index += 1;
      continue;
    }

    if (change.removed) {
      for (const text of linesOf(change)) {
        side.push({ oldLine, oldText: text, oldKind: "removed", newKind: "empty" });
        inline.push({ oldLine, text, kind: "removed" });
        oldLine += 1;
      }
    } else {
      for (const text of linesOf(change)) {
        side.push({ newLine, newText: text, oldKind: "empty", newKind: "added" });
        inline.push({ newLine, text, kind: "added" });
        newLine += 1;
      }
    }
  }
  return { side, inline };
}

export function DiffDocument({
  path,
  oldText,
  newText,
  onComment,
  allowSideBySide = true,
  allowComments = true,
}: {
  path: string;
  oldText: string;
  newText: string;
  allowSideBySide?: boolean;
  allowComments?: boolean;
  onComment: (selection: { start: number; end: number; text: string; before: string; after: string }) => void;
}) {
  const rows = useMemo(() => buildRows(oldText, newText), [oldText, newText]);
  const inlineHunks = useMemo(() => groupHunks(rows.inline.map((row) =>
    row.kind === "context" ? [] : [row.kind]
  )), [rows.inline]);
  const sideHunks = useMemo(() => groupHunks(rows.side.map((row) => {
    const kinds: Array<"added" | "removed"> = [];
    if (row.oldKind !== "context" && row.oldKind !== "empty") kinds.push("removed");
    if (row.newKind !== "context" && row.newKind !== "empty") kinds.push("added");
    return kinds;
  })), [rows.side]);
  const newLines = useMemo(() => newText.split("\n"), [newText]);
  const [mode, setMode] = useState<DiffMode>("inline");
  const [activeHunk, setActiveHunk] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const inlineScrollRef = useRef<HTMLDivElement>(null);
  const startLine = anchor === null ? null : Math.min(anchor, end ?? anchor);
  const endLine = anchor === null ? null : Math.max(anchor, end ?? anchor);
  const hunks = mode === "inline" ? inlineHunks : sideHunks;
  const rowCount = mode === "inline" ? rows.inline.length : rows.side.length;

  useEffect(() => {
    setActiveHunk(null);
    if (mode === "inline") inlineScrollRef.current?.scrollTo({ left: 0 });
  }, [mode, path]);

  const goToHunk = (index: number) => {
    if (!hunks.length) return;
    const nextIndex = (index + hunks.length) % hunks.length;
    const target = document.getElementById(`${mode}-diff-row-${hunks[nextIndex]!.start}`);
    if (target) {
      const targetRect = target.getBoundingClientRect();
      const top = window.scrollY + targetRect.top - window.innerHeight / 2 + targetRect.height / 2;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    if (mode === "inline") inlineScrollRef.current?.scrollTo({ left: 0 });
    setActiveHunk(nextIndex);
  };

  const moveHunk = (direction: "previous" | "next") => {
    if (!hunks.length) return;
    if (activeHunk === null) {
      goToHunk(direction === "next" ? 0 : hunks.length - 1);
      return;
    }
    goToHunk(activeHunk + (direction === "next" ? 1 : -1));
  };

  const select = (line?: number) => {
    if (!line) return;
    if (anchor === null || end !== null) {
      setAnchor(line);
      setEnd(null);
    } else {
      setEnd(line);
    }
  };
  const selected = (line?: number) => !!line && startLine !== null && endLine !== null && line >= startLine && line <= endLine;
  const comment = () => {
    if (startLine === null || endLine === null) return;
    onComment({
      start: startLine,
      end: endLine,
      text: newLines.slice(startLine - 1, endLine).join("\n"),
      before: newLines.slice(Math.max(0, startLine - 4), startLine - 1).join("\n"),
      after: newLines.slice(endLine, endLine + 3).join("\n"),
    });
  };

  return (
    <div className="document diff-document">
      <div className="document__toolbar diff-toolbar">
        <span className="document__name">{basename(path)}</span>
        <div className="segmented" aria-label="Diff layout">
          <button className={mode === "inline" ? "is-active" : ""} onClick={() => setMode("inline")}>Inline</button>
          {allowSideBySide ? <button className={mode === "side" ? "is-active" : ""} onClick={() => setMode("side")} title="Side by side">Side</button> : null}
        </div>
      </div>

      {mode === "inline" ? (
        <div className="inline-diff">
          <div className="inline-diff__gutter-column" aria-hidden>
            {rows.inline.map((row, index) => (
              <span
                key={`gutter-${row.kind}-${row.oldLine ?? ""}-${row.newLine ?? ""}-${index}`}
                className={`inline-diff__gutter-row is-${row.kind}${selected(row.newLine) ? " is-selected" : ""}`}
              >
                <span className="inline-diff__old">{row.oldLine ?? ""}</span>
                <span className="inline-diff__new">{row.newLine ?? ""}</span>
              </span>
            ))}
          </div>
          <div className="inline-diff__code-scroll" ref={inlineScrollRef}>
            {rows.inline.map((row, index) => {
              const canSelect = row.newLine !== undefined;
              return (
              <button
                id={`inline-diff-row-${index}`}
                key={`${row.kind}-${row.oldLine ?? ""}-${row.newLine ?? ""}-${index}`}
                className={`inline-diff__row is-${row.kind}${selected(row.newLine) ? " is-selected" : ""}`}
                disabled={!canSelect}
                onClick={() => {
                  const scrollLeft = inlineScrollRef.current?.scrollLeft ?? 0;
                  select(row.newLine);
                  window.requestAnimationFrame(() => inlineScrollRef.current?.scrollTo({ left: scrollLeft }));
                }}
              >
                <code>{row.text || " "}</code>
              </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="side-diff-scroll">
          <div className="side-diff">
            <div className="side-diff__head"><span>Before</span><span>After</span></div>
            {rows.side.map((row, index) => (
              <div id={`side-diff-row-${index}`} className="side-diff__row" key={`${row.oldLine ?? ""}-${row.newLine ?? ""}-${index}`}>
                <div className={`side-cell is-${row.oldKind}`}><span>{row.oldLine ?? ""}</span><code>{row.oldText ?? " "}</code></div>
                <button className={`side-cell is-${row.newKind}${selected(row.newLine) ? " is-selected" : ""}`} disabled={!row.newLine} onClick={() => select(row.newLine)}><span>{row.newLine ?? ""}</span><code>{row.newText ?? " "}</code></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hunks.length ? (
        <>
          <nav className="diff-overview" aria-label="Diff overview">
            <div className="diff-overview__track">
              {hunks.map((hunk, index) => (
                <button
                  type="button"
                  key={`${hunk.start}-${hunk.end}`}
                  className={`diff-overview__marker is-${hunk.kind}${activeHunk === index ? " is-active" : ""}`}
                  style={{
                    top: `${(hunk.start / Math.max(1, rowCount)) * 100}%`,
                    height: `max(4px, ${((hunk.end - hunk.start + 1) / Math.max(1, rowCount)) * 100}%)`,
                  }}
                  onClick={() => goToHunk(index)}
                  title={`Diff ${index + 1} of ${hunks.length}`}
                  aria-label={`Go to diff ${index + 1} of ${hunks.length}`}
                />
              ))}
            </div>
          </nav>
          <div className={`diff-hunk-fab${startLine !== null ? " is-raised" : ""}`} role="group" aria-label="Diff navigation">
            <button type="button" onClick={() => moveHunk("previous")} title="Previous diff" aria-label="Previous diff">↑</button>
            <button type="button" onClick={() => moveHunk("next")} title="Next diff" aria-label="Next diff">↓</button>
          </div>
        </>
      ) : null}

      {allowComments && startLine !== null ? <div className="selection-bar"><span>{endLine === startLine ? `新版本第 ${startLine} 行` : `新版本第 ${startLine}–${endLine ?? startLine} 行`}</span><button onClick={comment}>添加评论</button></div> : null}
    </div>
  );
}
