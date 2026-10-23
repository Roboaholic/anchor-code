import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindDocumentAutosave,
  dropWorkspaceDocumentView,
  flushDocumentAutosave,
  restoreWorkspaceDocuments,
  saveWorkspaceDocuments,
  useDocumentStore,
} from "./documentStore";

const KEY = "anchor.workspace.documents.v1";
type ReadResult = { text: string; size: number; truncated: boolean };

function deferredRead() {
  let resolve!: (value: ReadResult) => void;
  const promise = new Promise<ReadResult>((done) => { resolve = done; });
  return { promise, resolve: (text: string) => resolve({ text, size: text.length, truncated: false }) };
}

function persist(root: string, paths: string[], activeIndex: number, host = "local-default") {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  saved[`${host}::${root}`] = {
    openItems: paths.map((path) => path === "welcome"
      ? { kind: "welcome" }
      : { kind: "file", path, mdViewMode: path.endsWith(".md") ? "raw" : "rendered" }),
    activeIndex,
  };
  localStorage.setItem(KEY, JSON.stringify(saved));
}

function currentFile(path: string) {
  const item = useDocumentStore.getState().openItems.find((entry) => entry.kind === "file" && entry.path === path);
  if (item?.kind !== "file") throw new Error(`Missing file ${path}`);
  return item;
}

