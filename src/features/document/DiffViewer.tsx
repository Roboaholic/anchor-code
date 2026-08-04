import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  buildDiffCommentPrefix,
  shortRev,
} from "@/core/history/diffComment";
import { joinPath, languageFromPath } from "@/core/workspace/paths";
import { addCommentFromSelection } from "@/features/shell/orchestrate";
import { CommentBubble } from "@/features/annotations/CommentBubble";
import {
  overlapRegionsForModel,
  useAnnotationsStore,
  visualDecorationSpec,
  type DecorationSpec,
} from "@/features/annotations/annotationsStore";
import type { OpenItem } from "./documentStore";
import { useDocumentStore } from "./documentStore";
import {
  loadFileDiff,
  peekFileDiff,
  prefetchFileDiff,
} from "./fileDiffCache";
import { useThemeStore } from "@/features/shell/themeStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  accentHex,
  EDITOR_FONT_FAMILY,
  editorLineHeight,
  monacoThemeId,
} from "@/core/theme/theme";
import type { BlameLine, CommentRecord } from "@/shared/anchor-api";
import { Icon } from "@/shared/Icon";
import { fitBlameText } from "./blameDisplay";
import "./monacoSetup";

type DiffItem = Extract<OpenItem, { kind: "diff" }>;

type ComposerState = {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  lineText: string;
  forceNewSession: boolean;
};

const DIFF_FILES_WIDTH_STORAGE_KEY = "anchor.diffFilesWidth";
const DIFF_FILES_MIN_WIDTH = 160;
const DIFF_FILES_MAX_WIDTH = 480;
const DIFF_FILES_DEFAULT_WIDTH = 220;

export function formatDiffBlameTime(dateIso: string, nowMs = Date.now()): string {
  const timestamp = Date.parse(dateIso);
  if (!Number.isFinite(timestamp)) return "unknown time";
  const elapsed = Math.max(0, nowMs - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const year = 365 * day;
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < year) return `${Math.floor(elapsed / day)}d ago`;
  return `${Math.floor(elapsed / year)}y ago`;
}

function loadDiffFilesWidth(): number {
  try {
    const raw = Number.parseInt(
      localStorage.getItem(DIFF_FILES_WIDTH_STORAGE_KEY) ?? "",
      10,
    );
    if (Number.isFinite(raw)) {
      return Math.min(DIFF_FILES_MAX_WIDTH, Math.max(DIFF_FILES_MIN_WIDTH, raw));
    }
  } catch {
    // ignore
  }
  return DIFF_FILES_DEFAULT_WIDTH;
}

