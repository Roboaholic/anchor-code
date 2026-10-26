// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";

const mocks = vi.hoisted(() => ({
  openFileFromTree: vi.fn(async () => {}),
  readImage: vi.fn(),
}));

vi.mock("./CodeViewer", () => ({ CodeViewer: () => <div data-testid="raw-editor" /> }));
vi.mock("@/features/shell/orchestrate", () => ({
  addCommentFromSelection: vi.fn(),
  openFileFromTree: mocks.openFileFromTree,
}));
vi.mock("@/features/annotations/CommentBubble", () => ({ CommentBubble: () => null }));

import { MarkdownViewer } from "./MarkdownViewer";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>';

function view(content: string, path = "/home/u/proj/docs/design.md") {
  return render(
    <MarkdownViewer path={path} content={content} truncated={false} mode="rendered" onModeChange={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  useAnnotationsStore.setState({ ...useAnnotationsStore.getInitialState(), sessions: [], decorationsFor: () => [] }, true);
  mocks.readImage.mockImplementation(async (p: string) => ({
    path: p,
    mime: p.endsWith(".svg") ? "image/svg+xml" : "image/png",
    base64: Buffer.from(p.endsWith(".svg") ? SVG : "png").toString("base64"),
    size: 3,
  }));
  (window as unknown as { anchor: unknown }).anchor = { workspace: { readImage: mocks.readImage } };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Markdown relative images", () => {
  it("renders a relative SVG through the host as an image/svg+xml data URL, never inline markup", async () => {
    const { container } = view("![同 session 部分起停的结构调用与数据路径](diagrams/detail-partial-stream.svg)");
    const img = await screen.findByRole("img", { name: "同 session 部分起停的结构调用与数据路径" });
    expect(mocks.readImage).toHaveBeenCalledWith("/home/u/proj/docs/diagrams/detail-partial-stream.svg");
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(container.querySelector(".md-body svg, .md-body script")).toBeNull();
    expect(container.querySelector(".md-img-placeholder")).toBeNull();
  });

  it("resolves Windows paths, encoded names and raster formats", async () => {
    view("![a](img/my%20chart.png)\n\n![b](..\\shared\\图.webp)", "C:\\Users\\me\\proj\\docs\\README.md");
    await waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(2));
    expect(mocks.readImage).toHaveBeenCalledWith("C:/Users/me/proj/docs/img/my chart.png");
    expect(mocks.readImage).toHaveBeenCalledWith("C:/Users/me/proj/shared/图.webp");
  });

  it("falls back to the placeholder with the host error when the image cannot be read", async () => {
    mocks.readImage.mockRejectedValueOnce(new Error("Error invoking remote method 'workspace:readImage': Error: Cannot read file: /x"));
    const { container } = view("![missing](nope.svg)");
    await waitFor(() => expect(container.querySelector(".md-img-placeholder")).toBeTruthy());
    expect(container.textContent).toContain("Cannot read file: /x");
  });
});

describe("Markdown links", () => {
  it("opens relative workspace links inside the app instead of navigating the window", async () => {
    view("[打开结构调用图](diagrams/detail-partial-stream.svg) and [code](../src/a.ts#L42)");
    const link = screen.getByRole("link", { name: "打开结构调用图" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openFileFromTree).toHaveBeenCalledWith("/home/u/proj/docs/diagrams/detail-partial-stream.svg", undefined);

    fireEvent.click(screen.getByRole("link", { name: "code" }));
    expect(mocks.openFileFromTree).toHaveBeenLastCalledWith("/home/u/proj/src/a.ts", { revealLine: 42 });
  });

  it("sends web links to a new window (routed to the OS browser by main) and blocks javascript:", () => {
    view("[site](https://example.com/x) [bad](javascript:alert(1))");
    const site = screen.getByRole("link", { name: "site" });
    expect(site.getAttribute("target")).toBe("_blank");
    expect(site.getAttribute("rel")).toContain("noopener");
    const bad = screen.getByText("bad");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    bad.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openFileFromTree).not.toHaveBeenCalled();
  });

  it("scrolls to in-page headings for #fragment links", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    view("[jump](#62-同-session-部分起停)\n\n## 6.2 同 session 部分起停");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "jump" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(mocks.openFileFromTree).not.toHaveBeenCalled();
  });
});
