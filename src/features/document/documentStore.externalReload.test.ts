// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";

const readText = vi.fn();
const stat = vi.fn();

function textResult(text: string, size = text.length) {
  return { text, size, truncated: false };
}

beforeEach(() => {
  localStorage.clear();
  readText.mockReset().mockImplementation(async (path: string) => textResult(`content:${path}`));
  stat.mockReset().mockResolvedValue({ isFile: true, isDir: false, size: 12, mtimeMs: 1_000 });
  Object.assign(window, { anchor: { workspace: { readText, stat } } });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
});

describe("external disk reload", () => {
  it("records a disk fingerprint when a file loads", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    const file = useDocumentStore.getState().openItems.find((i) => i.kind === "file");
    expect(file).toMatchObject({
      content: "content:/repo/a.ts",
      diskMtimeMs: 1_000,
      diskSize: 12,
      dirty: false,
      externalChange: null,
    });
    expect(stat).toHaveBeenCalledWith("/repo/a.ts");
  });

  it("auto-reloads a clean tab when the disk fingerprint changes", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    readText.mockResolvedValueOnce(textResult("updated on disk", 15));
    stat.mockResolvedValue({ isFile: true, isDir: false, size: 15, mtimeMs: 2_000 });
    useDocumentStore.getState().applyExternalDiskStat("/repo/a.ts", { mtimeMs: 2_000, size: 15 });
    await vi.waitFor(() => {
      const file = useDocumentStore.getState().openItems.find((i) => i.kind === "file");
      expect(file).toMatchObject({
        content: "updated on disk",
        diskMtimeMs: 2_000,
        diskSize: 15,
        dirty: false,
        externalChange: null,
      });
    });
  });

  it("prompts a dirty tab instead of overwriting the buffer", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    useDocumentStore.getState().setFileDirty("/repo/a.ts", true);
    useDocumentStore.getState().updateFileContent("/repo/a.ts", "my edits");
    useDocumentStore.getState().applyExternalDiskStat("/repo/a.ts", { mtimeMs: 3_000, size: 99 });
    const file = useDocumentStore.getState().openItems.find((i) => i.kind === "file");
    expect(file).toMatchObject({
      content: "my edits",
      dirty: true,
      externalChange: { mtimeMs: 3_000, size: 99 },
    });
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("Reload takes the disk version and clears dirty state", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    useDocumentStore.getState().updateFileContent("/repo/a.ts", "my edits");
    useDocumentStore.getState().applyExternalDiskStat("/repo/a.ts", { mtimeMs: 4_000, size: 20 });
    readText.mockResolvedValueOnce(textResult("disk wins", 20));
    stat.mockResolvedValue({ isFile: true, isDir: false, size: 20, mtimeMs: 4_000 });
    await useDocumentStore.getState().reloadFileFromDisk("/repo/a.ts");
    const file = useDocumentStore.getState().openItems.find((i) => i.kind === "file");
    expect(file).toMatchObject({
      content: "disk wins",
      dirty: false,
      externalChange: null,
      diskMtimeMs: 4_000,
    });
  });

  it("Keep mine keeps the buffer and adopts the external fingerprint", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    useDocumentStore.getState().updateFileContent("/repo/a.ts", "my edits");
    useDocumentStore.getState().applyExternalDiskStat("/repo/a.ts", { mtimeMs: 5_000, size: 30 });
    useDocumentStore.getState().keepFileBuffer("/repo/a.ts");
    const file = useDocumentStore.getState().openItems.find((i) => i.kind === "file");
    expect(file).toMatchObject({
      content: "my edits",
      dirty: true,
      externalChange: null,
      diskMtimeMs: 5_000,
      diskSize: 30,
    });
    // Same fingerprint again must not re-prompt.
    useDocumentStore.getState().applyExternalDiskStat("/repo/a.ts", { mtimeMs: 5_000, size: 30 });
    expect(
      useDocumentStore.getState().openItems.find((i) => i.kind === "file"),
    ).toMatchObject({ externalChange: null, content: "my edits" });
  });
});
