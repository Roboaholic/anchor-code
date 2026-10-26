// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./CodeViewer", () => ({
  CodeViewer: ({ content, language }: { content: string; language: string }) => (
    <div data-testid="source" data-language={language}>{content}</div>
  ),
}));

import { ImageViewer } from "./ImageViewer";

const readImage = vi.fn();

beforeEach(() => {
  readImage.mockReset();
  readImage.mockImplementation(async (p: string) => ({
    path: p, mime: p.endsWith(".svg") ? "image/svg+xml" : "image/png", base64: "AAAA", size: 3,
  }));
  (window as unknown as { anchor: unknown }).anchor = { workspace: { readImage } };
});
afterEach(cleanup);

const base = { truncated: false, size: 3, onModeChange: vi.fn() };

describe("ImageViewer", () => {
  it("previews an SVG tab as an <img> and switches to its XML source", async () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <ImageViewer {...base} path="/w/d/flow.svg" content="<svg/>" mode="rendered" onModeChange={onModeChange} />,
    );
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;base64,AAAA");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onModeChange).toHaveBeenCalledWith("raw");
    rerender(<ImageViewer {...base} path="/w/d/flow.svg" content="<svg/>" mode="raw" onModeChange={onModeChange} />);
    const source = await screen.findByTestId("source");
    expect(source.dataset.language).toBe("xml");
    expect(source.textContent).toBe("<svg/>");
  });

  it("shows raster images without a source toggle and reports read errors", async () => {
    render(<ImageViewer {...base} path="/w/a.png" content="" mode="rendered" />);
    expect((await screen.findByRole("img")).getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    cleanup();
    readImage.mockRejectedValueOnce(new Error("File is too large to preview"));
    render(<ImageViewer {...base} path="/w/b.png" content="" mode="rendered" />);
    expect(await screen.findByText("File is too large to preview")).toBeTruthy();
  });
});
