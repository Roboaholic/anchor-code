// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { useDocumentStore } from "./documentStore";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useDocumentStore.setState(
    {
      ...useDocumentStore.getInitialState(),
      openItems: [
        {
          id: "file:/repo/a.ts",
          kind: "file",
          path: "/repo/a.ts",
          title: "a.ts",
          relativePath: "a.ts",
          language: "typescript",
          isMarkdown: false,
          content: "mine",
          truncated: false,
          size: 4,
          mdViewMode: "rendered",
          loadState: "loaded",
          dirty: true,
          externalChange: { mtimeMs: 2, size: 9 },
        },
      ],
      activeId: "file:/repo/a.ts",
    },
    true,
  );
});

describe("ExternalChangeBanner", () => {
  it("offers Reload and Keep mine", () => {
    const reload = vi.spyOn(useDocumentStore.getState(), "reloadFileFromDisk").mockResolvedValue();
    const keep = vi.spyOn(useDocumentStore.getState(), "keepFileBuffer");
    render(<ExternalChangeBanner path="/repo/a.ts" />);
    expect(screen.getByText(/changed on disk/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledWith("/repo/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(keep).toHaveBeenCalledWith("/repo/a.ts");
  });

  it("renders nothing without a pending external change", () => {
    useDocumentStore.setState((s) => ({
      openItems: s.openItems.map((item) =>
        item.kind === "file" ? { ...item, externalChange: null } : item,
      ),
    }));
    const { container } = render(<ExternalChangeBanner path="/repo/a.ts" />);
    expect(container.textContent).toBe("");
  });
});
