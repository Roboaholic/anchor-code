// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnnotationsStore, type DecorationSpec } from "@/features/annotations/annotationsStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { SessionRecord } from "@/shared/anchor-api";

const mounted = vi.hoisted(() => ({ callback: null as OnMount | null }));
vi.mock("@monaco-editor/react", () => ({
  default: ({ onMount }: { onMount: OnMount }) => {
    mounted.callback = onMount;
    return <div data-testid="monaco-editor" />;
  },
}));
vi.mock("./monacoSetup", () => ({}));
vi.mock("@/features/shell/orchestrate", () => ({ addCommentFromSelection: vi.fn() }));
vi.mock("@/features/annotations/CommentBubble", () => ({ CommentBubble: () => null }));
vi.mock("@/features/annotations/NewCommentPopover", () => ({ NewCommentPopover: () => null }));

import { CodeViewer } from "./CodeViewer";

function strictEditor(initialText: string) {
  let text = initialText;
  const model = {
    isDisposed: vi.fn(() => false),
    getValue: vi.fn(() => text),
    getLineCount: vi.fn(() => text.split("\n").length),
    getLineMaxColumn: vi.fn((line: number) => {
      const lines = text.split("\n");
      if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
        throw new Error("Illegal value for lineNumber");
      }
      return lines[line - 1]!.length + 1;
    }),
  };
  const collections: Array<{ set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }> = [];
  const contentListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const passiveListener = () => ({ dispose: vi.fn() });
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () => {
      const collection = { set: vi.fn(), clear: vi.fn() };
      collections.push(collection);
      return collection;
    },
    updateOptions: vi.fn(),
    onDidChangeModel: (listener: () => void) => {
      modelListeners.add(listener);
      return { dispose: () => modelListeners.delete(listener) };
    },
    onDidChangeModelContent: (listener: () => void) => {
      contentListeners.add(listener);
      return { dispose: () => contentListeners.delete(listener) };
    },
    onMouseDown: passiveListener,
    onMouseLeave: passiveListener,
    onMouseMove: passiveListener,
    onDidChangeCursorSelection: passiveListener,
    onDidScrollChange: passiveListener,
    addAction: passiveListener,
  } as unknown as MonacoEditor.IStandaloneCodeEditor;
  return {
    editor, model, collections, contentListeners, modelListeners,
    setText(value: string) { text = value; },
  };
}

const props = {
  path: "/repo/sample.ts", content: "short file", language: "typescript", truncated: false,
};
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  mounted.callback = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  Object.assign(window, { anchor: { annotations: { locateGitRoot: vi.fn(async () => null) } } });
  useAnnotationsStore.setState(useAnnotationsStore.getInitialState(), true);
  useWorkspaceStore.setState({ workspaceRoot: "/repo" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAnnotationsStore.setState(useAnnotationsStore.getInitialState(), true);
});

describe("CodeViewer annotation model changes", () => {
  it("renders an old multiline comment safely after its file has been shortened", () => {
    const session: SessionRecord = {
      version: 1, id: "review", title: "Review", status: "active", author: "reviewer",
      created_at: "2026-01-01", ended_at: null, notes: "",
      comments: [{
        id: "removed", status: "discussing", author: "reviewer", messages: [],
        created_at: "2026-01-01", updated_at: "2026-01-01",
        target: {
          file_path: "sample.ts", kind: "source", start_line: 40, end_line: 50,
          start_column: 1, end_column: 1, selected_text: "removed code\n", before_context: "", after_context: "",
        },
      }],
    };
    useAnnotationsStore.setState({ repoRoot: "/repo", sessions: [session], activeSession: session });
    const current = strictEditor("short file");
    render(<CodeViewer {...props} focusCommentId="removed" />);

    expect(() => act(() => mounted.callback!(current.editor, {} as never))).not.toThrow();
    expect(screen.getByTestId("monaco-editor")).toBeTruthy();
    expect(current.collections[0]!.set).toHaveBeenLastCalledWith([]);
    expect(current.model.getLineMaxColumn).not.toHaveBeenCalled();
  });

  it("repaints from the current model and latest annotation callback after a delayed text update", () => {
    const current = strictEditor("short file");
    const initialDecorations = vi.fn(() => []);
    useAnnotationsStore.setState({ decorationsFor: initialDecorations });
    const { rerender } = render(<CodeViewer {...props} />);
    act(() => mounted.callback!(current.editor, {} as never));
    const initialCalls = initialDecorations.mock.calls.length;
    const updatedText = "first\nnew target\n";
    const updatedDecorations = vi.fn((_path: string, content: string): DecorationSpec[] => content === updatedText ? [{
      commentId: "new", startLine: 2, endLine: 3, startColumn: 1, endColumn: 1,
      hover: "Review", status: "discussing", anchorStatus: "resolved", overlapCount: 1,
    }] : []);
    act(() => useAnnotationsStore.setState({ decorationsFor: updatedDecorations }));
    rerender(<CodeViewer {...props} content={updatedText} />);
    // The React value already changed; the wrapper has not updated Monaco yet.
    expect(updatedDecorations).toHaveBeenLastCalledWith(props.path, "short file");
    expect(current.collections[0]!.set).toHaveBeenLastCalledWith([]);

    act(() => {
      current.setText(updatedText);
      for (const listener of current.contentListeners) listener();
    });
    expect(updatedDecorations).toHaveBeenLastCalledWith(props.path, updatedText);
    expect(initialDecorations).toHaveBeenCalledTimes(initialCalls);
    expect(current.collections[0]!.set).toHaveBeenLastCalledWith([
      expect.objectContaining({ range: {
        startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 11,
      } }),
    ]);
  });

  it("removes model listeners and ignores queued repaint frames after unmount", () => {
    const current = strictEditor("short file");
    const annotations = vi.fn(() => []);
    useAnnotationsStore.setState({ decorationsFor: annotations });
    const { unmount } = render(<CodeViewer {...props} />);
    act(() => mounted.callback!(current.editor, {} as never));
    expect(current.contentListeners.size).toBe(1);
    expect(current.modelListeners.size).toBe(1);
    const calls = annotations.mock.calls.length;
    unmount();
    expect(current.contentListeners.size).toBe(0);
    expect(current.modelListeners.size).toBe(0);
    current.model.isDisposed.mockReturnValue(true);
    act(() => { for (const frame of frames) frame(performance.now()); });
    expect(annotations).toHaveBeenCalledTimes(calls);
  });
});
