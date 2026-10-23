// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { CommentRecord } from "@/shared/anchor-api";
import { jumpToComment } from "./orchestrate";

const readText = vi.fn();
const textResult = (text: string) => ({ text, size: text.length, truncated: false });
function pendingRead() {
  let resolve!: (value: ReturnType<typeof textResult>) => void;
  const promise = new Promise<ReturnType<typeof textResult>>((done) => { resolve = done; });
  return { promise, resolve: (text: string) => resolve(textResult(text)) };
}
function comment(id = "comment-a", filePath = "a.ts"): CommentRecord {
  return {
    id, status: "discussing", author: "reviewer", created_at: "now", updated_at: "now", messages: [],
    target: {
      file_path: filePath, kind: "source", start_line: 100, end_line: 103,
      start_column: 1, end_column: 1, selected_text: "needle", before_context: "", after_context: "",
    },
  };
}
function file(path = "/repo/a.ts") {
  const item = useDocumentStore.getState().openItems.find((item) => item.kind === "file" && item.path === path);
  if (!item || item.kind !== "file") throw new Error(`Missing file: ${path}`);
  return item;
}

beforeEach(() => {
  localStorage.clear();
  readText.mockReset().mockResolvedValue(textResult("first\nneedle\nlast"));
  Object.assign(window, { anchor: { workspace: { readText } } });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useAnnotationsStore.setState({ ...useAnnotationsStore.getInitialState(), repoRoot: "/repo" }, true);
  useWorkspaceStore.setState({ workspaceRoot: "/repo", hostKind: "local", hostProfileId: "local-default" });
});

describe("comment navigation", () => {
  it("reads once and relocates against the content loaded into the tab", async () => {
    await jumpToComment(comment());
    expect(readText).toHaveBeenCalledTimes(1);
    expect(file()).toMatchObject({ content: "first\nneedle\nlast", revealLine: 2, focusCommentId: "comment-a" });
  });

  it("uses an existing tab's displayed content instead of resolving against a different disk snapshot", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    readText.mockResolvedValue(textResult("needle\nnew disk content"));
    await jumpToComment(comment());
    expect(readText).toHaveBeenCalledTimes(1);
    expect(file().revealLine).toBe(2);
  });

  it("bounds the fallback reveal when the annotation no longer resolves", async () => {
    readText.mockResolvedValue(textResult("short\nfile"));
    await jumpToComment(comment("missing", "a.md"));
    expect(file("/repo/a.md")).toMatchObject({ revealLine: 2, mdViewMode: "raw", focusCommentId: "missing" });
  });

  it("does not let an older file read override a later comment click", async () => {
    const first = pendingRead();
    const latest = pendingRead();
    readText.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const openingFirst = jumpToComment(comment());
    await Promise.resolve();
    const openingLatest = jumpToComment(comment("comment-b", "b.ts"));
    await Promise.resolve();
    latest.resolve("needle");
    await openingLatest;
    first.resolve("first\nneedle");
    await openingFirst;
    expect(useDocumentStore.getState().activeId).toBe("file:/repo/b.ts");
    expect(file("/repo/b.ts").revealLine).toBe(1);
    expect(file().revealLine).toBeUndefined();
  });

  it("honors the latest comment on a shared pending file read", async () => {
    const pending = pendingRead();
    readText.mockReturnValue(pending.promise);
    const first = jumpToComment(comment());
    const secondComment = comment("comment-b");
    secondComment.target.selected_text = "last";
    const latest = jumpToComment(secondComment);
    pending.resolve("needle\nlast");
    await Promise.all([first, latest]);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(file()).toMatchObject({ focusCommentId: "comment-b", revealLine: 2 });
  });

  it("does not reveal after a later tab selection, even if the user returns to the loading tab", async () => {
    const pending = pendingRead();
    readText.mockReturnValue(pending.promise);
    const opening = jumpToComment(comment());
    useDocumentStore.getState().setActive("welcome");
    useDocumentStore.getState().setActive("file:/repo/a.ts");
    pending.resolve("first\nneedle");
    await opening;
    expect(file().revealLine).toBeUndefined();
  });

  it.each([
    { workspaceRoot: "/other" },
    { hostProfileId: "other-host", hostKind: "ssh" as const },
  ])("ignores a pending jump after the workspace or host changes: %j", async (next) => {
    const pending = pendingRead();
    readText.mockReturnValue(pending.promise);
    const opening = jumpToComment(comment("comment-a", "a.md"));
    useWorkspaceStore.setState(next);
    pending.resolve("first\nneedle");
    await opening;
    expect(file("/repo/a.md")).toMatchObject({ mdViewMode: "rendered" });
    expect(file("/repo/a.md").revealLine).toBeUndefined();
  });
});
