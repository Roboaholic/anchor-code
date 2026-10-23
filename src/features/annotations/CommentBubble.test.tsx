// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentRecord } from "@/shared/anchor-api";
import { CommentBubble } from "./CommentBubble";
import { useAnnotationsStore } from "./annotationsStore";

vi.mock("./CommentMarkdown", () => ({ CommentMarkdown: ({ content }: { content: string }) => <span>{content}</span> }));

const originalActions = {
  reply: useAnnotationsStore.getState().reply,
  editComment: useAnnotationsStore.getState().editComment,
};
const comment = (id: string, author = "reviewer"): CommentRecord => ({
  id, author, status: "discussing", created_at: "2026-01-01", updated_at: "2026-01-01",
  target: {
    file_path: "a.ts", kind: "source", start_line: 1, end_line: 1,
    start_column: 1, end_column: 5, selected_text: "code", before_context: "", after_context: "",
  },
  messages: [{ id: `${id}-message`, author, body: "Original feedback", created_at: "2026-01-01" }],
});
const base = { comment: comment("first"), left: 0, top: 0 };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useAnnotationsStore.setState({ reply: vi.fn(async () => {}), editComment: vi.fn(async () => {}) });
});
afterEach(() => { cleanup(); useAnnotationsStore.setState(originalActions); });

describe("CommentBubble editing lifetime", () => {
  it("pins a reply across pointer leave and outside clicks, then releases it on Cancel", () => {
    const onClose = vi.fn();
    const onPinnedChange = vi.fn();
    const onPointerLeave = vi.fn();
    render(<CommentBubble {...base} onClose={onClose} onPinnedChange={onPinnedChange} onPointerLeave={onPointerLeave} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const draft = screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    expect(onPinnedChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(screen.getByRole("dialog"));
    fireEvent.pointerDown(document.body);
    expect(onPointerLeave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(draft.value).toBe("Keep this draft");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onPinnedChange).toHaveBeenLastCalledWith(false);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps replies pinned while saving and immediately shows progress", async () => {
    const save = deferred();
    const reply = vi.fn(() => save.promise);
    useAnnotationsStore.setState({ reply });
    const onPinnedChange = vi.fn();
    const onMutated = vi.fn();
    const onClose = vi.fn();
    render(<CommentBubble {...base} onClose={onClose} onPinnedChange={onPinnedChange} onMutated={onMutated} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply…"), { target: { value: "Response" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]!);
    expect(reply).toHaveBeenCalledWith("first", "Response");
    expect((screen.getByRole("button", { name: "Replying…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerLeave(screen.getByRole("dialog"));
    fireEvent.pointerDown(document.body);
    expect(onPinnedChange).toHaveBeenLastCalledWith(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => save.resolve());
    expect(onMutated).toHaveBeenCalledOnce();
    expect(onPinnedChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByPlaceholderText("Reply…")).toBeNull();
  });

  it("keeps the reply draft pinned and shows the error when saving fails", async () => {
    useAnnotationsStore.setState({ reply: vi.fn(async () => { throw new Error("Remote write failed"); }) });
    const onPinnedChange = vi.fn();
    const onClose = vi.fn();
    render(<CommentBubble {...base} onClose={onClose} onPinnedChange={onPinnedChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply…"), { target: { value: "Retry this" } });
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]!));
    expect(screen.getByRole("alert").textContent).toBe("Remote write failed");
    expect((screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement).value).toBe("Retry this");
    expect(onPinnedChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pins editing as well as replying while preserving explicit close and Escape", () => {
    const onPinnedChange = vi.fn();
    const onClose = vi.fn();
    render(<CommentBubble {...base} onClose={onClose} onPinnedChange={onPinnedChange} />);
    fireEvent.click(screen.getByRole("button", { name: /reviewer Original feedback/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit this message" }));
    expect(onPinnedChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(screen.getByRole("dialog"));
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close annotation" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays pinned until every overlapping thread finishes editing", () => {
    const second = comment("second", "other reviewer");
    const onPinnedChange = vi.fn();
    const view = render(<CommentBubble {...base} relatedComments={[second]} onClose={vi.fn()} onPinnedChange={onPinnedChange} />);
    fireEvent.click(within(screen.getByRole("region", { name: "reviewer comment" })).getByRole("button", { name: "Reply" }));
    fireEvent.click(within(screen.getByRole("region", { name: "other reviewer comment" })).getByRole("button", { name: "Reply" }));
    expect(onPinnedChange).toHaveBeenCalledTimes(1);
    expect(onPinnedChange).toHaveBeenLastCalledWith(true);
    view.rerender(<CommentBubble {...base} onClose={vi.fn()} onPinnedChange={onPinnedChange} />);
    expect(onPinnedChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onPinnedChange).toHaveBeenLastCalledWith(false);
  });
});
