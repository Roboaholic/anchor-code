// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownFindBar } from "./MarkdownFindBar";

afterEach(() => cleanup());

describe("MarkdownFindBar", () => {
  it("shows match count and navigates", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <MarkdownFindBar
        query="foo"
        caseSensitive={false}
        matchCount={3}
        activeIndex={1}
        onQueryChange={onQueryChange}
        onCaseSensitiveChange={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next match"));
    fireEvent.click(screen.getByLabelText("Previous match"));
    fireEvent.click(screen.getByLabelText("Close find"));
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter goes next and Shift+Enter goes previous; Esc closes", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();
    render(
      <MarkdownFindBar
        query="x"
        caseSensitive={false}
        matchCount={2}
        activeIndex={0}
        onQueryChange={vi.fn()}
        onCaseSensitiveChange={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />,
    );
    const input = screen.getByLabelText("Find in document");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports no results", () => {
    render(
      <MarkdownFindBar
        query="zzz"
        caseSensitive={false}
        matchCount={0}
        activeIndex={-1}
        onQueryChange={vi.fn()}
        onCaseSensitiveChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No results")).toBeTruthy();
    expect((screen.getByLabelText("Next match") as HTMLButtonElement).disabled).toBe(true);
  });
});
