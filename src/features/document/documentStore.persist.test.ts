import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindDocumentAutosave,
  DOCUMENT_AUTOSAVE_DELAY_MS,
  flushDocumentAutosave,
  restoreWorkspaceDocuments,
  saveWorkspaceDocuments,
  useDocumentStore,
} from "./documentStore";

const KEY = "anchor.workspace.documents.v1";

function installLocalStorage() {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  return data;
}

function installAnchor() {
  (globalThis as { window?: unknown }).window = {
    anchor: {
      workspace: {
        readText: vi.fn(async (p: string) => ({ text: p, size: p.length, truncated: false })),
      },
    },
  };
}

function saved(): Record<string, { openItems: Array<{ kind: string; path?: string }> }> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}");
}

async function openFiles(...paths: string[]) {
  for (const path of paths) {
    await useDocumentStore.getState().openFile({ path, workspaceRoot: "/proj" });
  }
}

describe("document tab persistence", () => {
  let target: { workspaceRoot: string; hostProfileId: string | null } | null;
  let unbind: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorage();
    installAnchor();
    target = { workspaceRoot: "/proj", hostProfileId: null };
    useDocumentStore.setState({
      openItems: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeId: "welcome",
    });
    unbind = bindDocumentAutosave(() => target);
  });

  afterEach(() => {
    unbind();
    vi.useRealTimers();
  });

  it("auto-saves close-all so restart restores only Welcome", async () => {
    await openFiles("/proj/a.ts", "/proj/b.ts", "/proj/c.ts");
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(saved()["local-default::/proj"].openItems).toHaveLength(4);

    useDocumentStore.getState().closeAllItems();
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(saved()["local-default::/proj"].openItems).toEqual([{ kind: "welcome" }]);

    useDocumentStore.setState({ openItems: [], activeId: null });
    await restoreWorkspaceDocuments("/proj", null);
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual(["welcome"]);
  });

  it("flush writes a pending save immediately (beforeunload / quit)", async () => {
    await openFiles("/proj/a.ts");
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    useDocumentStore.getState().closeAllItems();
    flushDocumentAutosave();
    expect(saved()["local-default::/proj"].openItems).toEqual([{ kind: "welcome" }]);
  });

  it("persists single close and reorder", async () => {
    await openFiles("/proj/a.ts", "/proj/b.ts");
    useDocumentStore.getState().closeItem("file:/proj/a.ts");
    useDocumentStore.getState().reorderTabs(1, 0);
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(saved()["local-default::/proj"].openItems.map((i) => i.path ?? i.kind)).toEqual([
      "/proj/b.ts",
      "welcome",
    ]);
  });

  it("asks main to flush storage to disk after an auto-save", async () => {
    const flushStorage = vi.fn(async () => undefined);
    (window as unknown as { anchor: { shell?: unknown } }).anchor.shell = { flushStorage };
    useDocumentStore.getState().closeAllItems();
    await openFiles("/proj/z.ts");
    expect(flushStorage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(flushStorage).toHaveBeenCalledTimes(1);
  });

  it("does not save while no workspace is open", () => {
    target = null;
    useDocumentStore.getState().closeAllItems();
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("does not overwrite saved tabs mid-restore", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "local-default::/other": {
          openItems: [{ kind: "file", path: "/other/x.ts", mdViewMode: "rendered" }],
          activeIndex: 0,
        },
      }),
    );
    target = { workspaceRoot: "/other", hostProfileId: null };
    await restoreWorkspaceDocuments("/other", null);
    vi.advanceTimersByTime(DOCUMENT_AUTOSAVE_DELAY_MS);
    expect(saved()["local-default::/other"].openItems).toHaveLength(1);
  });

  it("uses one key for null / empty / local-default host and trailing slash", () => {
    useDocumentStore.getState().closeAllItems();
    saveWorkspaceDocuments("/proj/", "");
    saveWorkspaceDocuments("/proj", "local-default");
    expect(Object.keys(saved())).toEqual(["local-default::/proj"]);
  });

  it("reads legacy keys and drops them on next save", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "::/legacy/": {
          openItems: [{ kind: "file", path: "/legacy/old.ts", mdViewMode: "rendered" }],
          activeIndex: 0,
        },
      }),
    );
    unbind();
    await restoreWorkspaceDocuments("/legacy/", "");
    expect(useDocumentStore.getState().openItems.map((i) => i.id)).toEqual([
      "file:/legacy/old.ts",
    ]);
    useDocumentStore.getState().closeAllItems();
    saveWorkspaceDocuments("/legacy/", "");
    expect(Object.keys(saved())).toEqual(["local-default::/legacy"]);
  });
});