describe("active document first workspace restoration", () => {
  const readText = vi.fn<(path: string) => Promise<ReadResult>>();

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", { anchor: { workspace: { readText } } });
    readText.mockReset().mockImplementation(async (path) => ({ text: path, size: path.length, truncated: false }));
    useDocumentStore.getState().closeAllItems();
  });

  afterEach(() => {
    useDocumentStore.getState().closeAllItems();
    vi.unstubAllGlobals();
  });

  it("restores the tab strip and saved selection before I/O, loading other tabs only when selected", async () => {
    const active = deferredRead();
    const inactive = deferredRead();
    persist("/lazy", ["/lazy/slow.ts", "welcome", "/lazy/active.md"], 2);
    readText.mockImplementation((path) => path.endsWith("active.md") ? active.promise : inactive.promise);

    const restoring = restoreWorkspaceDocuments("/lazy", null);
    expect(useDocumentStore.getState().openItems.map((item) => item.id)).toEqual([
      "file:/lazy/slow.ts", "welcome", "file:/lazy/active.md",
    ]);
    expect(useDocumentStore.getState().activeId).toBe("file:/lazy/active.md");
    await Promise.resolve();
    expect(readText.mock.calls).toEqual([["/lazy/active.md"]]);
    active.resolve("# Active document");
    await restoring;
    expect(currentFile("/lazy/active.md")).toMatchObject({ content: "# Active document", mdViewMode: "raw" });
    expect(readText).toHaveBeenCalledTimes(1);

    useDocumentStore.getState().setActive("file:/lazy/slow.ts");
    // Repeated selections share the pending request.
    useDocumentStore.getState().setActive("file:/lazy/slow.ts");
    await Promise.resolve();
    expect(readText.mock.calls).toEqual([["/lazy/active.md"], ["/lazy/slow.ts"]]);
    inactive.resolve("Later document");
    await vi.waitFor(() => expect(currentFile("/lazy/slow.ts").content).toBe("Later document"));
  });

  it("loads a deferred tab when closing the active tab selects it", async () => {
    persist("/close-selection", ["/close-selection/b.ts", "/close-selection/a.ts"], 1);
    await restoreWorkspaceDocuments("/close-selection", null);
    useDocumentStore.getState().closeItem("file:/close-selection/a.ts");
    await vi.waitFor(() => expect(currentFile("/close-selection/b.ts").content).toBe("/close-selection/b.ts"));
    expect(useDocumentStore.getState().activeId).toBe("file:/close-selection/b.ts");
  });

  it("does not let an old host's read replace the same path in a new host", async () => {
    const first = deferredRead();
    const second = deferredRead();
    persist("/same-root", ["/same-root/a.ts"], 0, "host-a");
    persist("/same-root", ["/same-root/a.ts"], 0, "host-b");
    readText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const restoringFirst = restoreWorkspaceDocuments("/same-root", "host-a");
    await Promise.resolve();
    const restoringSecond = restoreWorkspaceDocuments("/same-root", "host-b");
    await Promise.resolve();
    first.resolve("old host content");
    await restoringFirst;
    expect(currentFile("/same-root/a.ts").content).toBe("");
    second.resolve("new host content");
    await restoringSecond;
    expect(currentFile("/same-root/a.ts").content).toBe("new host content");
  });

  it("ignores a closed tab's read after the same path is reopened", async () => {
    const first = deferredRead();
    const second = deferredRead();
    readText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const openingFirst = useDocumentStore.getState().openFile({ path: "/reopen/a.ts", workspaceRoot: "/reopen" });
    await Promise.resolve();
    useDocumentStore.getState().closeItem("file:/reopen/a.ts");
    const openingSecond = useDocumentStore.getState().openFile({ path: "/reopen/a.ts", workspaceRoot: "/reopen" });
    await Promise.resolve();
    second.resolve("new file content");
    await openingSecond;
    first.resolve("stale file content");
    await openingFirst;
    expect(currentFile("/reopen/a.ts").content).toBe("new file content");
  });

  it("preserves a search reveal and raw Markdown mode when a deferred file finishes loading", async () => {
    persist("/reveal", ["welcome", "/reveal/a.md"], 0);
    await restoreWorkspaceDocuments("/reveal", null);
    await useDocumentStore.getState().openFile({
      path: "/reveal/a.md", workspaceRoot: "/reveal", revealLine: 12,
      searchHighlight: { line: 12, query: "needle" },
    });
    expect(currentFile("/reveal/a.md")).toMatchObject({
      mdViewMode: "raw", revealLine: 12, searchHighlight: { line: 12, query: "needle" },
    });
  });

  it("preserves failed tabs and retries them without moving their position", async () => {
    persist("/retry", ["/retry/a.md", "welcome"], 0);
    readText.mockRejectedValueOnce(new Error("Temporarily disconnected"));
    await restoreWorkspaceDocuments("/retry", null);
    expect(currentFile("/retry/a.md").error).toContain("Temporarily disconnected");
    await useDocumentStore.getState().openFile({ path: "/retry/a.md", workspaceRoot: "/retry" });
    expect(currentFile("/retry/a.md")).toMatchObject({ content: "/retry/a.md", error: undefined, mdViewMode: "raw" });
    expect(useDocumentStore.getState().openItems.map((item) => item.id)).toEqual(["file:/retry/a.md", "welcome"]);
  });

  it("keeps autosave working in the new workspace while an older restore is stalled", async () => {
    const oldRead = deferredRead();
    persist("/stalled", ["/stalled/a.ts"], 0);
    persist("/next", ["welcome"], 0);
    readText.mockImplementationOnce(() => oldRead.promise);
    let target = { workspaceRoot: "/stalled", hostProfileId: null };
    const unbind = bindDocumentAutosave(() => target);
    try {
      const oldRestore = restoreWorkspaceDocuments("/stalled", null);
      await Promise.resolve();
      target = { workspaceRoot: "/next", hostProfileId: null };
      await restoreWorkspaceDocuments("/next", null);
      await useDocumentStore.getState().openFile({ path: "/next/b.ts", workspaceRoot: "/next" });
      flushDocumentAutosave();
      const saved = JSON.parse(localStorage.getItem(KEY)!);
      expect(saved["local-default::/next"].openItems).toContainEqual({ kind: "file", path: "/next/b.ts", mdViewMode: "rendered" });
      oldRead.resolve("old document");
      await oldRestore;
      expect(useDocumentStore.getState().activeId).toBe("file:/next/b.ts");
    } finally {
      unbind();
      dropWorkspaceDocumentView("/next", null);
    }
  });

  it("restarts a parked pending read and can discard a closed workspace's snapshot", async () => {
    const parked = deferredRead();
    persist("/parked", ["/parked/a.ts"], 0);
    readText.mockImplementationOnce(() => parked.promise);
    const firstRestore = restoreWorkspaceDocuments("/parked", null);
    await Promise.resolve();
    saveWorkspaceDocuments("/parked", null);
    await restoreWorkspaceDocuments("/empty", null);
    await restoreWorkspaceDocuments("/parked", null);
    expect(currentFile("/parked/a.ts").content).toBe("/parked/a.ts");
    parked.resolve("stale snapshot content");
    await firstRestore;
    expect(currentFile("/parked/a.ts").content).toBe("/parked/a.ts");
    dropWorkspaceDocumentView("/parked", null);
    await restoreWorkspaceDocuments("/empty", null);
    readText.mockResolvedValueOnce({ text: "updated after close", size: 19, truncated: false });
    await restoreWorkspaceDocuments("/parked", null);
    expect(currentFile("/parked/a.ts").content).toBe("updated after close");
  });
});
