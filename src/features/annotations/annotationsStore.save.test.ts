// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { CommentRecord, SessionRecord } from "@/shared/anchor-api";
import { useAnnotationsStore } from "./annotationsStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const comment: CommentRecord = {
  id: "comment-1", status: "discussing", author: "tester", created_at: "now", updated_at: "now",
  target: { file_path: "app.ts", kind: "source", start_line: 1, end_line: 1, start_column: 1, end_column: 4,
    selected_text: "app", before_context: "", after_context: "" },
  messages: [{ id: "message-1", author: "tester", created_at: "now", body: "saved" }],
};
const base: SessionRecord = {
  version: 1, id: "session-1", title: "Review", status: "active", created_at: "now", ended_at: null,
  author: "tester", notes: "", comments: [],
};
const input = { repoRoot: "/repo", filePath: "/repo/app.ts", kind: "source" as const,
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 4, selectedText: "app",
  beforeContext: "", afterContext: "", body: "saved" };
let load: ReturnType<typeof vi.fn>;
let addComment: ReturnType<typeof vi.fn>;
let reply: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAnnotationsStore.getState().reset();
  useWorkspaceStore.setState({ workspaceRoot: "/repo", hostKind: "local", hostProfileId: "local" });
  useAnnotationsStore.setState({ repoRoot: "/repo", sessions: [base], activeSession: base, expandedSessionId: base.id });
  load = vi.fn(async () => ({ sessions: [base] }));
  addComment = vi.fn(async () => ({ ...base, comments: [comment] }));
  reply = vi.fn();
  Object.assign(window, { anchor: { annotations: { load, addComment, reply } } });
});
afterEach(() => useAnnotationsStore.getState().reset());

describe("annotation save responses", () => {
  it("applies the saved session immediately without rereading every YAML file", async () => {
    const saved = deferred<SessionRecord>();
    addComment.mockReturnValue(saved.promise);
    const closed: SessionRecord = { ...base, id: "closed", status: "closed" };
    useAnnotationsStore.setState({ sessions: [base, closed] });
    const result = useAnnotationsStore.getState().addComment(input);
    expect(useAnnotationsStore.getState().activeSession?.comments).toEqual([]);
    expect(useAnnotationsStore.getState().toast).toBeNull();
    saved.resolve({ ...base, comments: [comment] });
    await result;
    expect(load).not.toHaveBeenCalled();
    expect(useAnnotationsStore.getState().activeSession?.comments).toEqual([comment]);
    expect(useAnnotationsStore.getState().sessions).toContain(closed);
    expect(useAnnotationsStore.getState().toast).toBe("Comment saved");
  });

  it("does not allow an older background read to erase the saved comment", async () => {
    const stale = deferred<{ sessions: SessionRecord[] }>();
    load.mockReturnValue(stale.promise);
    const refresh = useAnnotationsStore.getState().refreshFromDisk();
    await useAnnotationsStore.getState().addComment(input);
    stale.resolve({ sessions: [base] });
    expect(await refresh).toBe(false);
    expect(useAnnotationsStore.getState().activeSession?.comments).toEqual([comment]);
  });

  it("does not publish a late reply into another host using the same root path", async () => {
    const saved = deferred<SessionRecord>();
    reply.mockReturnValue(saved.promise);
    const result = useAnnotationsStore.getState().reply(comment.id, "reply");
    useWorkspaceStore.setState({ hostKind: "ssh", hostProfileId: "remote" });
    const remote: SessionRecord = { ...base, id: "remote-session" };
    useAnnotationsStore.setState({ sessions: [remote], activeSession: remote });
    saved.resolve({ ...base, comments: [comment] });
    await result;
    expect(useAnnotationsStore.getState().sessions).toEqual([remote]);
    expect(useAnnotationsStore.getState().toast).toBeNull();
  });

  it("does not invalidate a new workspace's initial load when an old save finishes", async () => {
    const saved = deferred<SessionRecord>();
    const loaded = deferred<{ sessions: SessionRecord[] }>();
    reply.mockReturnValue(saved.promise);
    load.mockReturnValue(loaded.promise);
    const result = useAnnotationsStore.getState().reply(comment.id, "reply");
    useAnnotationsStore.getState().reset();
    useWorkspaceStore.setState({ workspaceRoot: "/other" });
    const loading = useAnnotationsStore.getState().loadForRepo("/other");
    saved.resolve({ ...base, comments: [comment] });
    await result;
    const other: SessionRecord = { ...base, id: "other-session" };
    loaded.resolve({ sessions: [other] });
    await loading;
    expect(useAnnotationsStore.getState().sessions).toEqual([other]);
    expect(useAnnotationsStore.getState().loading).toBe(false);
  });

  it("loads historical sessions when ensureActive initializes a repository", async () => {
    useAnnotationsStore.getState().reset();
    Object.assign(window.anchor.annotations, { ensureActive: vi.fn(async () => base) });
    const closed: SessionRecord = { ...base, id: "closed", status: "closed" };
    load.mockResolvedValue({ sessions: [base, closed] });
    await useAnnotationsStore.getState().ensureActive("/repo");
    expect(useAnnotationsStore.getState().sessions).toEqual([base, closed]);
    expect(useAnnotationsStore.getState().activeSession?.id).toBe(base.id);
  });

  it("keeps the existing snapshot and rejects when persistence fails", async () => {
    addComment.mockRejectedValue(new Error("Disk is full"));
    await expect(useAnnotationsStore.getState().addComment(input)).rejects.toThrow("Disk is full");
    expect(useAnnotationsStore.getState().sessions).toEqual([base]);
    expect(useAnnotationsStore.getState().toast).toContain("Disk is full");
    expect(load).not.toHaveBeenCalled();
  });

  it("finishes a superseded initial load without replacing the saved session", async () => {
    const stale = deferred<{ sessions: SessionRecord[] }>();
    load.mockReturnValue(stale.promise);
    const loading = useAnnotationsStore.getState().loadForRepo("/repo");
    await useAnnotationsStore.getState().addComment(input);
    stale.resolve({ sessions: [base] });
    await loading;
    expect(useAnnotationsStore.getState().loading).toBe(false);
    expect(useAnnotationsStore.getState().activeSession?.comments).toEqual([comment]);
  });

  it("retains a save started before a same-workspace reload", async () => {
    const saved = deferred<SessionRecord>();
    const stale = deferred<{ sessions: SessionRecord[] }>();
    addComment.mockReturnValue(saved.promise);
    load.mockReturnValue(stale.promise);
    const saving = useAnnotationsStore.getState().addComment(input);
    const loading = useAnnotationsStore.getState().loadForRepo("/repo");
    saved.resolve({ ...base, comments: [comment] });
    await saving;
    stale.resolve({ sessions: [base] });
    await loading;
    expect(useAnnotationsStore.getState().activeSession?.comments).toEqual([comment]);
    expect(useAnnotationsStore.getState().loading).toBe(false);
  });
});
