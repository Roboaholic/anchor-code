// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewCommentPopover } from "./NewCommentPopover";
import { commentDraftKey, useCommentDraftStore } from "./commentDraftStore";

const base = {
  path: "/repo/src/limiter.ts",
  startLine: 12,
  endLine: 18,
  anchor: { top: 100, bottom: 118, left: 40, startTop: 10 },
};

describe("NewCommentPopover", () => {
  beforeEach(() => useCommentDraftStore.setState({ drafts: {} }));
  afterEach(() => cleanup());

  it("shows file + range, defaults to discussing, submits with Ctrl+Enter", async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewCommentPopover {...base} onSubmit={onSubmit} onClose={onClose} />);
    expect(screen.getByText("limiter.ts")).toBeTruthy();
    expect(screen.getByText("L12-18")).toBeTruthy();
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(status.textContent).toContain("Discussing");
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(status);
    // The themed listbox is portaled; picking from it must not close the popover.
    fireEvent.mouseDown(screen.getByRole("option", { name: "Need modify" }));
    fireEvent.click(screen.getByRole("option", { name: "Need modify" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(status.textContent).toContain("Need modify");
    const box = screen.getByLabelText("Comment");
    fireEvent.change(box, { target: { value: "  tighten this  " } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(onSubmit).toHaveBeenCalledWith("tighten this", "need_modify", false);
    expect(onClose).toHaveBeenCalled();
    expect(useCommentDraftStore.getState().drafts).toEqual({});
  });

  it("Esc and outside click close but keep the per-selection draft", () => {
    const onClose = vi.fn();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const { unmount } = render(
      <NewCommentPopover {...base} onSubmit={async () => {}} onClose={onClose} />,
    );
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "draft" } });
    fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    const key = commentDraftKey(base.path, 12, 18);
    expect(useCommentDraftStore.getState().drafts[key]?.body).toBe("draft");
    render(<NewCommentPopover {...base} onSubmit={async () => {}} onClose={() => {}} />);
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("Esc inside the open status menu closes only the menu", () => {
    const onClose = vi.fn();
    render(<NewCommentPopover {...base} onSubmit={async () => {}} onClose={onClose} />);
    const status = screen.getByRole("combobox", { name: "Status" });
    fireEvent.keyDown(status, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(status, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(status, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the popover open and shows the error when saving fails", async () => {
    const onClose = vi.fn();
    render(
      <NewCommentPopover
        {...base}
        onSubmit={async () => {
          throw new Error("disk full");
        }}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("disk full");
    expect(onClose).not.toHaveBeenCalled();
  });
});