function persistDiffFilesWidth(width: number): void {
  try {
    localStorage.setItem(DIFF_FILES_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // ignore
  }
}

type BubbleState = {
  commentId: string;
  /** Every annotation thread hit at the same source position. */
  relatedCommentIds: string[];
  left: number;
  top: number;
};

type SelectionToolbarState = {
  left: number;
  top: number;
};

const HOVER_OPEN_MS = 420;
const HOVER_CLOSE_MS = 220;

/**
 * Map a decoration anchor to overlay-local coords.
 * Monaco's getScrolledVisiblePosition is relative to the *modified* editor,
 * not the full DiffEditor shell — in side-by-side that editor sits on the right,
 * so we must add its offset within the overlay or the bubble lands on the left pane.
 */
function positionForSpec(
  ed: MonacoEditor.IStandaloneCodeEditor,
  spec: DecorationSpec,
  overlay: HTMLElement,
): { left: number; top: number } | null {
  const pos = ed.getScrolledVisiblePosition({
    lineNumber: spec.startLine,
    column: Math.max(1, spec.startColumn || 1),
  });
  if (!pos) return null;
  const edDom = ed.getDomNode();
  if (!edDom) return null;
  const edRect = edDom.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const rawLeft = edRect.left - overlayRect.left + pos.left + 12;
  const rawTop = edRect.top - overlayRect.top + pos.top + pos.height + 6;
  const left = Math.min(
    Math.max(8, rawLeft),
    Math.max(8, overlay.clientWidth - 320),
  );
  const top = Math.max(8, rawTop);
  return { left, top };
}

/** Top-right of the selection block → overlay-local coords for the add-comment chip. */
function positionForSelectionTopRight(
  ed: MonacoEditor.IStandaloneCodeEditor,
  sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  overlay: HTMLElement,
): { left: number; top: number } | null {
  const model = ed.getModel();
  if (!model) return null;
  const startLine = Math.min(sel.startLineNumber, sel.endLineNumber);
  const endLine = Math.max(sel.startLineNumber, sel.endLineNumber);
  const forward =
    sel.startLineNumber < sel.endLineNumber ||
    (sel.startLineNumber === sel.endLineNumber &&
      sel.startColumn <= sel.endColumn);
  const startCol = forward ? sel.startColumn : sel.endColumn;
  const endCol = forward ? sel.endColumn : sel.startColumn;
  const colOnFirst =
    startLine === endLine
      ? Math.max(startCol, endCol)
      : model.getLineMaxColumn(startLine);
  const pos = ed.getScrolledVisiblePosition({
    lineNumber: startLine,
    column: colOnFirst,
  });
  if (!pos) return null;
  const edDom = ed.getDomNode();
  if (!edDom) return null;
  const edRect = edDom.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const iconSize = 28;
  const rawLeft = edRect.left - overlayRect.left + pos.left + 2;
  const rawTop = edRect.top - overlayRect.top + pos.top - iconSize - 4;
  const left = Math.min(
    Math.max(4, rawLeft),
    Math.max(4, overlay.clientWidth - iconSize - 4),
  );
  const top = Math.max(4, rawTop);
  return { left, top };
}

function findSpecsAt(
  specs: DecorationSpec[],
  line: number,
  column: number,
): DecorationSpec[] {
  const hits: Array<{ spec: DecorationSpec; span: number }> = [];
  for (const s of specs) {
    // Include unresolved: reopened diffs may only have stored coords until
    // relocate succeeds, but the user should still open the bubble.
    if (line < s.startLine || line > s.endLine) continue;
    const startCol = Math.max(1, s.startColumn || 1);
    const endCol = Math.max(startCol, s.endColumn || 1);
    if (s.startLine === s.endLine) {
      if (column < startCol || column > endCol + 1) continue;
    } else {
      if (line === s.startLine && column < startCol) continue;
      if (line === s.endLine && column > endCol + 1) continue;
    }
    hits.push({
      spec: s,
      span: (s.endLine - s.startLine) * 1000 + endCol - startCol,
    });
  }
  return hits.sort((a, b) => a.span - b.span).map((hit) => hit.spec);
}

export function DiffViewer({ item }: { item: DiffItem }) {
  const theme = useThemeStore((s) => s.theme);
  const fontSize = useThemeStore((s) => s.fontSize);
  const lineHeight = editorLineHeight(fontSize);
  const setDiffActiveFile = useDocumentStore((s) => s.setDiffActiveFile);
  const decorationsFor = useAnnotationsStore((s) => s.decorationsFor);
  const activeSession = useAnnotationsStore((s) => s.activeSession);
  const expandedSessionId = useAnnotationsStore((s) => s.expandedSessionId);
  const sessions = useAnnotationsStore((s) => s.sessions);
  const loadForRepo = useAnnotationsStore((s) => s.loadForRepo);
  const activePath = item.activeFilePath;
  const activeMeta = item.files.find((f) => f.path === activePath);
  const absActivePath = activePath
    ? joinPath(item.repoRoot, activePath)
    : null;
  const [oldText, setOldText] = useState("");
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  /** Changed-files rail: open by default; user can collapse for more editor space. */
  const [filesOpen, setFilesOpen] = useState(true);
  const [filesWidth, setFilesWidth] = useState(loadDiffFilesWidth);
  const [resizingFiles, setResizingFiles] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [selToolbar, setSelToolbar] = useState<SelectionToolbarState | null>(
    null,
  );
  const [oldBlameLines, setOldBlameLines] = useState<BlameLine[]>([]);
  const [newBlameLines, setNewBlameLines] = useState<BlameLine[]>([]);
  const [activeBlame, setActiveBlame] = useState<{
    side: "old" | "new";
    line: number;
  } | null>(null);
  const originalEditorRef =
    useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const modifiedEditorRef =
    useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const oldBlameDecorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const newBlameDecorationsRef =
    useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  /** Editor instance that owns decorationsRef (must recreate after remount). */
  const decorationsEditorRef =
    useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef =
    useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const activeDiffIndexRef = useRef<number | null>(null);
  const pendingDiffDirectionRef = useRef<"previous" | "next" | null>(null);
  const goToDiffRef = useRef<(direction: "previous" | "next") => void>(() => {});
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const specsRef = useRef<DecorationSpec[]>([]);
  const bubbleRef = useRef<BubbleState | null>(null);
  const applyDecorationsRef = useRef<(id?: string | null) => void>(() => {});
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const pointerOverBubbleRef = useRef(false);
  const pointerOverAnnoRef = useRef(false);
  const mouseDownRef = useRef(false);
  const composerOpenRef = useRef(false);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const filesResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  bubbleRef.current = bubble;
  composerOpenRef.current = Boolean(composer);

  useEffect(() => {
    if (!composer) return;
    const id = window.requestAnimationFrame(() => {
      composerInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [composer]);


  useEffect(() => {
    if (!activePath || !activeMeta) {
      setOldText("");
      setNewText("");
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const status = activeMeta.status;
    const req = {
      repoRoot: item.repoRoot,
      base: item.base,
      head: item.head,
      path: activePath,
      status,
    };
    const cached = peekFileDiff(req);
    if (cached) {
      setOldText(cached.oldText);
      setNewText(cached.newText);
      setLoading(false);
      setError(null);
      setComposer(null);
    } else {
      setLoading(true);
      setError(null);
      setComposer(null);
      void loadFileDiff(req)
        .then((res) => {
          if (cancelled) return;
          setOldText(res.oldText);
          setNewText(res.newText);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }

    // Native Windows process startup is relatively expensive. Warm only the
    // next file so speculative git reads cannot delay the active request.
    const idx = item.files.findIndex((f) => f.path === activePath);
    const next = item.files[idx + 1];
    if (next) {
      prefetchFileDiff({
        repoRoot: item.repoRoot,
        base: item.base,
        head: item.head,
        path: next.path,
        status: next.status,
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    activePath,
    activeMeta?.status,
    item.repoRoot,
    item.base,
    item.head,
    item.files,
  ]);

  // Sessions are anchored to the workspace root (cross-repo comments), so ensure
  // they are loaded when opening a compare (reopen must repaint anchors from
  // YAML/cache). item.repoRoot is still used for the diff/blame git operations.
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  useEffect(() => {
    if (!workspaceRoot) return;
    const current = useAnnotationsStore.getState().repoRoot;
    if (current !== workspaceRoot || useAnnotationsStore.getState().sessions.length === 0) {
      void loadForRepo(workspaceRoot);
    }
  }, [workspaceRoot, loadForRepo]);

  // Monaco DiffEditor does not always re-apply layout options from React props.
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  const goToDiff = useCallback((direction: "previous" | "next") => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges();
    if (!changes?.length) {
      pendingDiffDirectionRef.current = direction;
      return;
    }
    pendingDiffDirectionRef.current = null;

    const current = activeDiffIndexRef.current;
    const nextIndex =
      current === null
        ? direction === "next"
          ? 0
          : changes.length - 1
        : direction === "next"
          ? (current + 1) % changes.length
          : (current - 1 + changes.length) % changes.length;
    const change = changes[nextIndex]!;
    activeDiffIndexRef.current = nextIndex;

    const original = editor.getOriginalEditor();
    const modified = editor.getModifiedEditor();
    const originalLine = Math.max(1, change.originalStartLineNumber);
    const modifiedLine = Math.max(1, change.modifiedStartLineNumber);
    original.setPosition({ lineNumber: originalLine, column: 1 });
    modified.setPosition({ lineNumber: modifiedLine, column: 1 });
    original.revealLineInCenter(originalLine);
    modified.revealLineInCenter(modifiedLine);
    modified.focus();
  }, []);
  goToDiffRef.current = goToDiff;

  useEffect(() => {
    if (!resizingFiles) return;
    const onPointerMove = (e: PointerEvent) => {
      const start = filesResizeStartRef.current;
      if (!start) return;
      const width = Math.min(
        DIFF_FILES_MAX_WIDTH,
        Math.max(DIFF_FILES_MIN_WIDTH, start.width + e.clientX - start.x),
      );
      setFilesWidth(width);
      diffEditorRef.current?.layout();
    };
    const onPointerUp = () => {
      filesResizeStartRef.current = null;
      setResizingFiles(false);
      persistDiffFilesWidth(filesWidth);
      diffEditorRef.current?.layout();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [filesWidth, resizingFiles]);

  useEffect(() => {
    const diff = diffEditorRef.current;
    if (!diff) return;
    const opts = { fontSize, lineHeight };
    diff.updateOptions(opts);
    diff.getOriginalEditor().updateOptions(opts);
    diff.getModifiedEditor().updateOptions(opts);
  }, [fontSize, lineHeight]);
  const rangeLabel = useMemo(() => {
    const base = shortRev(item.base);
    const head = item.head === "worktree" ? "worktree" : shortRev(item.head);
    const branch = item.branch ? `${item.branch} · ` : "";
    return `${branch}${base} → ${head}`;
  }, [item.base, item.branch, item.head]);

  useEffect(() => {
    let cancelled = false;
    setOldBlameLines([]);
    setNewBlameLines([]);
    setActiveBlame(null);
    if (!activePath) return;
    const filePath = joinPath(item.repoRoot, activePath);
    const requests: Promise<void>[] = [];
    if (activeMeta?.status !== "?" && !activeMeta?.status.startsWith("A")) {
      requests.push(
        window.anchor.history
          .fileBlame({ repoRoot: item.repoRoot, filePath, revision: item.base })
          .then((lines) => {
            if (!cancelled) setOldBlameLines(lines);
          }),
      );
    }
    if (!activeMeta?.status.startsWith("D")) {
      requests.push(
        window.anchor.history
          .fileBlame({ repoRoot: item.repoRoot, filePath, revision: item.head })
          .then((lines) => {
            if (!cancelled) setNewBlameLines(lines);
          }),
      );
    }
    void Promise.all(requests).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeMeta?.status, activePath, item.base, item.head, item.repoRoot]);

  const paintBlame = useCallback(() => {
    const oldEditor = originalEditorRef.current;
    const newEditor = modifiedEditorRef.current;
    const oldModel = oldEditor?.getModel();
    const newModel = newEditor?.getModel();
    if (!oldEditor || !newEditor || !oldModel || !newModel) return;
    if (!oldBlameDecorationsRef.current) {
      oldBlameDecorationsRef.current = oldEditor.createDecorationsCollection();
    }
    if (!newBlameDecorationsRef.current) {
      newBlameDecorationsRef.current = newEditor.createDecorationsCollection();
    }
    oldBlameDecorationsRef.current.clear();
    newBlameDecorationsRef.current.clear();
    if (!activeBlame) return;

    const editor = activeBlame.side === "old" ? oldEditor : newEditor;
    const model = activeBlame.side === "old" ? oldModel : newModel;
    const collection =
      activeBlame.side === "old"
        ? oldBlameDecorationsRef.current
        : newBlameDecorationsRef.current;
    const lines = activeBlame.side === "old" ? oldBlameLines : newBlameLines;
    const entry = lines.find((line) => line.line === activeBlame.line);
    if (!entry || entry.line > model.getLineCount()) return;
    const content = fitBlameText(
      editor,
      entry.line,
      `${entry.author} · ${formatDiffBlameTime(entry.dateIso)} · ${entry.subject || "No commit message"}`,
      fontSize,
    );
    if (!content) return;
    collection.set([
      {
        range: {
          startLineNumber: entry.line,
          startColumn: model.getLineMaxColumn(entry.line),
          endLineNumber: entry.line,
          endColumn: model.getLineMaxColumn(entry.line),
        },
        options: {
          showIfCollapsed: true,
          after: {
            content,
            inlineClassName: "git-blame-inline",
          },
        },
      },
    ]);
    editor.revealLine(entry.line);
  }, [activeBlame, fontSize, newBlameLines, oldBlameLines]);

  useEffect(() => {
    paintBlame();
  }, [paintBlame]);


  const clearHoverOpenTimer = () => {
    if (hoverOpenTimerRef.current != null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
  };

  const clearHoverCloseTimer = () => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const openComposer = (
    ed: MonacoEditor.IStandaloneCodeEditor,
    forceNewSession = false,
  ) => {
    // Comments only make sense in side-by-side (clear newer column).
    if (!sideBySide) return;
    const sel = ed.getSelection();
    const model = ed.getModel();
    if (!sel || !model || sel.isEmpty()) return;
    const selectedText = model.getValueInRange(sel);
    const startLine = sel.startLineNumber;
    const endLine = sel.endLineNumber;
    const beforeContext =
      startLine > 1 ? model.getLineContent(startLine - 1) : "";
    const afterContext =
      endLine < model.getLineCount() ? model.getLineContent(endLine + 1) : "";
    const lineText = model.getLineContent(startLine);
    clearHoverOpenTimer();
    bubbleRef.current = null;
    setBubble(null);
    setSelToolbar(null);
    setComposer({
      startLine,
      endLine,
      startColumn: sel.startColumn,
      endColumn: sel.endColumn,
      selectedText,
      beforeContext,
      afterContext,
      lineText,
      forceNewSession,
    });
    setBody("");
  };

  const liveComment = (id: string): CommentRecord | null => {
    const state = useAnnotationsStore.getState();
    for (const session of state.sessions) {
      const found = session.comments.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  };

  const applyDecorations = useCallback(
    (activeCommentId?: string | null) => {
      const ed = modifiedEditorRef.current;
      if (!ed || !absActivePath || !sideBySide) return;
      const model = ed.getModel();
      // DiffEditor often mounts before the modified model is filled (or swaps
      // models after onDidUpdateDiff). Resolving against `newText` but painting
      // an empty/stale model drops ranges — wait until model matches.
      if (!model) return;
      // Empty model while we already have newer-side text → wait for DiffEditor
      // to push content (onDidUpdateDiff / model listeners will repaint).
      if (newText.length > 0 && model.getValueLength() === 0) return;

      const specs = decorationsFor(absActivePath, newText);
      const visualSpecs = specs.map((spec) =>
        visualDecorationSpec(spec, (line) => model.getLineMaxColumn(line)),
      );
      specsRef.current = visualSpecs;
      const activeId =
        activeCommentId !== undefined
          ? activeCommentId
          : bubbleRef.current?.commentId ?? null;
      // Prefer resolved/relocated; fall back to stored coords for unresolved so
      // reopened diffs still show attachment while content is slightly off.
      const paintable = visualSpecs.filter(
        (s) =>
          s.anchorStatus === "resolved" ||
          s.anchorStatus === "relocated" ||
          s.anchorStatus === "unresolved",
      );
      const decorations: MonacoEditor.IModelDeltaDecoration[] = paintable.map(
        (s) => {
          const selected = activeId === s.commentId;
          const unresolved = s.anchorStatus === "unresolved";
          return {
            range: {
              startLineNumber: s.startLine,
              startColumn: Math.max(1, s.startColumn || 1),
              endLineNumber: s.endLine,
              endColumn: Math.max(1, s.endColumn || 1),
            },
            options: {
              inlineClassName: `anno-inline${selected ? " anno-inline--active" : ""}${
                unresolved ? " anno-inline--unresolved" : ""
              }`,
              overviewRuler: {
                color: accentHex(theme),
                position: 4,
              },
              minimap: {
                color: accentHex(theme),
                position: 1,
              },
            },
          };
        },
      );
      decorations.push(
        ...overlapRegionsForModel(visualSpecs, (line) =>
          model.getLineMaxColumn(line),
        ).map((region) => ({
          range: {
            startLineNumber: region.startLine,
            startColumn: region.startColumn,
            endLineNumber: region.endLine,
            endColumn: region.endColumn,
          },
          options: {
            inlineClassName: `anno-inline-intersection anno-inline-intersection--${Math.min(3, region.depth)}`,
          },
        })),
      );
      if (
        !decorationsRef.current ||
        decorationsEditorRef.current !== ed
      ) {
        decorationsRef.current?.clear();
        decorationsRef.current = ed.createDecorationsCollection();
        decorationsEditorRef.current = ed;
      }
      decorationsRef.current.set(decorations);

      const open = bubbleRef.current;
      if (!open) return;
      const still = visualSpecs.find((s) => s.commentId === open.commentId);
      if (!still) {
        bubbleRef.current = null;
        setBubble(null);
        return;
      }
      const overlay = overlayRef.current;
      if (!overlay) return;
      const pos = positionForSpec(ed, still, overlay);
      if (pos) {
        const next = {
          commentId: open.commentId,
          relatedCommentIds: open.relatedCommentIds ?? [],
          ...pos,
        };
        bubbleRef.current = next;
        setBubble(next);
      }
    },
    [absActivePath, decorationsFor, newText, sideBySide, theme],
  );
  applyDecorationsRef.current = applyDecorations;

  useEffect(() => {
    applyDecorations();
  }, [
    applyDecorations,
    activeSession,
    expandedSessionId,
    sessions,
    newText,
    activePath,
  ]);

  // Wait for the bubble state to commit, then repaint Monaco decorations.
  // This avoids losing them during the editor's mouse-selection pass.
  useEffect(() => {
    applyDecorations(bubble?.commentId ?? null);
  }, [applyDecorations, bubble?.commentId]);

  const openBubbleForSpecs = useCallback(
    (hits: DecorationSpec[]) => {
      const ed = modifiedEditorRef.current;
      const overlay = overlayRef.current;
      if (!ed || !overlay || hits.length === 0) return;
      const primary = hits[0]!;
      const pos = positionForSpec(ed, primary, overlay);
      if (!pos) return;
      setComposer(null);
      setSelToolbar(null);
      const next = {
        commentId: primary.commentId,
        relatedCommentIds: hits.slice(1).map((h) => h.commentId),
        ...pos,
      };
      bubbleRef.current = next;
      setBubble(next);
      applyDecorations(primary.commentId);
    },
    [applyDecorations],
  );

  const closeBubble = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    pointerOverAnnoRef.current = false;
    pointerOverBubbleRef.current = false;
    bubbleRef.current = null;
    setBubble(null);
    requestAnimationFrame(() => applyDecorations(null));
  }, [applyDecorations]);

  const scheduleHoverClose = useCallback(() => {
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      if (pointerOverBubbleRef.current || pointerOverAnnoRef.current) return;
      closeBubble();
    }, HOVER_CLOSE_MS);
  }, [closeBubble]);

  const updateSelectionToolbar = useCallback(() => {
    const ed = modifiedEditorRef.current;
    const overlay = overlayRef.current;
    // Only show after selection finishes — never while the mouse is still dragging.
    if (
      !ed ||
      !overlay ||
      composerOpenRef.current ||
      !sideBySide ||
      mouseDownRef.current
    ) {
      setSelToolbar(null);
      return;
    }
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) {
      setSelToolbar(null);
      return;
    }
    const pos = positionForSelectionTopRight(ed, sel, overlay);
    setSelToolbar(pos);
  }, [sideBySide]);

  /** End a mouse-drag selection and show the chip after Monaco commits the range. */
  const finishMouseSelection = useCallback(() => {
    if (!mouseDownRef.current) return;
    mouseDownRef.current = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateSelectionToolbarRef.current();
      });
    });
  }, []);

  const openBubbleForSpecsRef = useRef(openBubbleForSpecs);
  openBubbleForSpecsRef.current = openBubbleForSpecs;
  const scheduleHoverCloseRef = useRef(scheduleHoverClose);
  scheduleHoverCloseRef.current = scheduleHoverClose;
  const updateSelectionToolbarRef = useRef(updateSelectionToolbar);
  updateSelectionToolbarRef.current = updateSelectionToolbar;
  const finishMouseSelectionRef = useRef(finishMouseSelection);
  finishMouseSelectionRef.current = finishMouseSelection;
  const openComposerRef = useRef(openComposer);
  openComposerRef.current = openComposer;

  const onDiffMount: DiffOnMount = (editor) => {
    for (const d of disposablesRef.current) d.dispose();
    disposablesRef.current = [];
    clearHoverOpenTimer();
    clearHoverCloseTimer();

    diffEditorRef.current = editor;
    activeDiffIndexRef.current = null;
    pendingDiffDirectionRef.current = null;
    editor.updateOptions({ renderSideBySide: sideBySide });

    const original = editor.getOriginalEditor();
    const modified = editor.getModifiedEditor();
    originalEditorRef.current = original;
    modifiedEditorRef.current = modified;
    decorationsRef.current?.clear();
    decorationsRef.current = modified.createDecorationsCollection();
    decorationsEditorRef.current = modified;
    oldBlameDecorationsRef.current?.clear();
    oldBlameDecorationsRef.current = original.createDecorationsCollection();
    newBlameDecorationsRef.current?.clear();
    newBlameDecorationsRef.current = modified.createDecorationsCollection();

    const repaint = () => {
      applyDecorationsRef.current(bubbleRef.current?.commentId ?? null);
      paintBlame();
      const pendingDirection = pendingDiffDirectionRef.current;
      if (pendingDirection) goToDiffRef.current(pendingDirection);
    };

    disposablesRef.current.push(editor.onDidUpdateDiff(repaint));
    disposablesRef.current.push(original.onDidChangeModel(repaint));
    disposablesRef.current.push(modified.onDidChangeModel(repaint));
    disposablesRef.current.push(modified.onDidChangeModelContent(repaint));
    disposablesRef.current.push(
      original.onMouseDown((e) => {
        const line = e.target.position?.lineNumber;
        setActiveBlame(line ? { side: "old", line } : null);
      }),
    );

    // Only register comment actions in side-by-side mode (newer column).
    if (!sideBySide) {
      setSelToolbar(null);
      repaint();
      requestAnimationFrame(repaint);
      return;
    }


    // Hover dwell on annotation → open bubble (not click).
    disposablesRef.current.push(
      modified.onMouseDown((e) => {
        const line = e.target.position?.lineNumber;
        setActiveBlame(line ? { side: "new", line } : null);
        if (e.event.leftButton === true) {
          mouseDownRef.current = true;
          clearHoverOpenTimer();
          // Hide chip immediately when a new drag starts.
          setSelToolbar(null);
          // New click / reselect while comment bar is open → dismiss bar.
          if (composerOpenRef.current) {
            setComposer(null);
            setBody("");
          }
        }
      }),
    );
    // Capture-phase pointer/mouse up so we always end the drag even if
    // release is outside the editor (Monaco often skips onMouseUp then).
    const onGlobalPointerUp = () => {
      finishMouseSelectionRef.current();
    };
    window.addEventListener("pointerup", onGlobalPointerUp, true);
    window.addEventListener("mouseup", onGlobalPointerUp, true);
    window.addEventListener("blur", onGlobalPointerUp);
    disposablesRef.current.push({
      dispose: () => {
        window.removeEventListener("pointerup", onGlobalPointerUp, true);
        window.removeEventListener("mouseup", onGlobalPointerUp, true);
        window.removeEventListener("blur", onGlobalPointerUp);
      },
    });
    disposablesRef.current.push(
      modified.onMouseLeave(() => {
        pointerOverAnnoRef.current = false;
        clearHoverOpenTimer();
        scheduleHoverCloseRef.current();
      }),
    );
    disposablesRef.current.push(
      modified.onMouseMove((e) => {
        if (mouseDownRef.current || composerOpenRef.current) return;
        if (!e.target.position) {
          if (pointerOverAnnoRef.current) {
            pointerOverAnnoRef.current = false;
            clearHoverOpenTimer();
            scheduleHoverCloseRef.current();
          }
          return;
        }
        const hits = findSpecsAt(
          specsRef.current,
          e.target.position.lineNumber,
          e.target.position.column,
        );
        if (hits.length === 0) {
          if (pointerOverAnnoRef.current) {
            pointerOverAnnoRef.current = false;
            clearHoverOpenTimer();
            scheduleHoverCloseRef.current();
          }
          return;
        }
        pointerOverAnnoRef.current = true;
        clearHoverCloseTimer();
        const primaryId = hits[0]!.commentId;
        if (bubbleRef.current?.commentId === primaryId) return;
        clearHoverOpenTimer();
        hoverOpenTimerRef.current = window.setTimeout(() => {
          openBubbleForSpecsRef.current(hits);
        }, HOVER_OPEN_MS);
      }),
    );

    disposablesRef.current.push(
      modified.onDidChangeCursorSelection(() => {
        if (mouseDownRef.current) {
          setSelToolbar(null);
          return;
        }
        updateSelectionToolbarRef.current();
      }),
    );
    disposablesRef.current.push(
      modified.onDidScrollChange(() => {
        updateSelectionToolbarRef.current();
        const open = bubbleRef.current;
        if (!open) return;
        const spec = specsRef.current.find(
          (s) => s.commentId === open.commentId,
        );
        if (!spec) {
          bubbleRef.current = null;
          setBubble(null);
          return;
        }
        const overlay = overlayRef.current;
        if (!overlay) return;
        const pos = positionForSpec(modified, spec, overlay);
        if (pos) {
          const next = {
            commentId: open.commentId,
            relatedCommentIds: open.relatedCommentIds ?? [],
            ...pos,
          };
          bubbleRef.current = next;
          setBubble(next);
        }
      }),
    );

    repaint();
    // Second pass after Monaco finishes first layout/diff computation.
    requestAnimationFrame(repaint);
    window.setTimeout(repaint, 50);
  };

  useEffect(() => {
    // Drop open composer when leaving side-by-side.
    if (!sideBySide) {
      setComposer(null);
      setBubble(null);
      setSelToolbar(null);
    }
  }, [sideBySide]);

  useEffect(() => {
    return () => {
      clearHoverOpenTimer();
      clearHoverCloseTimer();
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      oldBlameDecorationsRef.current?.clear();
      oldBlameDecorationsRef.current = null;
      newBlameDecorationsRef.current?.clear();
      newBlameDecorationsRef.current = null;
      decorationsEditorRef.current = null;
      diffEditorRef.current = null;
      originalEditorRef.current = null;
      modifiedEditorRef.current = null;
    };
  }, []);

  const submit = async (forceNewSession = composer?.forceNewSession ?? false) => {
    if (!composer || !body.trim() || !activePath || !sideBySide) return;
    setSaving(true);
    try {
      const abs = joinPath(item.repoRoot, activePath);
      const prefix = buildDiffCommentPrefix({
        branch: item.branch,
        base: item.base,
        head: item.head,
        filePath: activePath,
        startLine: composer.startLine,
        endLine: composer.endLine,
      });
      await addCommentFromSelection({
        filePath: abs,
        kind: "source",
        startLine: composer.startLine,
        endLine: composer.endLine,
        startColumn: composer.startColumn,
        endColumn: composer.endColumn,
        selectedText: composer.selectedText,
        beforeContext: composer.beforeContext,
        afterContext: composer.afterContext,
        lineText: composer.lineText,
        body: `${prefix}${body.trim()}`,
        forceNewSession,
      });
      setComposer(null);
      setBody("");
      requestAnimationFrame(() => applyDecorations());
    } finally {
      setSaving(false);
    }
  };

  const bubbleComment = bubble ? liveComment(bubble.commentId) : null;
  const relatedBubbleComments = bubble
    ? bubble.relatedCommentIds
        .map((id) => liveComment(id))
        .filter((c): c is CommentRecord => Boolean(c))
    : [];

  const showFilesRail = !item.hideFileList;

  return (
    <div
      className={`diff-viewer${item.hideFileList ? " diff-viewer--focus" : ""}${
        showFilesRail && !filesOpen ? " diff-viewer--files-collapsed" : ""
      }${resizingFiles ? " diff-viewer--files-resizing" : ""}`}
    >
      {showFilesRail && filesOpen ? (
        <aside className="diff-viewer__files" style={{ width: filesWidth }}>
          <div className="diff-viewer__files-head">
            <div className="diff-viewer__range" title={item.title}>
              {item.title}
            </div>
            <button
              type="button"
              className="icon-btn diff-viewer__files-toggle"
              title="Hide changed files"
              aria-label="Hide changed files"
              aria-expanded={true}
              onClick={() => setFilesOpen(false)}
            >
              <Icon name="layout-sidebar-left" />
            </button>
          </div>
          <div className="diff-viewer__meta" title={rangeLabel}>
            {rangeLabel}
          </div>
          <div className="files-pane__title">
            CHANGED FILES · {item.files.length}
          </div>
          {item.files.length === 0 ? (
            <p className="pane-hint">No file changes in this compare.</p>
          ) : (
            <ul className="diff-file-list">
              {item.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className={`diff-file-list__row${
                      f.path === activePath ? " is-selected" : ""
                    }`}
                    onClick={() => setDiffActiveFile(item.id, f.path)}
                  >
                    <span
                      className={`diff-file-list__status status-${f.status[0] ?? "M"}`}
                    >
                      {f.status[0]}
                    </span>
                    <span className="diff-file-list__path" title={f.path}>
                      {f.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div
            className="diff-viewer__files-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize changed files panel"
            onPointerDown={(e) => {
              e.preventDefault();
              filesResizeStartRef.current = { x: e.clientX, width: filesWidth };
              setResizingFiles(true);
            }}
          />
        </aside>
      ) : null}

      {showFilesRail && !filesOpen ? (
        <div className="diff-viewer__files-rail">
          <button
            type="button"
            className="icon-btn diff-viewer__files-toggle"
            title={`Show changed files (${item.files.length})`}
            aria-label="Show changed files"
            aria-expanded={false}
            onClick={() => setFilesOpen(true)}
          >
            <Icon name="layout-sidebar-left" />
          </button>
          <span className="diff-viewer__files-rail-count" title="Changed files">
            {item.files.length}
          </span>
        </div>
      ) : null}

      <div className="diff-viewer__main">
        <div className="diff-viewer__toolbar">
          <div className="diff-viewer__toolbar-left">
            {item.hideFileList && activePath ? (
              <span className="diff-viewer__focus-title" title={item.title}>
                {activePath}
                <span className="diff-viewer__focus-range">
                  {" "}
                  · HEAD → worktree
                </span>
              </span>
            ) : null}
            {showFilesRail && !filesOpen && activePath ? (
              <span className="diff-viewer__focus-title" title={activePath}>
                {activePath}
              </span>
            ) : null}
            <div
              className="diff-viewer__layout-toggle"
              role="group"
              aria-label="Diff layout"
            >
              <button
                type="button"
                className={`diff-viewer__layout-btn${sideBySide ? " is-active" : ""}`}
                onClick={() => setSideBySide(true)}
                title="Side-by-side (two columns)"
              >
                Side by side
              </button>
              <button
                type="button"
                className={`diff-viewer__layout-btn${!sideBySide ? " is-active" : ""}`}
                onClick={() => setSideBySide(false)}
                title="Inline (single column)"
              >
                Inline
              </button>
            </div>
          </div>
          <div className="diff-viewer__toolbar-actions">
            <div className="diff-viewer__diff-nav" role="group" aria-label="Diff navigation">
              <button
                type="button"
                className="icon-btn"
                title="Previous diff"
                aria-label="Previous diff"
                onClick={() => goToDiff("previous")}
              >
                <Icon name="arrow-up" />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Next diff"
                aria-label="Next diff"
                onClick={() => goToDiff("next")}
              >
                <Icon name="arrow-down" />
              </button>
            </div>
          </div>
        </div>

        <div className="diff-viewer__editor" ref={overlayRef}>
          {!activePath ? (
            <div className="empty-center">
              <p className="muted">Select a file to view the diff.</p>
            </div>
          ) : loading ? (
            <div className="viewer-loading">Loading diff…</div>
          ) : error ? (
            <div className="empty-center">
              <p className="error-text">{error}</p>
            </div>
          ) : (
            <>
              <DiffEditor
                // Force remount when layout changes — updateOptions is unreliable
                // for renderSideBySide in some monaco-react / monaco versions.
                key={`diff-${activePath}-${sideBySide ? "split" : "inline"}`}
                original={oldText}
                modified={newText}
                language={languageFromPath(activePath)}
                theme={monacoThemeId(theme)}
                keepCurrentOriginalModel={false}
                keepCurrentModifiedModel={false}
                onMount={onDiffMount}
                options={{
                  readOnly: true,
                  // Keep DOM selectable for reliable copy; edits still blocked.
                  domReadOnly: false,
                  renderSideBySide: sideBySide,
                  renderSideBySideInlineBreakpoint: sideBySide ? 0 : 1e9,
                  useInlineViewWhenSpaceIsLimited: !sideBySide,
                  minimap: { enabled: false },
                  fontSize,
                  lineHeight,
                  fontFamily: EDITOR_FONT_FAMILY,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  originalEditable: false,
                  contextmenu: true,
                  // Hide +/- in the line-number gutter (side-by-side).
                  renderIndicators: false,
                  renderMarginRevertIcon: false,
                  renderLineHighlight: "none",
                  selectionHighlight: false,
                  occurrencesHighlight: "off",
                  matchBrackets: "never",
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: true },
                  unicodeHighlight: {
                    ambiguousCharacters: false,
                    invisibleCharacters: false,
                    nonBasicASCII: false,
                    includeComments: false,
                    includeStrings: false,
                  },
                }}
              />
              {selToolbar && sideBySide && !composer ? (
                <button
                  type="button"
                  className="anno-sel-chip"
                  style={{ left: selToolbar.left, top: selToolbar.top }}
                  title="Add comment"
                  aria-label="Add comment"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const ed = modifiedEditorRef.current;
                    if (ed) openComposer(ed, false);
                  }}
                >
                  <Icon name="comment" />
                </button>
              ) : null}
              {bubble && bubbleComment && sideBySide ? (
                <CommentBubble
                  key={bubble.commentId}
                  comment={bubbleComment}
                  relatedComments={relatedBubbleComments}
                  left={bubble.left}
                  top={bubble.top}
                  onClose={closeBubble}
                  onPointerEnter={() => {
                    pointerOverBubbleRef.current = true;
                    clearHoverCloseTimer();
                  }}
                  onPointerLeave={() => {
                    pointerOverBubbleRef.current = false;
                    scheduleHoverClose();
                  }}
                  onMutated={() => {
                    applyDecorations();
                    if (bubble && !liveComment(bubble.commentId)) {
                      closeBubble();
                    }
                  }}
                />
              ) : null}
            </>
          )}
        </div>
        {composer && sideBySide ? (
          <div className="composer">
            <div className="composer__meta">
              L{composer.startLine}–{composer.endLine}:{" "}
              <code>{composer.selectedText.slice(0, 80)}</code>
              {composer.forceNewSession ? (
                <span
                  className="composer__badge"
                  title="Will end the active session (export) and write this comment into a new session"
                >
                  new session
                </span>
              ) : null}
            </div>
            <p className="composer__hint">
              Comment targets the <strong>right (newer)</strong> column
              {item.branch ? (
                <>
                  {" "}
                  · branch <code>{item.branch}</code>
                </>
              ) : null}
              {" · "}
              <code>{shortRev(item.base)}</code> →{" "}
              <code>
                {item.head === "worktree" ? "worktree" : shortRev(item.head)}
              </code>
              . Branch and commit range are prepended to the comment body.
              {composer.forceNewSession ? (
                <>
                  {" "}
                  Saves under a <strong>new session</strong>.
                </>
              ) : null}
            </p>
            <textarea
              ref={composerInputRef}
              className="composer__input"
              rows={3}
              placeholder="Write feedback for the AI CLI…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              autoFocus
            />
            <div className="composer__actions">
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => setComposer(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={!body.trim() || saving}
                onClick={() => void submit(true)}
                title="End the active session and save this comment in a new session"
              >
                Save comment (new session)
              </button>
              <button
                type="button"
                className="btn btn--accent btn--small"
                disabled={!body.trim() || saving}
                onClick={() => void submit(false)}
              >
                {saving ? "Saving…" : "Save comment"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
