import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";

function mockReadText(pathToText: Record<string, string>) {
  const anchor = {
    workspace: {
      readText: vi.fn(async (p: string) => {
        const text = pathToText[p];
        if (text === undefined) throw new Error(`missing mock for ${p}`);
        return { text, size: text.length, truncated: false };
      }),
    },
  };
  // documentStore reads window.anchor
  (globalThis as { window?: unknown }).window = {
    anchor,
  };
  return anchor;
}

describe("documentStore.reorderTabs", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
  });

  it("moves a tab from one index to another", async () => {
    mockReadText({
      "/proj/a.ts": "a",
      "/proj/b.ts": "b",
      "/proj/c.ts": "c",
    });

    await useDocumentStore.getState().openFile({
      path: "/proj/a.ts",
      workspaceRoot: "/proj",
    });
    await useDocumentStore.getState().openFile({
      path: "/proj/b.ts",
      workspaceRoot: "/proj",
    });
    await useDocumentStore.getState().openFile({
      path: "/proj/c.ts",
      workspaceRoot: "/proj",
    });

    // welcome + a + b + c
    let ids = useDocumentStore.getState().openItems.map((i) => i.id);
    expect(ids).toEqual([
      "welcome",
      "file:/proj/a.ts",
      "file:/proj/b.ts",
      "file:/proj/c.ts",
    ]);

    // Move c (index 3) before a (index 1)
    useDocumentStore.getState().reorderTabs(3, 1);
    ids = useDocumentStore.getState().openItems.map((i) => i.id);
    expect(ids).toEqual([
      "welcome",
      "file:/proj/c.ts",
      "file:/proj/a.ts",
      "file:/proj/b.ts",
    ]);

    // No-op when from === to
    useDocumentStore.getState().reorderTabs(1, 1);
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual(ids);

    // Out of range is ignored
    useDocumentStore.getState().reorderTabs(0, 99);
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual(ids);
  });
});
