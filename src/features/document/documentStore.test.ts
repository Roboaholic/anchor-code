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
    // Dragged tab becomes active
    expect(useDocumentStore.getState().activeId).toBe("file:/proj/c.ts");

    // No-op when from === to
    useDocumentStore.getState().reorderTabs(1, 1);
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual(ids);

    // Out of range is ignored
    useDocumentStore.getState().reorderTabs(0, 99);
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual(ids);
  });
});

describe("documentStore tab close helpers", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
  });

  async function openThree() {
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
  }

  it("closeOtherItems keeps only the target tab", async () => {
    await openThree();
    useDocumentStore.getState().closeOtherItems("file:/proj/b.ts");
    const s = useDocumentStore.getState();
    expect(s.openItems.map((i) => i.id)).toEqual(["file:/proj/b.ts"]);
    expect(s.activeId).toBe("file:/proj/b.ts");
  });

  it("closeItemsToTheRight drops tabs after the target", async () => {
    await openThree();
    // welcome, a, b, c — close to the right of a
    useDocumentStore.getState().closeItemsToTheRight("file:/proj/a.ts");
    const s = useDocumentStore.getState();
    expect(s.openItems.map((i) => i.id)).toEqual([
      "welcome",
      "file:/proj/a.ts",
    ]);
    // active was c; should fall back to a
    expect(s.activeId).toBe("file:/proj/a.ts");
  });

  it("closeAllItems restores Welcome", async () => {
    await openThree();
    useDocumentStore.getState().closeAllItems();
    const s = useDocumentStore.getState();
    expect(s.openItems).toEqual([
      { id: "welcome", kind: "welcome", title: "Welcome" },
    ]);
    expect(s.activeId).toBe("welcome");
  });
});

