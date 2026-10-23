// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SessionRecord } from "@/shared/anchor-api";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { useThemeStore } from "@/features/shell/themeStore";

const calls = vi.hoisted(() => ({
  markdown: vi.fn(),
  editorImport: vi.fn(),
  measure: vi.fn(),
  top: 120,
}));

vi.mock("react-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-markdown")>();
  const Markdown = original.default;
  return {
    ...original,
    default: (props: ComponentProps<typeof Markdown>) => {
      calls.markdown();
      return <Markdown {...props} />;
    },
  };
});
vi.mock("./CodeViewer", () => {
  calls.editorImport();
  return { CodeViewer: ({ content }: { content: string }) => <div data-testid="raw-editor">{content}</div> };
});
vi.mock("@/core/annotations/mdSelection", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/core/annotations/mdSelection")>(),
  measureCommentMarks: (...args: unknown[]) => {
    calls.measure(...args);
    return [{ commentId: "comment-1", left: 10, top: calls.top, width: 80, height: 18 }];
  },
}));
vi.mock("@/features/shell/orchestrate", () => ({ addCommentFromSelection: vi.fn() }));
vi.mock("@/features/annotations/CommentBubble", () => ({ CommentBubble: () => <div>Comment</div> }));

import { MarkdownViewer } from "./MarkdownViewer";

const session: SessionRecord = {
  version: 1,
  id: "session-1",
  title: "Review",
  status: "active",
  created_at: "2026-01-01",
  ended_at: null,
  author: "reviewer",
  notes: "",
  comments: [{
    id: "comment-1",
    status: "discussing",
    target: {
      file_path: "README.md", kind: "markdown", start_line: 1, end_line: 1,
      start_column: 1, end_column: 6, selected_text: "Title", before_context: "", after_context: "",
    },
    created_at: "2026-01-01", updated_at: "2026-01-01", author: "reviewer", messages: [],
  }],
};
const props = {
  path: "/repo/README.md", content: "# Title\n\nA paragraph.", truncated: false,
  mode: "rendered" as const, onModeChange: vi.fn(),
};

let frameId = 0;
let frames: Map<number, FrameRequestCallback>;
let resized: Array<() => void>;
let disconnect: ReturnType<typeof vi.fn>;

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
}

function setComments(enabled: boolean) {
  useAnnotationsStore.setState({
    sessions: enabled ? [session] : [],
    decorationsFor: () => enabled ? [{
      commentId: "comment-1", startLine: 1, endLine: 1, startColumn: 1, endColumn: 6,
      hover: "comment", status: "discussing", anchorStatus: "resolved", overlapCount: 1,
    }] : [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  calls.top = 120;
  frameId = 0;
  frames = new Map();
  resized = [];
  disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized.push(callback); }
    observe() {}
    disconnect = disconnect;
  });
  useAnnotationsStore.setState(useAnnotationsStore.getInitialState(), true);
  useThemeStore.setState({ fontSize: 13 });
  setComments(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAnnotationsStore.setState(useAnnotationsStore.getInitialState(), true);
});

describe("Markdown viewer performance", () => {
  it("loads the source editor only when Raw mode is requested", async () => {
    const { rerender } = render(<MarkdownViewer {...props} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(calls.editorImport).not.toHaveBeenCalled();

    rerender(<MarkdownViewer {...props} mode="raw" />);
    expect(await screen.findByTestId("raw-editor")).toBeTruthy();
    expect(calls.editorImport).toHaveBeenCalledTimes(1);
  });

  it("coalesces scroll measurements and keeps the parsed body across overlay and layout changes", () => {
    const { container, rerender } = render(<MarkdownViewer {...props} />);
    flushFrame();
    const surface = container.querySelector(".md-viewer__rendered-surface")!;
    expect(calls.markdown).toHaveBeenCalledTimes(1);
    expect(calls.measure).toHaveBeenCalledTimes(1);

    calls.top = 180;
    for (let i = 0; i < 8; i++) fireEvent.scroll(surface);
    expect(calls.measure).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(calls.measure).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Show comment" }).style.top).toBe("180px");
    expect(calls.markdown).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Widen rendered content" }));
    act(() => useThemeStore.setState({ fontSize: 16 }));
    flushFrame();
    expect(calls.measure).toHaveBeenCalledTimes(3);
    expect(calls.markdown).toHaveBeenCalledTimes(1);

    rerender(<MarkdownViewer {...props} content="# Updated" />);
    expect(screen.getByRole("heading", { name: "Updated" })).toBeTruthy();
    expect(calls.markdown).toHaveBeenCalledTimes(2);
  });

  it("does not measure unannotated documents and removes marks when comments disappear", () => {
    setComments(false);
    const { container } = render(<MarkdownViewer {...props} />);
    flushFrame();
    const surface = container.querySelector(".md-viewer__rendered-surface")!;
    fireEvent.scroll(surface);
    expect(frames.size).toBe(0);
    expect(calls.measure).not.toHaveBeenCalled();

    act(() => setComments(true));
    flushFrame();
    expect(screen.getByRole("button", { name: "Show comment" })).toBeTruthy();
    act(() => setComments(false));
    flushFrame();
    expect(screen.queryByRole("button", { name: "Show comment" })).toBeNull();
    fireEvent.scroll(surface);
    expect(frames.size).toBe(0);
    expect(calls.measure).toHaveBeenCalledTimes(1);
    expect(calls.markdown).toHaveBeenCalledTimes(1);
  });

  it("remeasures asynchronous diagram and image layout changes and cancels work on unmount", async () => {
    const { container, unmount } = render(<MarkdownViewer {...props} />);
    flushFrame();
    const body = container.querySelector("article")!;
    const diagram = document.createElement("div");
    const img = document.createElement("img");
    await act(async () => {
      body.append(diagram, img);
      resized[0]!();
      fireEvent.load(img);
    });
    expect(calls.measure).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(calls.measure).toHaveBeenCalledTimes(2);
    expect(calls.markdown).toHaveBeenCalledTimes(1);

    fireEvent.scroll(container.querySelector(".md-viewer__rendered-surface")!);
    expect(frames.size).toBe(1);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    flushFrame();
    expect(calls.measure).toHaveBeenCalledTimes(2);
  });

  it("reveals a focused comment once per explicit jump, without snapping back on scroll", () => {
    const { container, rerender } = render(<MarkdownViewer {...props} focusCommentId="comment-1" revealNonce={1} />);
    const surface = container.querySelector<HTMLElement>(".md-viewer__rendered-surface")!;
    const scrollTo = vi.fn();
    surface.scrollTo = scrollTo;
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    calls.top = 160;
    fireEvent.scroll(surface);
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender(<MarkdownViewer {...props} focusCommentId="comment-1" revealNonce={2} />);
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
