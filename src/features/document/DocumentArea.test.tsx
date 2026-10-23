// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentArea } from "./DocumentArea";
import { useDocumentStore, type OpenItem } from "./documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";

const { renderCode } = vi.hoisted(() => ({ renderCode: vi.fn() }));
vi.mock("./CodeViewer", () => ({
  CodeViewer: (props: { content: string }) => {
    renderCode(props);
    if (props.content === "broken") throw new Error("Illegal value for lineNumber");
    return <div data-testid="code-content">{props.content}</div>;
  },
}));
vi.mock("./MarkdownViewer", () => ({ MarkdownViewer: () => <div>Markdown</div> }));
vi.mock("./DiffViewer", () => ({ DiffViewer: () => <div>Diff</div> }));

function file(name: string, content: string, loadState: "loading" | "loaded" = "loaded"): OpenItem {
  return {
    id: `file:/repo/${name}`, kind: "file", path: `/repo/${name}`, title: name,
    content, loadState, relativePath: name, size: content.length,
    language: "typescript", truncated: false, isMarkdown: false, mdViewMode: "rendered",
  };
}

beforeEach(() => {
  renderCode.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  useWorkspaceStore.setState({ workspaceRoot: "/repo" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("document loading and error isolation", () => {
  it("waits for an active lazy document's content before mounting its editor", async () => {
    const pending = file("pending.ts", "", "loading");
    useDocumentStore.setState({ openItems: [pending], activeId: pending.id });
    render(<DocumentArea />);
    expect(screen.getByRole("status", { name: "Loading document" })).toBeTruthy();
    expect(renderCode).not.toHaveBeenCalled();
    act(() => useDocumentStore.setState({ openItems: [file("pending.ts", "ready")] }));
    expect(await screen.findByTestId("code-content")).toHaveProperty("textContent", "ready");
  });

  it("keeps tabs usable when one document throws and permits retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = file("broken.ts", "broken");
    const healthy = file("healthy.ts", "healthy");
    useDocumentStore.setState({ openItems: [broken, healthy], activeId: broken.id });
    render(<DocumentArea />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("This document could not be displayed"));
    fireEvent.click(screen.getByRole("tab", { name: /healthy.ts/ }));
    expect(await screen.findByTestId("code-content")).toHaveProperty("textContent", "healthy");
    fireEvent.click(screen.getByRole("tab", { name: /broken.ts/ }));
    act(() => useDocumentStore.setState({ openItems: [file("broken.ts", "fixed"), healthy] }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getAllByTestId("code-content").some((node) => node.textContent === "fixed")).toBe(true);
  });
});
